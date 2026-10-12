import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import AsciiPulse from "../components/AsciiPulse";
import { refusalMessage } from "../components/PendingBroadcasts";
import EthBroadcastUnknown, { ethUnknownBlocksSend, useEthUnknown } from "../components/EthBroadcastUnknown";
import { captureSigningSession, sessionWalletPrimary, useWallet } from "../../state/wallet-store";
import { dustErrorMessage } from "../pearl-messages";
import { db, putBridgeCrossingForWallet, putDepositPinForWallet, type BridgeCrossingRecord } from "../../storage/db";
import { bridgeConfig } from "../../services/bridge";
import {
  getEthReceiptStatus,
  previewUnwrapGas,
  readWprlAllowance,
  readWprlBalanceOf,
} from "../../services/eth-tx";
import { broadcastPearlPrecomposed, composePearlSend, PEARL_PREVIEW_FRESHNESS_MS } from "../../services/pearl-tx";
import {
  BURN_REVIEW_NOTICE,
  createUnwrapFlow,
  prepareWrapReview,
  QUOTE_CHANGED_MESSAGE,
  quoteChanged,
  wrapReviewSignable,
  type UnwrapBusy,
  type WrapReview,
} from "./bridge-flows";
import { ethTxExplorerUrl } from "../../chains/ethereum/network";
import { formatWei } from "../../lib/format";
import type { UnwrapGasPreview } from "../../services/eth-tx";
import {
  MINT_IN_FLIGHT,
  classifyBurn,
  classifyMint,
  fetchBridgeStatus,
  fetchBurnQuote,
  fetchBurnStatus,
  fetchMintQuote,
  fetchMintStatus,
  fetchPearlTxStatus,
  fetchRecentDeposit,
  grainsToPrlString,
  prlToGrains,
  resolveDepositAddress,
  type BridgeStatus,
  type BurnQuote,
  type DepositTofuStore,
  type MintQuote,
} from "../../services/bridge-v1";

// TOFU store for the wrap deposit address (audit H-2/N3), backed by a
// DEDICATED table keyed on the eth address — idempotent put(), never
// pollutes the user-facing address book. A pin is bound to the session's
// wallet: refused (E_WALLET_WIPED / E_WALLET_CHANGED) if another tab wiped
// or replaced it meanwhile, so it never lands under the next wallet.
export const depositTofu: DepositTofuStore = {
  async get(key) {
    return (await db.bridgeDepositPins.get(key))?.pearlAddress ?? null;
  },
  async set(key, value) {
    const walletPrimary = sessionWalletPrimary();
    if (!walletPrimary) throw new Error("E_LOCKED");
    await putDepositPinForWallet({ ethAddress: key, pearlAddress: value, pinnedAt: Date.now() }, walletPrimary);
  },
};

/**
 * Stores a bridge crossing for the session's wallet, like the deposit pin:
 * the keystore check and the put share one read-write transaction, so a
 * crossing saved by a tab still unlocked on a wallet another tab wiped or
 * replaced is refused (E_WALLET_WIPED / E_WALLET_CHANGED) instead of
 * landing under the next wallet. `ifAbsent` (the adoption of a
 * relay-indexed deposit): writes only if no row with that id exists;
 * returns whether it wrote.
 */
export async function saveBridgeCrossing(rec: BridgeCrossingRecord, opts: { ifAbsent?: boolean } = {}): Promise<boolean> {
  const walletPrimary = sessionWalletPrimary();
  if (!walletPrimary) throw new Error("E_LOCKED");
  return putBridgeCrossingForWallet(rec, walletPrimary, opts);
}

// Native PRL ↔ WPRL bridging (v0.4.0). The public /v1 API supplies quotes
// and lifecycle state; ALL signing happens locally:
//   wrap   = native Pearl send to the relay-derived deposit address
//   unwrap = approve (when allowance short) + requestBurn, signed in-wallet
//
// Trust rules (audited — see AUDIT-v0.4.0-*.md):
//   - UNWRAP is fully API-substitution-proof: burn calldata only ever
//     targets the contract addresses PINNED in network.ts, the quote's
//     plan is cross-checked against them, and the payout Pearl address is
//     the wallet's own. The amount signed is the user's locally-parsed
//     value, asserted equal to the quote (never the API echo).
//   - WRAP destination is the relay-DERIVED deposit address, which the
//     wallet cannot derive independently. Defenses: trust-on-first-use
//     pinning (refuse if it ever changes), the address is shown for visual
//     verification against pearlbridge.xyz, and the sent amount is the
//     user's input. Residual risk = a compromise active on the very first
//     wrap; the real fix (relay-published xpub for local derivation) is
//     tracked as a follow-up.

type Tab = "wrap" | "unwrap" | "activity";

const POLL_MS = 15_000;
// C3: hard ceiling on locally-tracked open crossings — bounds a hostile-API
// phantom-crossing flood through the recovery tick.
const MAX_OPEN_CROSSINGS = 25;

function fmtPrl(g: bigint): string {
  return `${grainsToPrlString(g)} PRL`;
}

export default function Bridge() {
  const navigate = useNavigate();
  const addresses = useWallet((s) => s.addresses);
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const ethNetwork = useWallet((s) => s.ethNetwork);
  const pool = useWallet((s) =>
    s.addresses?.pearlPool ?? (s.addresses ? [s.addresses.pearl] : []),
  );

  const [tab, setTab] = useState<Tab>("wrap");
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [crossings, setCrossings] = useState<BridgeCrossingRecord[]>([]);

  // ── bridge status (paused banner, fees, windows) ──────────────────────
  useEffect(() => {
    let gone = false;
    fetchBridgeStatus()
      .then((s) => !gone && setStatus(s))
      .catch((e) => !gone && setStatusErr((e as Error).message));
    return () => {
      gone = true;
    };
  }, []);

  // ── crossing records + lifecycle poller ───────────────────────────────
  const reloadCrossings = useCallback(async () => {
    const rows = await db.bridgeCrossings.orderBy("createdAt").reverse().toArray();
    setCrossings(rows);
  }, []);

  useEffect(() => {
    void reloadCrossings();
  }, [reloadCrossings]);

  const ethAddr = addresses?.eth as `0x${string}` | undefined;
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      // Recovery (audit H2): adopt any relay-indexed deposit for our eth
      // address that we have no local record of — covers a wrap whose send
      // broadcast but whose tracking row was lost.
      if (ethAddr) {
        try {
          // C3: cap adoption. A hostile API returning a fresh random txid
          // each tick would otherwise inject unbounded phantom crossings.
          // fetchRecentDeposit already rejects non-64-hex txids; this bounds
          // the row count even against a same-shape flood.
          const openNow = await db.bridgeCrossings.where("phase").anyOf("confirming", "relay", "review").count();
          const recent = openNow < MAX_OPEN_CROSSINGS ? await fetchRecentDeposit(ethAddr) : null;
          // Only adopt genuinely in-flight deposits (audit N1): never
          // resurrect a failed/cancelled/under_review/refunded mint as a
          // fresh "confirming" zombie.
          // Wallet-bound, and only if no row for it exists (checked in the
          // same transaction as the write).
          if (recent && MINT_IN_FLIGHT.has(recent.state)) {
            const now = Date.now();
            await saveBridgeCrossing({
              id: recent.txid,
              direction: "wrap",
              amountGrains: recent.amountGrains.toString(),
              // C3: net is unknown for a recovered deposit (no fee context);
              // leave it equal to gross rather than overstating a net.
              netGrains: recent.amountGrains.toString(),
              createdAt: recent.createdAt ?? now,
              phase: "confirming",
              relayState: recent.state,
              confirmations: 0,
              settledRef: null,
              approveTxHash: null,
              updatedAt: now,
            }, { ifAbsent: true });
          }
        } catch {
          // best-effort; recovery retries next tick
        }
      }
      try {
        await reopenLegacyDroppedBurns();
      } catch {
        // best-effort; retried next tick
      }
      const open = await db.bridgeCrossings
        .where("phase")
        .anyOf("confirming", "relay", "review")
        .toArray();
      for (const c of open) {
        if (stop) return;
        try {
          if (c.direction === "wrap") {
            await pollWrap(c, status?.pearlMinConfirmations ?? 6);
          } else {
            await pollUnwrap(c, ethNetwork);
          }
        } catch {
          // transient API failure — next tick retries; relay state is canonical
        }
      }
      if (!stop) await reloadCrossings();
    };
    const t = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [status, reloadCrossings, ethAddr]);

  const openCount = useMemo(
    () => crossings.filter((c) => c.phase === "confirming" || c.phase === "relay" || c.phase === "review").length,
    [crossings],
  );

  return (
    <Page title="Bridge">
      {status?.paused ? (
        <div className="card mb-4 border border-warn-line bg-warn-bg text-sm leading-relaxed">
          The bridge is currently <span className="font-semibold">paused</span>. Quotes are
          shown but new crossings are disabled until it resumes.
        </div>
      ) : null}
      {statusErr ? (
        <div className="card mb-4 border border-warn-line text-sm leading-relaxed">
          Could not reach the bridge API ({statusErr}). Balances and sends still work;
          bridging needs the API.
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-1 rounded-pb bg-surface-2 p-1 sm:grid-cols-3">
        {(["wrap", "unwrap", "activity"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={t === tab ? "btn-primary flex-1" : "btn-secondary flex-1"}
          >
            {t === "wrap" ? "Wrap PRL → WPRL" : t === "unwrap" ? "Unwrap WPRL → PRL" : `Activity${openCount ? ` (${openCount})` : ""}`}
          </button>
        ))}
      </div>

      {tab === "wrap" && (
        <WrapCard
          status={status}
          ethAddress={addresses?.eth as `0x${string}` | undefined}
          pool={pool}
          pearlNetwork={pearlNetwork}
          onStarted={async (rec) => {
            await saveBridgeCrossing(rec);
            await reloadCrossings();
            setTab("activity");
          }}
        />
      )}
      {tab === "unwrap" && (
        <UnwrapCard
          status={status}
          ethAddress={addresses?.eth as `0x${string}` | undefined}
          pearlAddress={addresses?.pearl}
          ethNetwork={ethNetwork}
          onStarted={async (rec) => {
            await saveBridgeCrossing(rec);
            await reloadCrossings();
            setTab("activity");
          }}
        />
      )}
      {tab === "activity" && (
        <ActivityCard crossings={crossings} requiredConfs={status?.pearlMinConfirmations ?? 6} ethNetwork={ethNetwork} />
      )}

      <button onClick={() => navigate("/dashboard")} className="btn-secondary mt-4 w-full min-w-11">
        Back to dashboard
      </button>
    </Page>
  );
}

// ── lifecycle pollers (module-level so tests can drive them) ────────────

export async function pollWrap(c: BridgeCrossingRecord, requiredConfs: number): Promise<void> {
  if (c.phase === "confirming") {
    const tx = await fetchPearlTxStatus(c.id);
    const confirmations = tx.found ? tx.confirmations : 0;
    const phase = confirmations >= requiredConfs ? "relay" : "confirming";
    await db.bridgeCrossings.update(c.id, {
      confirmations,
      phase,
      updatedAt: Date.now(),
    });
    if (phase === "confirming") return;
  }
  const m = await fetchMintStatus(c.id);
  const outcome = classifyMint(m.state, m.refunded);
  const patch: Partial<BridgeCrossingRecord> = {
    relayState: m.anomalyReason
      ? `${m.state}: ${m.anomalyReason}`
      : m.cancelReason
      ? `${m.state}: ${m.cancelReason}`
      : m.state,
    updatedAt: Date.now(),
  };
  if (outcome === "ok") {
    patch.phase = "done";
    patch.settledRef = m.mintTxHash;
  } else if (outcome === "refunded") {
    patch.phase = "refunded";
    patch.settledRef = m.refundPrlTxId;
  } else if (outcome === "fail") {
    patch.phase = "failed";
  } else if (outcome === "review") {
    patch.phase = "review";
  }
  // outcome "pending" leaves phase as-is (confirming→relay handled above)
  await db.bridgeCrossings.update(c.id, patch);
}

/** After this long without a relay record, an unwrap whose burn receipt
 *  is missing or unreadable shows a "check the burn tx" notice. */
export const BURN_CHECK_AFTER_MS = 30 * 60_000;
export const BURN_NOT_MINED_NOTICE =
  "The burn tx has not confirmed after 30 minutes. It can still confirm, so do not unwrap again: check the burn tx on Etherscan. This updates automatically.";
export const BURN_STATUS_UNREADABLE_NOTICE =
  "The burn tx's status could not be read from Ethereum. It may already be confirmed or still pending, so do not unwrap again: check the burn tx on Etherscan. This updates automatically.";
export function isBurnCheckNotice(s: string | null | undefined): boolean {
  return s === BURN_NOT_MINED_NOTICE || s === BURN_STATUS_UNREADABLE_NOTICE;
}

/** v0.4.3–v0.6.1 marked an unwrap "failed" after 30 minutes without a
 *  receipt and told the user their WPRL was untouched and to retry, with
 *  no evidence the burn could no longer execute. Such rows stopped being
 *  polled. Reopen them into the check state so polling settles them on
 *  real evidence (a reverted receipt still ends "failed"). */
export const LEGACY_DROPPED_BURN_PREFIX = "burn tx not mined (~30m)";
export function isLegacyDroppedBurn(c: BridgeCrossingRecord): boolean {
  return c.direction === "unwrap" && c.phase === "failed" &&
    typeof c.relayState === "string" && c.relayState.startsWith(LEGACY_DROPPED_BURN_PREFIX);
}
export async function reopenLegacyDroppedBurns(): Promise<number> {
  const failed = await db.bridgeCrossings.where("phase").equals("failed").toArray();
  let n = 0;
  for (const c of failed) {
    if (!isLegacyDroppedBurn(c)) continue;
    await saveBridgeCrossing({ ...c, phase: "relay", relayState: BURN_NOT_MINED_NOTICE, updatedAt: Date.now() });
    n++;
  }
  return n;
}

export async function pollUnwrap(
  c: BridgeCrossingRecord,
  ethNetwork: "mainnet" | "sepolia" = "mainnet",
): Promise<void> {
  const b = await fetchBurnStatus(c.id as `0x${string}`);
  const outcome = classifyBurn(b.state);
  const patch: Partial<BridgeCrossingRecord> = { updatedAt: Date.now() };
  // C4: only overwrite relayState when the relay actually returned one;
  // a null (not-yet-indexed) must not blank a previously-meaningful string.
  if (b.state) {
    patch.relayState = b.anomalyReason ? `${b.state}: ${b.anomalyReason}` : b.state;
  }
  if (outcome === "ok") {
    patch.phase = "done";
    patch.settledRef = b.pearlTxId;
  } else if (outcome === "fail") {
    patch.phase = "failed";
  } else if (outcome === "review") {
    patch.phase = "review";
  } else if (b.state) {
    patch.phase = "relay";
  } else {
    // C5: relay hasn't indexed the burn. Cross-check our OWN ETH receipt —
    // a reverted burn (over-cap / window race) or a dropped tx would
    // otherwise hang in "bridging" forever while the WPRL never left.
    const receipt = await getEthReceiptStatus(ethNetwork, c.id as `0x${string}`);
    if (receipt === "reverted") {
      // The only terminal verdict: the receipt says it failed.
      patch.phase = "failed";
      patch.relayState = "burn tx reverted on-chain — WPRL not spent";
    } else if (receipt === "success") {
      // Mined; the relay not having indexed it yet is normal lag. A check
      // notice shown earlier no longer applies.
      if (isBurnCheckNotice(c.relayState)) patch.relayState = null;
    } else if (Date.now() - c.createdAt > BURN_CHECK_AFTER_MS) {
      // No receipt yet ("not-found") or none readable ("lookup-failed"):
      // NOT evidence of failure. The burn can still confirm (or already
      // has), so the crossing stays open and keeps being polled; the card
      // shows the burn tx to check and never suggests another unwrap.
      patch.relayState = receipt === "not-found" ? BURN_NOT_MINED_NOTICE : BURN_STATUS_UNREADABLE_NOTICE;
    }
  }
  await db.bridgeCrossings.update(c.id, patch);
}

// ── Wrap ────────────────────────────────────────────────────────────────

function WrapCard(props: {
  status: BridgeStatus | null;
  ethAddress: `0x${string}` | undefined;
  pool: string[];
  pearlNetwork: ReturnType<typeof useWallet.getState>["pearlNetwork"];
  onStarted: (rec: BridgeCrossingRecord) => Promise<void>;
}) {
  const { status, ethAddress, pool, pearlNetwork, onStarted } = props;
  // Spend from both single-sig branches (change lives on branch 1).
  const changePool = useWallet((s) => s.addresses?.pearlChange);
  const deriveMore = useWallet((s) => s.derivePearlAddresses);
  const [amount, setAmount] = useState("");
  // The user's locally-parsed amount — the ONLY trusted source of how much
  // PRL to send. The API quote is advisory (fees/lane); we never send its
  // echoed amount (audit C1).
  const [grains, setGrains] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<MintQuote | null>(null);
  const [depositAddr, setDepositAddr] = useState<string | null>(null);
  // What the user reviewed — quote, deposit address and the composed
  // transaction (network fee included) as one object; only this exact
  // transaction is signed, and the review shows only this.
  const [review, setReview] = useState<WrapReview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Claimed before the first await: a double click can't start a step twice.
  const inFlight = useRef(false);
  const quoteSeq = useRef(0);

  // Debounced quote + deposit address preview. Every change of the input
  // bumps quoteSeq, which also discards a review still being composed.
  useEffect(() => {
    const seq = ++quoteSeq.current;
    setQuote(null);
    setGrains(null);
    setReview(null);
    setErr(null);
    if (!amount || !ethAddress) return;
    let g: bigint;
    try {
      g = prlToGrains(amount);
      if (g <= 0n) return;
    } catch {
      setErr("Enter a PRL amount (up to 8 decimals).");
      return;
    }
    setGrains(g);
    const t = setTimeout(async () => {
      try {
        const [q, dep] = await Promise.all([
          fetchMintQuote(g),
          resolveDepositAddress(ethAddress, depositTofu),
        ]);
        if (quoteSeq.current !== seq) return;
        // Bind the quote to what we asked for. A quote whose amount drifts
        // from the user's input is a hostile/buggy API — surface it, don't
        // silently price a different amount (audit C1).
        if (q.amount !== g) {
          setErr("Quote amount didn’t match your input — try again.");
          return;
        }
        setQuote(q);
        setDepositAddr(dep.address);
      } catch (e) {
        if (quoteSeq.current === seq) setErr((e as Error).message);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [amount, ethAddress]);

  // Confirm-time re-checks (audit C1/H2/M2): re-resolve the deposit
  // address through TOFU (refuses if it ever changed) AND re-read the quote
  // to catch a bridge that paused or now disagrees on amount. Run before
  // the fee is shown and again right before signing.
  const recheck = async (sendGrains: bigint, expectedDeposit: string) => {
    const [dep, q2] = await Promise.all([
      resolveDepositAddress(ethAddress!, depositTofu),
      fetchMintQuote(sendGrains),
    ]);
    if (dep.address !== expectedDeposit) {
      throw new Error("E_DEPOSIT_ADDRESS_CHANGED — refusing to send; retry the quote.");
    }
    if (q2.amount !== sendGrains) {
      throw new Error("E_QUOTE_AMOUNT_MISMATCH — refusing to send; retry the quote.");
    }
    if (q2.paused) {
      throw new Error("The bridge just paused — try again once it resumes.");
    }
    return q2;
  };

  // Step 1: compose the transaction and show its network fee. Nothing is
  // signed here. A review composed for an amount the user has since
  // changed is discarded (quoteSeq).
  const prepare = async () => {
    if (!quote || !depositAddr || !ethAddress || grains === null || quote.amount !== grains || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    const seq = quoteSeq.current;
    const stale = () => quoteSeq.current !== seq;
    try {
      const r = await prepareWrapReview({
        quote,
        deposit: depositAddr,
        stale,
        recheck,
        compose: (destination, amountGrains) =>
          composePearlSend({
            network: pearlNetwork,
            pool,
            changePool,
            deriveMore,
            // Bound to the address generation when this walk starts.
            onDiscovered: useWallet.getState().pearlDiscoveryHandler(),
            destination,
            amountGrains, // user's amount, never the API echo
            includeTip: false,
          }),
      });
      if (r && !stale()) setReview(r);
    } catch (e) {
      if (!stale()) setErr(refusalMessage(e) ?? dustErrorMessage(e) ?? (e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // Step 2: sign and broadcast exactly the reviewed transaction.
  const wrap = async () => {
    if (!wrapReviewSignable(review) || !ethAddress || inFlight.current) return;
    inFlight.current = true;
    // The session this click confirmed in (checked again before signing).
    const session = captureSigningSession();
    setBusy(true);
    setErr(null);
    const { frozen, deposit } = review;
    const sendGrains = frozen.composed.amountGrains;
    try {
      const q2 = await recheck(sendGrains, deposit);
      // The review showed this quote's fee, amount received and lane: a
      // re-read that differs drops the review and shows the new numbers.
      if (quoteChanged(review.quote, q2)) {
        setReview(null);
        setQuote(q2);
        setErr(QUOTE_CHANGED_MESSAGE);
        return;
      }
      const res = await broadcastPearlPrecomposed(frozen, pearlNetwork, Date.now(), [], session);
      setReview(null);
      const now = Date.now();
      try {
        await onStarted({
          id: res.txid,
          direction: "wrap",
          amountGrains: sendGrains.toString(),
          netGrains: q2.net.toString(),
          createdAt: now,
          phase: "confirming",
          relayState: null,
          confirmations: 0,
          settledRef: null,
          approveTxHash: null,
          updatedAt: now,
        });
      } catch {
        // Funds ARE committed on-chain; only the local record failed. Make
        // the loud version of the error so the user can save the txid
        // (audit H2/M3) — recovery also re-adopts it via /deposits/recent.
        setErr(
          `Sent, but failed to save tracking. SAVE THIS Pearl txid: ${res.txid}`,
        );
        return;
      }
    } catch (e) {
      // Any failure (including a status-unknown broadcast) drops the
      // reviewed transaction: it is never offered for a second click.
      setReview(null);
      const msg = (e as Error).message;
      setErr(
        msg === "E_PREVIEW_STALE"
          ? "The review expired. Review the network fee again before signing."
          : (refusalMessage(e) ?? msg),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // A review shows only what it froze; before one, the live quote.
  const shown = review?.quote ?? quote;
  const shownDeposit = review?.deposit ?? depositAddr;

  return (
    <div className="card flex flex-col gap-5 shadow-slabsm sm:shadow-slab">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Wrap PRL into WPRL</h2>
        <p className="mt-1 text-sm text-text-2 leading-relaxed break-words">
          Sends PRL from this wallet to your personal bridge deposit address. WPRL mints
          to <span className="font-mono text-xs break-all min-w-0 tabular-nums leading-relaxed">{ethAddress ?? "—"}</span> after{" "}
          {status?.pearlMinConfirmations ?? 6} confirmations.
        </p>
      </div>

      <label className="block">
        <span className="label">Amount (PRL)</span>
        <input
          className="input w-full font-mono tabular-nums placeholder:font-sans"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          // Fixed while a review is composed or shown: what is reviewed
          // is what gets signed. "Change amount" reopens it.
          disabled={busy || review !== null}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      {shown && (
        <div className="rounded-pb border border-line-strong bg-surface-2 p-4 text-sm leading-relaxed">
          <h3 className="mb-3 text-base font-semibold tracking-tight">Review before you sign</h3>
          <Row k="Bridge fee" v={`${fmtPrl(shown.fee)} (${shown.feeBps} bps)`} />
          <Row k="You receive" v={`${grainsToPrlString(shown.net)} WPRL`} />
          <Row
            k="Lane"
            v={
              shown.lane === "fast"
                ? "fast — mints right after confirmation"
                : `slow — queued ~${Math.round(shown.slowLaneDelaySeconds / 3600)}h (fast window is full)`
            }
          />
          {review ? (
            <>
              <Row k="Pearl network fee" v={fmtPrl(review.frozen.composed.feeGrains)} />
              <Row
                k="Leaves this wallet"
                v={fmtPrl(review.frozen.composed.amountGrains + review.frozen.composed.feeGrains)}
              />
              <p className="mt-3 text-xs leading-relaxed text-text-3 break-words">
                This exact transaction is signed when you confirm; the review expires after{" "}
                {Math.round(PEARL_PREVIEW_FRESHNESS_MS / 60_000)} minutes.
              </p>
            </>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-text-3 break-words">
              Plus the Pearl network fee, shown in the next step before anything is signed.
            </p>
          )}
          {!shown.withinDailyCap && (
            <p className="mt-2 text-warn break-words">
              Amount exceeds today’s remaining bridge capacity — it will queue.
            </p>
          )}
        </div>
      )}

      {shownDeposit && (
        <div className="rounded-pb border border-line p-3 text-xs leading-relaxed">
          <div className="mb-1 text-text-3">PRL will be sent to your bridge deposit address:</div>
          <div className="break-all font-mono min-w-0 tabular-nums">{shownDeposit}</div>
          <div className="mt-1 text-text-3">
            Verify this matches the address shown for your wallet on pearlbridge.xyz before sending.
          </div>
        </div>
      )}

      {err && <p className="text-sm text-danger leading-relaxed break-words">{err}</p>}

      {review ? (
        <>
          <button
            onClick={() => void wrap()}
            disabled={!wrapReviewSignable(review) || busy || status?.paused === true}
            className="btn-primary min-w-11"
          >
            {busy ? "Sending…" : `Sign and wrap ${grainsToPrlString(review.frozen.composed.amountGrains)} PRL`}
          </button>
          <button type="button" onClick={() => setReview(null)} disabled={busy} className="btn-secondary min-h-11 self-start">
            Change amount
          </button>
        </>
      ) : (
        <button
          onClick={() => void prepare()}
          disabled={!quote || !depositAddr || busy || status?.paused === true}
          className="btn-primary min-w-11"
        >
          {busy ? "Preparing…" : quote ? `Review network fee for ${grainsToPrlString(quote.amount)} PRL` : "Wrap"}
        </button>
      )}
    </div>
  );
}

// ── Unwrap ──────────────────────────────────────────────────────────────

function UnwrapCard(props: {
  status: BridgeStatus | null;
  ethAddress: `0x${string}` | undefined;
  pearlAddress: string | undefined;
  ethNetwork: ReturnType<typeof useWallet.getState>["ethNetwork"];
  onStarted: (rec: BridgeCrossingRecord) => Promise<void>;
}) {
  const { status, ethAddress, pearlAddress, ethNetwork, onStarted } = props;
  const [amount, setAmount] = useState("");
  const [grains, setGrains] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<BurnQuote | null>(null);
  const [needsApprove, setNeedsApprove] = useState<boolean | null>(null);
  // ETH gas ceilings shown before signing; the signing calls refuse
  // anything above them (E_ETH_GAS_ABOVE_REVIEW).
  const [gas, setGas] = useState<UnwrapGasPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<UnwrapBusy>("idle");
  // An approve / burn whose broadcast outcome is unknown blocks Unwrap
  // until the user says they checked it (it may already be live). Stored
  // outside the card (state/eth-unknown) so it survives remounts and a
  // result arriving after the card unmounted is still recorded.
  const [ethUnknown, setEthUnknown] = useEthUnknown(ethNetwork, ethAddress);
  const quoteSeq = useRef(0);
  // One unwrap at a time per page load, claimed before its first await
  // (bridge-flows.ts); a run survives this card unmounting.
  const unwrapFlow = useMemo(() => createUnwrapFlow(), []);

  useEffect(() => {
    setQuote(null);
    setGrains(null);
    setNeedsApprove(null);
    setGas(null);
    setErr(null);
    setNotice(null);
    if (!amount || !ethAddress || !pearlAddress) return;
    let g: bigint;
    try {
      g = prlToGrains(amount);
      if (g <= 0n) return;
    } catch {
      setErr("Enter a WPRL amount (up to 8 decimals).");
      return;
    }
    setGrains(g);
    const seq = ++quoteSeq.current;
    const t = setTimeout(async () => {
      try {
        const [q, allowance, balance] = await Promise.all([
          fetchBurnQuote(g, pearlAddress),
          readWprlAllowance(ethNetwork, ethAddress),
          readWprlBalanceOf(ethNetwork, ethAddress),
        ]);
        if (quoteSeq.current !== seq) return;
        // Pinned-address cross-check: refuse if the API's transaction plan
        // disagrees with the wallet's compiled-in contract addresses.
        const cfg = bridgeConfig(ethNetwork);
        if (
          q.bridgeController.toLowerCase() !== cfg.bridgeController.toLowerCase() ||
          q.wprl.toLowerCase() !== cfg.wprl.toLowerCase()
        ) {
          throw new Error("E_BRIDGE_ADDRESS_MISMATCH — API plan disagrees with wallet constants; refusing.");
        }
        // Bind amount to the user's input (audit H1).
        if (q.amount !== g) {
          throw new Error("Quote amount didn’t match your input — try again.");
        }
        if (q.addressValid === false) {
          throw new Error("Bridge rejected this wallet’s Pearl address — update the app.");
        }
        // A burn of more than is held reverts, so its gas can't be
        // estimated: say what is actually wrong.
        if (balance < g) throw new Error("You don't have that much WPRL.");
        const g2 = await previewUnwrapGas({
          network: ethNetwork,
          from: ethAddress,
          amount: g,
          pearlAddress,
          needsApprove: allowance < g,
          tier: "normal",
        }).catch((e: unknown) => {
          throw new Error(`Couldn't estimate Ethereum gas: ${(e as Error).message}`);
        });
        if (quoteSeq.current !== seq) return;
        setQuote(q);
        setNeedsApprove(allowance < g);
        setGas(g2);
      } catch (e) {
        if (quoteSeq.current === seq) setErr((e as Error).message);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [amount, ethAddress, pearlAddress, ethNetwork]);

  const unwrap = () => {
    if (!quote || !gas || !ethAddress || !pearlAddress || grains === null) return;
    if (ethUnknownBlocksSend(ethUnknown)) return;
    void unwrapFlow(
      { network: ethNetwork, ethAddress, pearlAddress, amount: grains, quote, gas },
      { setEthUnknown, setBusy, setErr, setNotice, setGas, setNeedsApprove, setQuote, onStarted },
    );
  };

  return (
    <div className="card flex flex-col gap-5 shadow-slabsm sm:shadow-slab">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Unwrap WPRL back to PRL</h2>
        <p className="mt-1 text-sm text-text-2 leading-relaxed break-words">
          Burns WPRL from <span className="font-mono text-xs break-all min-w-0 tabular-nums leading-relaxed">{ethAddress ?? "—"}</span>;
          the bridge pays native PRL to this wallet’s Pearl address. Needs a little ETH
          for gas{needsApprove ? " (two transactions: approve, then burn)" : ""}.
        </p>
      </div>

      <label className="block">
        <span className="label">Amount (WPRL)</span>
        <input
          className="input w-full font-mono tabular-nums placeholder:font-sans"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          disabled={busy !== "idle"}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      {quote && (
        <div className="rounded-pb border border-line-strong bg-surface-2 p-4 text-sm leading-relaxed">
          <h3 className="mb-3 text-base font-semibold tracking-tight">Review before you sign</h3>
          <Row k="Bridge fee" v={`${fmtPrl(quote.fee)} (${quote.feeBps} bps)`} />
          <Row k="You receive" v={fmtPrl(quote.net)} />
          <Row k="Payout to" v={pearlAddress ?? "—"} />
          {needsApprove && <Row k="Step 1" v="approve WPRL (exact amount)" />}
          <Row k={needsApprove ? "Step 2" : "Transaction"} v="requestBurn on PearlBridge" />
          {gas && (
            <>
              {gas.approveWei !== null && <Row k="Approve gas (max)" v={`${formatWei(gas.approveWei)} ETH`} />}
              <Row
                k="Burn gas (max)"
                v={
                  gas.burnWei !== null
                    ? `${formatWei(gas.burnWei)} ETH`
                    : `${formatWei(gas.maxFeePerGas, 9)} gwei per gas unit`
                }
              />
              <p className="mt-3 text-xs leading-relaxed text-text-3 break-words">
                Ethereum gas is paid in ETH.{" "}
                {gas.burnWei === null
                  ? "The burn's gas can only be estimated once the approval confirms. Unwrap sends the approval first, then shows the burn's maximum gas; a second click signs the burn. "
                  : ""}
                A step whose gas would exceed what is shown is refused before signing.
              </p>
            </>
          )}
          {!quote.withinDailyCap && (
            <p className="mt-2 text-warn break-words">
              Amount exceeds today’s remaining burn capacity.
            </p>
          )}
        </div>
      )}

      {notice && <p role="status" className="text-sm text-warn leading-relaxed break-words">{notice}</p>}
      {err && <p className="text-sm text-danger leading-relaxed break-words">{err}</p>}
      {ethUnknown && (
        <EthBroadcastUnknown
          network={ethNetwork}
          state={ethUnknown}
          onAcknowledge={(acknowledged) => setEthUnknown({ ...ethUnknown, acknowledged })}
        />
      )}

      <button
        onClick={unwrap}
        disabled={!quote || !gas || busy !== "idle" || status?.paused === true || quote?.withinDailyCap === false || ethUnknownBlocksSend(ethUnknown)}
        className="btn-primary min-w-11"
      >
        {busy === "checking"
          ? "Checking…"
          : busy === "approving"
          ? "Approving…"
          : busy === "burning"
          ? "Burning…"
          : notice === BURN_REVIEW_NOTICE && quote
          ? `Sign the burn of ${grainsToPrlString(quote.amount)} WPRL`
          : quote
          ? `Unwrap ${grainsToPrlString(quote.amount)} WPRL`
          : "Unwrap"}
      </button>
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────

export function ActivityCard(props: {
  crossings: BridgeCrossingRecord[];
  requiredConfs: number;
  ethNetwork: ReturnType<typeof useWallet.getState>["ethNetwork"];
}) {
  const { crossings, requiredConfs, ethNetwork } = props;
  if (!crossings.length) {
    return (
      <div className="card text-sm text-text-2 leading-relaxed">
        No bridge activity yet. Wraps and unwraps you start here keep tracking even if
        you close the app — the bridge finishes them on-chain.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {["confirming", "relay", "done"].includes(crossings[0].phase) && (
        <AsciiPulse key={crossings[0].id} receipt={crossings[0]} />
      )}
      {crossings.map((c) => (
        <div key={c.id} className="card text-sm leading-relaxed">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 break-all font-mono font-semibold tabular-nums">
              {c.direction === "wrap" ? "PRL → WPRL" : "WPRL → PRL"}{" "}
              {grainsToPrlString(BigInt(c.amountGrains))}
            </span>
            <PhaseBadge phase={c.phase} />
          </div>
          <div className="mt-2 space-y-1 text-xs text-text-2 leading-relaxed">
            {c.direction === "wrap" && c.phase === "confirming" && (
              <div>
                Confirming on Pearl: {c.confirmations}/{requiredConfs}
              </div>
            )}
            {c.phase === "relay" && !isBurnCheckNotice(c.relayState) && (
              <div>Bridge processing{c.relayState ? ` — ${c.relayState}` : "…"}</div>
            )}
            {(c.phase === "relay" || c.phase === "confirming") && isBurnCheckNotice(c.relayState) && (
              <div className="text-warn">{c.relayState}</div>
            )}
            {c.phase === "review" && (
              <div className="text-warn">
                Under review by the bridge{c.relayState ? ` — ${c.relayState}` : ""}. This
                resolves automatically (mint) or is refunded to your Pearl address.
              </div>
            )}
            {c.phase === "refunded" && (
              <div className="text-warn">
                Refunded on Pearl{c.settledRef ? "" : " — payout pending"}.
              </div>
            )}
            {c.phase === "failed" && (
              <div className="text-danger">
                {c.relayState ?? "failed"} — funds are recoverable; contact the bridge
                via pearlbridge.xyz support if this persists.
              </div>
            )}
            <div className="break-all">
              {c.direction === "wrap" ? "Pearl tx: " : "Burn tx: "}
              <span className="font-mono break-all min-w-0 tabular-nums">{c.id}</span>
              {c.direction === "unwrap" && (
                <>
                  {" "}
                  <a
                    className="text-accent underline underline-offset-4"
                    href={ethTxExplorerUrl(ethNetwork, c.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Etherscan ↗
                  </a>
                </>
              )}
            </div>
            {c.settledRef && (
              <div className="break-all">
                {c.direction === "wrap" ? (
                  <a
                    className="text-accent underline underline-offset-4"
                    href={ethTxExplorerUrl(ethNetwork, c.settledRef)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WPRL mint tx ↗
                  </a>
                ) : (
                  <>Pearl payout: <span className="font-mono break-all min-w-0 tabular-nums">{c.settledRef}</span></>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: BridgeCrossingRecord["phase"] }) {
  const cls =
    phase === "done"
      ? "bg-surface-2 text-ok"
      : phase === "failed"
      ? "bg-danger-bg text-danger"
      : "bg-warn-bg text-warn";
  const label =
    phase === "confirming"
      ? "confirming"
      : phase === "relay"
      ? "bridging"
      : phase === "review"
      ? "under review"
      : phase;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium leading-relaxed ${cls}`}>{label}</span>;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-line py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-4">
      <span className="text-text-3">{k}</span>
      <span className="min-w-0 break-all font-mono tabular-nums sm:text-right">{v}</span>
    </div>
  );
}
