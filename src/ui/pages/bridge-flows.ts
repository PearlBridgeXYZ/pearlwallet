// The signing flows of the Bridge page (Bridge.tsx), kept out of the
// component so their ordering rules are testable without a DOM:
//   wrap    the reviewed quote, deposit address and composed transaction
//           are one object, and a review whose amount input changed while
//           it was being composed is discarded;
//           The quote shown in the review is the one re-read just before
//           composing; at signing a re-read quote that prices the crossing
//           differently (fee, amount received, lane, daily cap) drops it;
//   unwrap  one run at a time per page load (claimed before the first
//           await, and surviving the card's unmount), a re-read quote that
//           differs from the reviewed one refuses before signing, and the
//           burn is signed only against a numeric total-gas ceiling the
//           user saw: after an approval the burn is estimated and shown,
//           and a second click signs it.

import type { ComposedPearlTx, FrozenPearlTx } from "../../services/pearl-tx";
import {
  EthBroadcastStatusUnknownError,
  approveWprlForBridge,
  previewUnwrapGas,
  readWprlAllowance,
  readWprlBalanceOf,
  requestBurn,
  waitForEthSuccess,
  type UnwrapGasPreview,
} from "../../services/eth-tx";
import { bridgeConfig } from "../../services/bridge";
import { fetchBurnQuote, type BurnQuote, type MintQuote } from "../../services/bridge-v1";
import type { BridgeCrossingRecord } from "../../storage/db";
import type { EthNetwork } from "../../chains/ethereum/network";
import { ethUnknownMessage, type EthUnknownState } from "../components/EthBroadcastUnknown";

// ── Wrap ────────────────────────────────────────────────────────────────

/** What the user reviews before signing a wrap: rendered and signed from
 *  this one object, never from separately updated state. */
export interface WrapReview {
  quote: MintQuote;
  deposit: string;
  frozen: FrozenPearlTx;
}

/** The review is internally consistent: the quote, the payment and the
 *  deposit address all name the same amount and destination. */
export function wrapReviewSignable(r: WrapReview | null): r is WrapReview {
  if (!r) return false;
  const c = r.frozen.composed;
  const out = c.outputs[0];
  return (
    !!out &&
    r.quote.amount === c.amountGrains &&
    out.amountGrains === c.amountGrains &&
    out.address === r.deposit &&
    c.tipGrains === 0n
  );
}

/** The fields of a bridge quote the review shows the user. */
type ReviewedQuote = Pick<BurnQuote, "fee" | "feeBps" | "net" | "withinDailyCap"> & { lane?: MintQuote["lane"] };

/** A re-read quote prices the crossing differently from the reviewed one:
 *  fee, amount received, lane or daily-cap standing changed. */
export function quoteChanged(reviewed: ReviewedQuote, fresh: ReviewedQuote): boolean {
  return (
    reviewed.fee !== fresh.fee ||
    reviewed.feeBps !== fresh.feeBps ||
    reviewed.net !== fresh.net ||
    reviewed.withinDailyCap !== fresh.withinDailyCap ||
    reviewed.lane !== fresh.lane
  );
}

export const QUOTE_CHANGED_MESSAGE =
  "The bridge's quote changed since your review (fee, amount received, lane or daily capacity). Nothing was signed — check the new numbers and review again.";

/** Re-checks the quote and deposit, composes the payment and returns the
 *  review, which shows (and is later checked against) the re-read quote;
 *  null when `stale()` turns true meanwhile (the amount changed). */
export async function prepareWrapReview(p: {
  quote: MintQuote;
  deposit: string;
  stale: () => boolean;
  recheck: (amount: bigint, deposit: string) => Promise<MintQuote>;
  compose: (deposit: string, amount: bigint) => Promise<ComposedPearlTx>;
}): Promise<WrapReview | null> {
  const { deposit } = p;
  const amount = p.quote.amount;
  const quote = await p.recheck(amount, deposit);
  if (p.stale()) return null;
  const composed = await p.compose(deposit, amount);
  if (p.stale()) return null;
  const review: WrapReview = { quote, deposit, frozen: { composed, composedAt: Date.now() } };
  if (!wrapReviewSignable(review)) throw new Error("E_COMPOSE_MISMATCH — refusing to sign; retry the quote.");
  return review;
}

// ── Unwrap ──────────────────────────────────────────────────────────────

export type UnwrapBusy = "idle" | "checking" | "approving" | "burning";

export interface UnwrapView {
  setBusy(b: UnwrapBusy): void;
  setErr(m: string | null): void;
  setNotice(m: string | null): void;
  /** A fresh gas review (after an approval, for the burn alone). */
  setGas(g: UnwrapGasPreview): void;
  setNeedsApprove(b: boolean): void;
  /** A re-read quote that differs from the reviewed one, shown instead. */
  setQuote(q: BurnQuote): void;
  onStarted(rec: BridgeCrossingRecord): Promise<void>;
  /** An approve / burn broadcast whose outcome is unknown: the page blocks
   *  another Unwrap until the user says they checked it. */
  setEthUnknown?(s: EthUnknownState): void;
}

export interface UnwrapInput {
  network: EthNetwork;
  ethAddress: `0x${string}`;
  pearlAddress: string;
  /** The user's locally parsed amount, never the API echo (audit H1). */
  amount: bigint;
  /** The quote the user reviewed (fee, amount received). */
  quote: BurnQuote;
  /** The gas the user reviewed. */
  gas: UnwrapGasPreview;
}

export const BURN_REVIEW_NOTICE =
  "Approval confirmed. The burn's Ethereum gas is shown above: check it, then click Unwrap again to sign the burn.";

export const UNWRAP_IN_FLIGHT_NOTICE = "An unwrap is already in progress — wait for it to finish (see Activity).";

// Module scope, not per card: switching tabs unmounts the card while a
// burn may still be signing, and a remounted card must not start another.
let unwrapInFlight = false;

/** One unwrap at a time per page load: a call while one runs (a double
 *  click during the pre-checks, or a click on a remounted card) does
 *  nothing but say so. The claim is taken synchronously. */
export function createUnwrapFlow(): (input: UnwrapInput, view: UnwrapView) => Promise<void> {
  return async (input, view) => {
    if (unwrapInFlight) {
      view.setNotice(UNWRAP_IN_FLIGHT_NOTICE);
      return;
    }
    unwrapInFlight = true;
    view.setBusy("checking");
    view.setErr(null);
    view.setNotice(null);
    try {
      await runUnwrap(input, view);
    } finally {
      unwrapInFlight = false;
      view.setBusy("idle");
    }
  };
}

function assertPlan(q: BurnQuote, network: EthNetwork, amount: bigint): void {
  const cfg = bridgeConfig(network);
  if (q.bridgeController.toLowerCase() !== cfg.bridgeController.toLowerCase() || q.wprl.toLowerCase() !== cfg.wprl.toLowerCase()) {
    throw new Error("E_BRIDGE_ADDRESS_MISMATCH — refusing to sign.");
  }
  if (q.amount !== amount) throw new Error("E_QUOTE_AMOUNT_MISMATCH — refusing to sign.");
}

async function runUnwrap({ network, ethAddress, pearlAddress, amount, quote, gas }: UnwrapInput, view: UnwrapView): Promise<void> {
  // Set only once the approve is mined successfully.
  let approveTxHash: `0x${string}` | null = null;
  let step = "approval";
  try {
    // Confirm-time re-quote: bind amount, re-check paused + pinned
    // addresses, RE-READ allowance + balance just before signing
    // (audit H1/M2/N2/C1/C6).
    const [q2, allowance, balance] = await Promise.all([
      fetchBurnQuote(amount, pearlAddress),
      readWprlAllowance(network, ethAddress),
      readWprlBalanceOf(network, ethAddress),
    ]);
    assertPlan(q2, network, amount);
    if (q2.paused) throw new Error("The bridge just paused — try again once it resumes.");
    if (quoteChanged(quote, q2)) {
      view.setQuote(q2);
      throw new Error(QUOTE_CHANGED_MESSAGE);
    }
    // Burning more WPRL than held reverts AFTER an approve's gas is spent
    // (audit C1); over the daily cap the contract reverts too (audit C6).
    if (balance < amount) throw new Error("You don't have that much WPRL.");
    if (!q2.withinDailyCap) throw new Error("Amount exceeds today's remaining burn capacity — try a smaller amount.");
    if (allowance < amount) {
      // The reviewed gas covered no approval: review again.
      const approveWei = gas.approveWei;
      if (approveWei === null) {
        throw new Error("Your WPRL approval changed since the review — enter the amount again to review the gas.");
      }
      view.setBusy("approving");
      // Exact-amount approval (not infinite): the allowance dies with this
      // burn, so a future contract compromise can't drain pre-approved WPRL.
      const a = await approveWprlForBridge({
        network,
        from: ethAddress,
        amount,
        tier: "normal",
        ceiling: { maxFeePerGas: gas.maxFeePerGas, maxCostWei: approveWei },
      });
      // Wait for the approve to MINE: the burn's gas estimate reverts
      // against pre-approve state (audit C1).
      let mined: boolean;
      try {
        mined = await waitForEthSuccess(network, a.txHash);
      } catch (e) {
        // Timed out or unreadable: the approve may still confirm. A retry
        // now would sign a second approve.
        throw new Error(
          `Approve tx ${a.txHash} was sent but its confirmation wasn't seen (${(e as Error).message}). Nothing was burned. Check it on Etherscan and wait for it to confirm before trying again.`,
        );
      }
      if (!mined) throw new Error(`Approve tx ${a.txHash} reverted — nothing burned. Try again.`);
      approveTxHash = a.txHash;
    }
    const burnWei = gas.burnWei;
    if (burnWei === null) {
      // The burn's total gas wasn't reviewed (it can't be estimated before
      // the approval confirms): estimate it now, show it, and stop. The
      // next click signs it against that ceiling.
      view.setBusy("checking");
      const fresh = await previewUnwrapGas({ network, from: ethAddress, amount, pearlAddress, needsApprove: false, tier: "normal" });
      view.setGas(fresh);
      view.setNeedsApprove(false);
      view.setNotice(BURN_REVIEW_NOTICE);
      return;
    }
    view.setBusy("burning");
    step = "burn";
    const r = await requestBurn({
      network,
      from: ethAddress,
      amount,
      pearlAddress,
      tier: "normal",
      ceiling: { maxFeePerGas: gas.maxFeePerGas, maxCostWei: burnWei },
    });
    const now = Date.now();
    try {
      await view.onStarted({
        id: r.txHash,
        direction: "unwrap",
        amountGrains: amount.toString(),
        netGrains: q2.net.toString(),
        createdAt: now,
        phase: "relay",
        relayState: null,
        confirmations: 0,
        settledRef: null,
        approveTxHash,
        updatedAt: now,
      });
    } catch {
      // Burn is on-chain; only the local record failed (audit H2/M3).
      view.setErr(`Burn submitted, but failed to save tracking. SAVE THIS burn tx: ${r.txHash}`);
    }
  } catch (e) {
    if (e instanceof EthBroadcastStatusUnknownError) {
      // The approve / burn may already be on the network: never a plain
      // failure, and no retry until the user has checked the hash.
      view.setNotice(null);
      view.setEthUnknown?.({ hash: e.hash, what: step, acknowledged: false });
      view.setErr(ethUnknownMessage(network, e.hash, step));
      return;
    }
    const raw = (e as Error).message;
    const msg =
      raw === "E_ETH_GAS_ABOVE_REVIEW"
        ? "Ethereum gas rose above what you reviewed — nothing was signed for this step. Enter the amount again to review the new gas."
        : raw;
    // Nothing this run noted still holds (incl. an "already in progress"
    // notice a second click left meanwhile).
    view.setNotice(null);
    // approveTxHash is set only after the approve's successful receipt, so
    // a retry re-reads the allowance and skips the approve.
    view.setErr(
      approveTxHash ? `Approve confirmed (${approveTxHash}) but the burn didn't go out: ${msg}. Re-try Unwrap — it will skip the approve.` : msg,
    );
  }
}
