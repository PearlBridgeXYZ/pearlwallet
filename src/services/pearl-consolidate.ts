// UTXO consolidation ("Combine small coins").
//
// A wallet fed by thousands of small mining payouts can hold more coins
// than one transaction may spend (MAX_SEND_INPUTS), and every coin makes
// later sends bigger. Consolidation spends many of the wallet's coins into
// ONE output paying the wallet's own external index-0 address. No tip
// (it is a self-transfer), no change, one output.
//
// Planning (composeConsolidation, pure):
//   - coins of pending broadcasts are excluded (services/pending-spends);
//   - a coin worth no more than the fee to spend it (value ≤ marginal
//     input fee) is dust: skipped and reported;
//   - the rest are sorted smallest first and cut into batches of at most
//     `maxInputs` (≤ 500) — the smallest coins are cleaned up first;
//   - a batch whose fee would exceed 2 % of its value is refused and
//     reported as uneconomic (try a lower fee tier later);
//   - a lone remaining coin is left as it is (nothing to combine).
// Every batch satisfies, exactly: sum(inputs) = output + fee,
// fee = vsize × feerate (vsize from p2trKeyPathVsize, the exact size of
// the signed tx), vsize ≤ CONSOLIDATION_MAX_VBYTES (< 100,000 standard
// limit), fee ≤ 2 % of inputs, output pays the destination only.
//
// Broadcasting (broadcastConsolidationBatch): the batch is re-checked
// against those invariants and against the pending list, then signed by
// the worker's signPearlConsolidation, which independently refuses any
// output that is not this wallet's key at (branch, index) and any fee
// above 2 %. Right before submission the batch is recorded as a broadcast
// (services/pending-spends.ts; refused if another broadcast took a coin
// meanwhile or one has an unknown status), so a re-run never plans its
// coins again. Later batches are re-checked first by
// recheckConsolidationBatch, which re-reads only their own addresses.

import {
  broadcastRecorded,
  DUST_LIMIT_GRAINS,
  inputAddresses,
  MAX_SEND_INPUTS,
  p2trKeyPathVsize,
  PEARL_PREVIEW_FRESHNESS_MS,
  STANDARD_TX_MAX_VBYTES,
  type ComposedPearlTx,
  type PoolUtxo,
} from "./pearl-tx";
import { excludePendingSpends, outpointKey, PendingSpendConflictError, pendingOutpoints } from "./pending-spends";
import { walkPoolAddresses, type WalletAddressRef } from "./balances";
import type { PearlNetwork } from "../chains/pearl/network";
import type { HdBranch } from "../crypto/hd";
import { cryptoWorker } from "../crypto/worker-client";
import type { PearlConsolidationRequest } from "../crypto/worker";

/** Inputs per consolidation tx. 500 key-path inputs → 28,806 vB. */
export const CONSOLIDATION_MAX_INPUTS = MAX_SEND_INPUTS;
/** Size ceiling we plan to: 10 % under the 100 kvB standardness limit. */
export const CONSOLIDATION_MAX_VBYTES = (STANDARD_TX_MAX_VBYTES * 9n) / 10n;
/** Fee ceiling per batch: 2 % of the batch's inputs (pinned equal to the
 *  worker's check in crypto/pearl-sign by a test). */
export const CONSOLIDATION_MAX_FEE_NUM = 2n;
export const CONSOLIDATION_MAX_FEE_DEN = 100n;
/** Default feerate: combining coins is never urgent. */
export const CONSOLIDATION_DEFAULT_FEERATE = 1n;

export interface ConsolidationDestination {
  /** The wallet's own address (external index 0 in the UI). */
  address: string;
  branch: HdBranch;
  index: number;
}

export type ConsolidationInput = ComposedPearlTx["utxos"][number];

export interface ConsolidationBatch {
  utxos: ConsolidationInput[];
  /** The single output: everything minus the fee, to `destination`. */
  output: { address: string; amountGrains: bigint };
  destination: ConsolidationDestination;
  inputGrains: bigint;
  feeGrains: bigint;
  vbytes: bigint;
  feerate: bigint;
}

export interface CoinGroup {
  count: number;
  grains: bigint;
}

export interface ConsolidationPlan {
  batches: ConsolidationBatch[];
  destination: ConsolidationDestination;
  feerate: bigint;
  maxInputs: number;
  /** Coins considered (deduplicated, pending broadcasts removed). */
  utxoCount: number;
  totalGrains: bigint;
  /** Coins whose value does not exceed their own input fee. */
  dust: CoinGroup;
  /** Coins in batches refused because the fee would exceed 2 %. */
  uneconomic: CoinGroup & { batches: number };
  /** A single coin left over after batching (nothing to combine it with). */
  leftover: CoinGroup;
  /** Coins skipped because a recent broadcast already spends them. */
  pendingExcluded: number;
  totalInputGrains: bigint;
  totalFeeGrains: bigint;
  totalReceiveGrains: bigint;
}

export interface ComposeConsolidationOptions {
  utxos: readonly PoolUtxo[];
  destination: ConsolidationDestination;
  feerateSatPerVbyte?: bigint;
  /** Inputs per tx (default and ceiling CONSOLIDATION_MAX_INPUTS). */
  maxInputs?: number;
  now?: number;
  /** Coins of pending broadcasts the caller already removed from `utxos`
   *  (e.g. the live walk splits them off); added to `pendingExcluded` so
   *  the plan still explains them. */
  pendingAlreadyExcluded?: number;
}

/** Fee to add one key-path input at `feerate` (57.5 vB, rounded up). */
export function marginalInputFee(feerate: bigint): bigint {
  return (230n * feerate + 3n) / 4n;
}

function sum(us: readonly { valueGrains: bigint }[]): bigint {
  let s = 0n;
  for (const u of us) s += u.valueGrains;
  return s;
}

function buildBatch(
  coins: readonly PoolUtxo[],
  destination: ConsolidationDestination,
  feerate: bigint,
): ConsolidationBatch {
  const vbytes = p2trKeyPathVsize(coins.length, 1);
  const inputGrains = sum(coins);
  const feeGrains = vbytes * feerate;
  return {
    utxos: coins.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueGrains: u.valueGrains,
      scriptHex: u.scriptHex,
      branch: u.branch,
      index: u.index,
    })),
    output: { address: destination.address, amountGrains: inputGrains - feeGrains },
    destination: { ...destination },
    inputGrains,
    feeGrains,
    vbytes,
    feerate,
  };
}

function feeWithinCap(fee: bigint, inputs: bigint): boolean {
  return fee * CONSOLIDATION_MAX_FEE_DEN <= inputs * CONSOLIDATION_MAX_FEE_NUM;
}

/** Plans consolidation batches (pure — no network, no keys). */
export function composeConsolidation(opts: ComposeConsolidationOptions): ConsolidationPlan {
  const feerate = opts.feerateSatPerVbyte ?? CONSOLIDATION_DEFAULT_FEERATE;
  if (feerate <= 0n) throw new Error("E_FEERATE");
  const maxInputs = opts.maxInputs ?? CONSOLIDATION_MAX_INPUTS;
  if (!Number.isInteger(maxInputs) || maxInputs < 2 || maxInputs > CONSOLIDATION_MAX_INPUTS) {
    throw new Error("E_MAX_INPUTS");
  }
  // Static guard: the cap itself must keep every batch under the limit.
  if (p2trKeyPathVsize(maxInputs, 1) > CONSOLIDATION_MAX_VBYTES) throw new Error("E_MAX_INPUTS");
  const dest = opts.destination;
  if (!dest || typeof dest.address !== "string" || dest.address.length === 0) {
    throw new Error("E_CONSOLIDATION_DESTINATION");
  }

  const seen = new Set<string>();
  const unique: PoolUtxo[] = [];
  for (const u of opts.utxos) {
    const k = outpointKey(u);
    if (seen.has(k) || u.valueGrains <= 0n) continue;
    seen.add(k);
    unique.push(u);
  }
  const { spendable, pending } = excludePendingSpends(unique, opts.now);

  const marginal = marginalInputFee(feerate);
  const dustCoins = spendable.filter((u) => u.valueGrains <= marginal);
  const eligible = spendable
    .filter((u) => u.valueGrains > marginal)
    .sort((a, b) => {
      if (a.valueGrains !== b.valueGrains) return a.valueGrains < b.valueGrains ? -1 : 1;
      const ka = outpointKey(a);
      const kb = outpointKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const batches: ConsolidationBatch[] = [];
  const uneconomic = { count: 0, grains: 0n, batches: 0 };
  const leftover = { count: 0, grains: 0n };
  for (let i = 0; i < eligible.length; i += maxInputs) {
    const chunk = eligible.slice(i, i + maxInputs);
    if (chunk.length < 2) {
      leftover.count += chunk.length;
      leftover.grains += sum(chunk);
      continue;
    }
    const b = buildBatch(chunk, dest, feerate);
    if (!feeWithinCap(b.feeGrains, b.inputGrains) || b.output.amountGrains <= DUST_LIMIT_GRAINS) {
      uneconomic.count += chunk.length;
      uneconomic.grains += b.inputGrains;
      uneconomic.batches++;
      continue;
    }
    assertConsolidationBatch(b);
    batches.push(b);
  }

  let totalInputGrains = 0n;
  let totalFeeGrains = 0n;
  let totalReceiveGrains = 0n;
  for (const b of batches) {
    totalInputGrains += b.inputGrains;
    totalFeeGrains += b.feeGrains;
    totalReceiveGrains += b.output.amountGrains;
  }
  return {
    batches,
    destination: { ...dest },
    feerate,
    maxInputs,
    utxoCount: spendable.length,
    totalGrains: sum(spendable),
    dust: { count: dustCoins.length, grains: sum(dustCoins) },
    uneconomic,
    leftover,
    pendingExcluded: pending.length + Math.max(0, opts.pendingAlreadyExcluded ?? 0),
    totalInputGrains,
    totalFeeGrains,
    totalReceiveGrains,
  };
}

/**
 * Throws E_CONSOLIDATION_INVARIANT:<rule> unless `b` is a well-formed
 * consolidation: 2..500 unique positive inputs; one output to the
 * destination above dust; inputs = output + fee exactly; vsize exact and
 * ≤ CONSOLIDATION_MAX_VBYTES; fee = vsize × feerate and ≤ 2 % of inputs.
 */
export function assertConsolidationBatch(b: ConsolidationBatch): void {
  const fail = (rule: string): never => {
    throw new Error(`E_CONSOLIDATION_INVARIANT:${rule}`);
  };
  if (!b || !Array.isArray(b.utxos)) fail("shape");
  const n = b.utxos.length;
  if (n < 2 || n > CONSOLIDATION_MAX_INPUTS) fail("input-count");
  const seen = new Set<string>();
  let inSum = 0n;
  for (const u of b.utxos) {
    if (u.valueGrains <= 0n) fail("input-value");
    const k = outpointKey(u);
    if (seen.has(k)) fail("duplicate-input");
    seen.add(k);
    inSum += u.valueGrains;
  }
  if (inSum !== b.inputGrains) fail("input-sum");
  if (b.output.address !== b.destination.address) fail("destination");
  if (b.output.amountGrains <= DUST_LIMIT_GRAINS) fail("dust-output");
  if (b.inputGrains !== b.output.amountGrains + b.feeGrains) fail("balance");
  if (b.feerate <= 0n) fail("feerate");
  const vbytes = p2trKeyPathVsize(n, 1);
  if (b.vbytes !== vbytes) fail("vsize");
  if (vbytes > CONSOLIDATION_MAX_VBYTES || vbytes >= STANDARD_TX_MAX_VBYTES) fail("vsize-limit");
  if (b.feeGrains !== vbytes * b.feerate) fail("fee");
  if (!feeWithinCap(b.feeGrains, b.inputGrains)) fail("fee-cap");
}

/**
 * Before signing a later batch, the caller re-scans; this throws
 * E_CONSOLIDATION_INPUTS_CHANGED unless every input of `b` is still in
 * the fresh spendable set with the same value and script, and none is
 * already spent by a pending broadcast. The batch is then signed exactly
 * as the user reviewed it — never re-planned silently.
 */
export function verifyBatchStillSpendable(
  b: ConsolidationBatch,
  fresh: readonly PoolUtxo[],
  now: number = Date.now(),
): void {
  const byKey = new Map<string, PoolUtxo>();
  for (const u of fresh) byKey.set(outpointKey(u), u);
  const pending = pendingOutpoints(now);
  for (const u of b.utxos) {
    const k = outpointKey(u);
    const f = byKey.get(k);
    if (
      !f ||
      pending.has(k) ||
      f.valueGrains !== u.valueGrains ||
      f.scriptHex.toLowerCase() !== u.scriptHex.toLowerCase() ||
      f.branch !== u.branch ||
      f.index !== u.index
    ) {
      throw new Error("E_CONSOLIDATION_INPUTS_CHANGED");
    }
  }
}

/** Known single-sig addresses by branch, ordered by index. */
export interface ConsolidationAddressBook {
  external: readonly string[];
  internal: readonly string[];
  /** The addresses the plan's own walk read, with their (branch, index).
   *  Primary source: a coin found on an address discovered by that walk
   *  can be re-checked even if persisting the discovery failed. The
   *  branch lists above are the fallback. */
  refs?: readonly { address: string; branch: HdBranch; index: number }[];
}

/**
 * Re-reads ONLY the addresses that hold this batch's coins (not the whole
 * wallet), checks every input with verifyBatchStillSpendable, and returns
 * the time the last of those reads finished — the batch's new review
 * clock. Throws E_CONSOLIDATION_RECHECK_INCOMPLETE when an address can't
 * be read completely (RPC failure or page cap): an incomplete history
 * can't prove a coin unspent. `opts.maxPages` = the depth the plan's own
 * walk used (a plan read deeper is re-checked at that depth).
 */
export async function recheckConsolidationBatch(
  b: ConsolidationBatch,
  book: ConsolidationAddressBook,
  opts: { signal?: AbortSignal; now?: () => number; maxPages?: number } = {},
): Promise<number> {
  const refs: WalletAddressRef[] = [];
  const seen = new Set<string>();
  const fromPlan = new Map<string, string>();
  for (const r of book.refs ?? []) fromPlan.set(`${r.branch}/${r.index}`, r.address);
  for (const u of b.utxos) {
    const id = `${u.branch}/${u.index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const address = fromPlan.get(id) ?? (u.branch === 1 ? book.internal : book.external)[u.index];
    if (!address) throw new Error("E_CONSOLIDATION_RECHECK_INCOMPLETE");
    refs.push({ address, branch: u.branch, index: u.index });
  }
  const results = await walkPoolAddresses(refs, { signal: opts.signal, priority: "high", maxPages: opts.maxPages });
  const fresh: PoolUtxo[] = [];
  results.forEach((r, i) => {
    if (r.status !== "ok" || r.capped) throw new Error("E_CONSOLIDATION_RECHECK_INCOMPLETE");
    const ref = refs[i]!;
    for (const u of r.utxos) fresh.push({ ...u, branch: ref.branch, index: ref.index });
  });
  const at = (opts.now ?? Date.now)();
  verifyBatchStillSpendable(b, fresh, at);
  return at;
}

/** A batch as shown to the user, stamped with when its coins were last
 *  verified (plan time for the first batch, re-scan time for later ones). */
export interface FrozenConsolidationBatch {
  batch: ConsolidationBatch;
  verifiedAt: number;
}

export interface ConsolidationBroadcast {
  txid: string;
  batch: ConsolidationBatch;
}

/**
 * Signs (worker: signPearlConsolidation) and broadcasts one batch exactly
 * as reviewed. Refuses a batch verified more than
 * PEARL_PREVIEW_FRESHNESS_MS ago (E_PREVIEW_STALE), a batch breaking any
 * invariant, a batch spending a coin of a recorded broadcast
 * (E_CONSOLIDATION_INPUT_PENDING), and any batch while another broadcast's
 * status is unknown (BroadcastRefusedError "unresolved").
 */
export async function broadcastConsolidationBatch(
  frozen: FrozenConsolidationBatch,
  network: PearlNetwork,
  now: number = Date.now(),
): Promise<ConsolidationBroadcast> {
  if (now - frozen.verifiedAt > PEARL_PREVIEW_FRESHNESS_MS) throw new Error("E_PREVIEW_STALE");
  const b = frozen.batch;
  assertConsolidationBatch(b);
  const req: PearlConsolidationRequest = {
    utxos: b.utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueGrains: u.valueGrains.toString(),
      scriptHex: u.scriptHex,
      branch: u.branch,
      index: u.index,
    })),
    outputs: [{ address: b.output.address, amountGrains: b.output.amountGrains.toString() }],
    destination: { branch: b.destination.branch, index: b.destination.index },
    network,
  };
  // Gate (an "unknown" broadcast blocks every consolidation; a coin taken
  // by another broadcast refuses the batch), sign, record, submit — one
  // locked step (broadcastRecorded).
  try {
    const txid = await broadcastRecorded(
      {
        kind: "consolidation",
        inputs: b.utxos,
        addresses: inputAddresses(b.utxos),
        destination: b.output.address,
        amountGrains: b.output.amountGrains,
      },
      async () => {
        const { raw } = await cryptoWorker.call<"signPearlConsolidation", { raw: string }>("signPearlConsolidation", {
          req,
        });
        return raw;
      },
    );
    return { txid, batch: b };
  } catch (e) {
    if (e instanceof PendingSpendConflictError) throw new Error("E_CONSOLIDATION_INPUT_PENDING");
    throw e;
  }
}
