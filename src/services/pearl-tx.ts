// PRL send service. Aggregates UTXOs across the receive-address pool,
// picks coins, builds + signs + broadcasts the tx via the crypto worker
// and the sentry RPC.

import {
  broadcastPearlTx,
  BroadcastStatusUnknownError,
  MAX_UTXO_WALK_PAGES_HARD,
  p2trScriptAddress,
  rawTxId,
  rawTxInputs,
  rawTxOutputs,
} from "./pearl-rpc";
import { scanPrlPool, type PoolUtxoRecord, type PrlPoolScan, type WalletAddressRef } from "./balances";
import { scanPrlWallet, type DeriveMoreAddresses } from "./discovery";
import {
  assertBroadcastAllowed,
  excludePendingSpends,
  outpointKey,
  recordBroadcast,
  settleBroadcast,
  withBroadcastLock,
  type BroadcastPlan,
} from "./pending-spends";
import { notePoolScan } from "./broadcast-status";
import { computeTipGrains, tipAddressFor } from "../chains/pearl/tip";
import type { PearlNetwork } from "../chains/pearl/network";
import { cryptoWorker } from "../crypto/worker-client";
import type { PearlTxRequest } from "../crypto/worker";

// Tx-size feerate estimate. A taproot key-path 1-in / 2-out tx is
// roughly 110 vbytes; each extra input ≈ +57.5 vbytes (taproot keypath
// witness is 64 bytes / 4 = 16 vweight + 41-byte non-witness header
// per input). We round up — over-estimating the fee by a few grains
// is far better than under-paying and stalling the tx in mempool.
// Pearl is a low-fee chain; current relay floor is ~1 sat/vbyte on
// btcd-derived nodes. We use 2 sat/vbyte as the default so a single
// fee-bump epoch doesn't strand normal sends.
const PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE = 2n;

const PER_INPUT_VBYTES = 58n;
const PER_P2TR_OUTPUT_VBYTES = 43n;
const FIXED_OVERHEAD_VBYTES = 11n;
// Pearl dust threshold (mirror of btcd's): outputs ≤ 546 sats won't
// relay. We refuse to assemble a change output below this — coalesce
// it into fee instead.
const DUST_LIMIT_GRAINS = 546n;

/** Most inputs one send may spend. Equal to the signer's hard cap
 *  (crypto/pearl-sign MAX_PEARL_SIGN_INPUTS — a test pins the two
 *  together); a 500-input key-path tx is ~28.8 kvB, far below the
 *  100 kvB standardness limit. A send needing more coins raises
 *  TooManyInputsError and the UI offers consolidation instead. */
export const MAX_SEND_INPUTS = 500;

/** Policy limit on a standard transaction's virtual size
 *  (MAX_STANDARD_TX_WEIGHT 400,000 WU / 4). */
export const STANDARD_TX_MAX_VBYTES = 100_000n;

export interface ComposedPearlTx {
  /** Picked inputs; (branch, index) names the HD key that controls each. */
  utxos: { txid: string; vout: number; valueGrains: bigint; scriptHex: string; branch: 0 | 1; index: number }[];
  outputs: { address: string; amountGrains: bigint }[];
  /** Amount paid to the destination (outputs[0]). */
  amountGrains: bigint;
  /** Exactly sum(inputs) − sum(outputs): the size-based estimate plus any
   *  sub-dust leftover that could not become a change output. */
  feeGrains: bigint;
  tipGrains: bigint;
  changeGrains: bigint;
  degraded: boolean;
  /** Addresses whose history the walk could not read to the end (page
   *  cap). Their coins are NOT in the spendable set — an incomplete
   *  history never funds a transaction. "Search deeper" reads more. */
  historyIncomplete: number;
  /** Total spendable grains the walk found across the pool, regardless
   *  of how many UTXOs were ultimately picked. Surfaced so the UI can
   *  show "X PRL across N inputs" diagnostics. */
  spendableGrains: bigint;
  /** UTXO count the walk found across the pool. Pairs with spendableGrains
   *  for diagnostics. */
  spendableUtxoCount: number;
}

export interface ComposeOptions {
  network: PearlNetwork;
  /** External (receive) branch addresses, ordered by index. Change is
   *  paid back to pool[0] (external index 0). */
  pool: string[];
  /** Internal (change) branch addresses, ordered by index. When given,
   *  the live walk covers both branches with gap-limit discovery
   *  (services/discovery.ts); when omitted, only `pool` is walked. */
  changePool?: string[];
  /** Derives addresses past the known set during the live walk. */
  deriveMore?: DeriveMoreAddresses;
  /** Receives the discovered address set when the live walk extended it. */
  onDiscovered?: (set: { external: string[]; internal: string[] }) => unknown;
  destination: string;
  amountGrains: bigint;
  feerateSatPerVbyte?: bigint;
  /** When true, include the v0.1.4 tip output to the PearlBridge dev
   *  team address. UI exposes a per-tx toggle bound to a global pref. */
  includeTip: boolean;
  /** Optional pre-fetched UTXO set from the dashboard balance walk.
   *  When fresh and present, skip the per-address re-walk entirely —
   *  the Send preview opens instantly instead of waiting ~6s. The
   *  cache is treated as a hint; if it's empty or doesn't satisfy
   *  the amount, fall back to a live walk. */
  cachedUtxos?: PoolUtxo[];
  /** Flags of the walk that produced `cachedUtxos`, carried into the
   *  result when the cache is used (a caller passing a live walk's coins,
   *  e.g. Send max, must not have its warnings reset). */
  cachedFrom?: { degraded: boolean; historyIncomplete: number };
  /** Override walk depth. Caller bumps this on retry after a degraded
   *  walk produced E_INSUFFICIENT_FUNDS. Clamped server-side to
   *  MAX_UTXO_WALK_PAGES_HARD. */
  maxPages?: number;
  /** Per-tx input cap (default and ceiling MAX_SEND_INPUTS). */
  maxInputs?: number;
  /** Cancels a live walk (lock / wipe / navigation). */
  signal?: AbortSignal;
}

function estimateFee(numInputs: number, numOutputs: number, feerate: bigint): bigint {
  const vbytes =
    FIXED_OVERHEAD_VBYTES +
    BigInt(numInputs) * PER_INPUT_VBYTES +
    BigInt(numOutputs) * PER_P2TR_OUTPUT_VBYTES;
  return vbytes * feerate;
}

/** Bitcoin CompactSize length for a count. */
function compactSizeLen(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
}

/**
 * Exact virtual size of a segwit tx spending `numInputs` P2TR key-path
 * inputs (64-byte SIGHASH_DEFAULT Schnorr signature, empty scriptSig)
 * to `numOutputs` P2TR outputs: ceil(weight / 4) with
 *   weight = 4 × (version 4 + locktime 4 + counts + 41/input + 43/output)
 *          + 2 (segwit marker + flag) + 66/input (witness: 1 + 1 + 64).
 * Consolidation prices its fee from this; tests pin it to the real size
 * of signed transactions.
 */
export function p2trKeyPathVsize(numInputs: number, numOutputs: number): bigint {
  if (!Number.isInteger(numInputs) || !Number.isInteger(numOutputs) || numInputs < 1 || numOutputs < 1) {
    throw new Error("E_VSIZE_ARGS");
  }
  const base = 8 + compactSizeLen(numInputs) + compactSizeLen(numOutputs) + 41 * numInputs + 43 * numOutputs;
  const weight = 4 * base + 2 + 66 * numInputs;
  return BigInt(Math.ceil(weight / 4));
}

export type PoolUtxo = PoolUtxoRecord;

/** The live walk finished but some addresses never answered and nothing
 *  was found: an RPC problem, not an empty wallet. */
export class UtxoScanIncompleteError extends Error {
  readonly code = "E_UTXO_SCAN_INCOMPLETE" as const;
  constructor(
    readonly failures: number,
    readonly addressesScanned: number,
  ) {
    super(
      `E_UTXO_SCAN_INCOMPLETE: ${failures} of ${addressesScanned} addresses could not be read (Pearl RPC busy) — try again`,
    );
    this.name = "UtxoScanIncompleteError";
  }
}

/** Nothing spendable was found, but some addresses have more history than
 *  the walk read (page cap). Their coins can't be used until a deeper walk
 *  reads the whole history. */
export class HistoryIncompleteError extends Error {
  readonly code = "E_HISTORY_INCOMPLETE" as const;
  constructor(
    readonly incompleteAddresses: number,
    readonly addressesScanned: number,
  ) {
    super(
      `E_HISTORY_INCOMPLETE: ${incompleteAddresses} of ${addressesScanned} addresses have more history than was read — search deeper`,
    );
    this.name = "HistoryIncompleteError";
  }
}

/** The walk read every address and found no coin this wallet can spend
 *  right now. `pendingCount` coins exist but are already being spent by
 *  a recent broadcast from this wallet. */
export class NoSpendableCoinsError extends Error {
  readonly code = "E_NO_UTXOS" as const;
  constructor(
    readonly addressesScanned: number,
    readonly pendingCount: number,
    readonly degraded: boolean,
  ) {
    super("E_NO_UTXOS");
    this.name = "NoSpendableCoinsError";
  }
}

function sortLargestFirst<T extends { valueGrains: bigint; txid: string; vout: number }>(utxos: T[]): T[] {
  // Value descending; ties broken by outpoint so selection is deterministic.
  return utxos.sort((a, b) => {
    if (a.valueGrains !== b.valueGrains) return a.valueGrains > b.valueGrains ? -1 : 1;
    const ka = outpointKey(a);
    const kb = outpointKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function dedupeOutpoints<T extends { txid: string; vout: number }>(utxos: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const u of utxos) {
    const k = outpointKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

export interface SpendableUtxoSet {
  /** Spendable coins, largest first, coins of pending broadcasts removed. */
  utxos: PoolUtxo[];
  /** Coins the walk returned that a recent broadcast already spends. */
  pending: PoolUtxo[];
  degraded: boolean;
  /** Page-capped addresses left out of `utxos` (see ComposedPearlTx). */
  historyIncomplete: number;
  addressesScanned: number;
  /** When the walk's LAST per-address result was read. */
  fetchedAt: number;
  /** Every address the walk read, with the (branch, index) deriving it —
   *  the address book a later re-check of these coins can rely on even
   *  if persisting newly discovered addresses failed. */
  refs: WalletAddressRef[];
}

async function listPoolUtxos(
  opts: Pick<ComposeOptions, "pool" | "changePool" | "deriveMore" | "onDiscovered" | "maxPages" | "signal">,
): Promise<SpendableUtxoSet> {
  // v0.7: pacing comes from the shared Pearl RPC token bucket; a few
  // addresses walk in parallel. With a change branch supplied the walk
  // is the same gap-limit discovery scan the dashboard runs.
  let scan: PrlPoolScan;
  if (opts.changePool) {
    const w = await scanPrlWallet(
      { external: opts.pool, internal: opts.changePool },
      { maxPages: opts.maxPages, deriveMore: opts.deriveMore, signal: opts.signal },
    );
    if (
      opts.onDiscovered &&
      (w.discovered.external.length > opts.pool.length || w.discovered.internal.length > opts.changePool.length)
    ) {
      try {
        await opts.onDiscovered(w.discovered);
      } catch {
        /* persistence is best-effort; the scan result stands */
      }
    }
    scan = w;
  } else {
    scan = await scanPrlPool(opts.pool, { maxPages: opts.maxPages, signal: opts.signal });
  }
  // A complete read of an address settles broadcast records it proves spent.
  notePoolScan(scan);
  // Review clock: starts when the last address was read, not when the
  // walk began (a paced walk of a big wallet takes minutes).
  const fetchedAt = scan.finishedAt;
  // Mirror balances.ts tolerance — a single pool address being
  // unavailable shouldn't deny the user spending from the rest; the
  // result is flagged degraded so a shortfall offers a deeper retry.
  // An address whose history was cut off by the page cap is different:
  // its set may list coins spent on a page we never read, so none of its
  // coins are offered at all.
  const out: PoolUtxo[] = [];
  let historyIncomplete = 0;
  scan.perAddress.forEach((r, i) => {
    if (r.status !== "ok") return;
    if (r.capped) {
      historyIncomplete++;
      return;
    }
    const ref = scan.refs[i]!;
    for (const u of r.utxos) out.push({ ...u, branch: ref.branch, index: ref.index });
  });
  const degraded = scan.degraded || scan.failures > 0 || historyIncomplete > 0;
  // Nothing found AND some addresses could not be read: that is an RPC
  // problem, not an empty wallet. Say so instead of E_NO_UTXOS.
  if (out.length === 0 && scan.failures > 0) {
    throw new UtxoScanIncompleteError(scan.failures, scan.pool.length);
  }
  if (out.length === 0 && historyIncomplete > 0) {
    throw new HistoryIncompleteError(historyIncomplete, scan.pool.length);
  }
  // We don't have on-chain confirmation height in the UTXO walk so we
  // can't filter unconfirmed; the sentry-side mempool view already
  // includes mempool transactions, which means we'll happily spend a
  // 1-conf input. Coins spent by our own recent broadcasts are removed
  // (services/pending-spends.ts) whether or not the walk shows them.
  const { spendable, pending } = excludePendingSpends(dedupeOutpoints(out));
  return {
    utxos: sortLargestFirst(spendable),
    pending,
    degraded,
    historyIncomplete,
    addressesScanned: scan.pool.length,
    fetchedAt,
    refs: scan.refs.map((r) => ({ ...r })),
  };
}

/**
 * Live walk of the wallet (both branches when `changePool` is given),
 * returning the coins Send / Send-max / Consolidate may spend. Throws
 * UtxoScanIncompleteError when nothing was found and addresses failed.
 */
export async function loadSpendableUtxos(
  opts: Pick<ComposeOptions, "pool" | "changePool" | "deriveMore" | "onDiscovered" | "maxPages" | "signal">,
): Promise<SpendableUtxoSet> {
  return listPoolUtxos(opts);
}

function sumGrains(utxos: { valueGrains: bigint }[]): bigint {
  let s = 0n;
  for (const u of utxos) s += u.valueGrains;
  return s;
}

/** Structured error a caller can switch on to render diagnostics
 *  ("found X PRL across N inputs, need Y") and offer a deeper-walk
 *  retry when degraded. */
export class InsufficientFundsError extends Error {
  readonly code = "E_INSUFFICIENT_FUNDS" as const;
  constructor(
    readonly need: bigint,
    readonly have: bigint,
    readonly utxoCount: number,
    readonly degraded: boolean,
  ) {
    super("E_INSUFFICIENT_FUNDS");
    this.name = "InsufficientFundsError";
  }
}

/** The wallet holds enough PRL, but covering this amount needs more
 *  coins than one transaction may spend. The fix is to combine coins
 *  first (Consolidate screen); `maxSendableGrains` is what a single
 *  transaction can send right now. */
export class TooManyInputsError extends Error {
  readonly code = "E_TOO_MANY_INPUTS" as const;
  constructor(
    readonly inputsNeeded: number,
    readonly maxInputs: number,
    readonly utxoCount: number,
    readonly spendableGrains: bigint,
    readonly maxSendableGrains: bigint,
  ) {
    super(`E_TOO_MANY_INPUTS: this send needs ${inputsNeeded} coins; one transaction can spend at most ${maxInputs}`);
    this.name = "TooManyInputsError";
  }
}

function clampMaxInputs(n: number | undefined): number {
  if (n === undefined) return MAX_SEND_INPUTS;
  if (!Number.isInteger(n) || n < 1) throw new Error("E_MAX_INPUTS");
  return Math.min(n, MAX_SEND_INPUTS);
}

interface CoinSelection {
  picked: PoolUtxo[];
  sum: bigint;
  feeGrains: bigint;
  changeGrains: bigint;
}

/**
 * Greedy largest-first selection over `avail` (already sorted largest
 * first). Stops at the first prefix that covers amount + tip + the fee
 * of a change-less tx; then adds a change output when the leftover pays
 * for it and is at least dust, else the sub-dust leftover goes to fee.
 * Largest-first minimises the input count for any target, so if the
 * covering prefix is longer than `maxInputs`, no selection within the
 * cap exists → TooManyInputsError.
 */
function selectCoins(
  avail: PoolUtxo[],
  amountGrains: bigint,
  tipGrains: bigint,
  feerate: bigint,
  maxInputs: number,
  includeTip: boolean,
  degraded: boolean,
): CoinSelection {
  // Outputs without change: destination, plus the tip when one is due.
  const baseOutputs = tipGrains > 0n ? 2 : 1;
  const picked: PoolUtxo[] = [];
  let sum = 0n;
  for (const u of avail) {
    picked.push(u);
    sum += u.valueGrains;
    if (sum >= amountGrains + tipGrains + estimateFee(picked.length, baseOutputs, feerate)) break;
  }
  const feeNoChange = estimateFee(picked.length, baseOutputs, feerate);
  const totalAvail = sumGrains(avail);
  if (avail.length === 0 || sum < amountGrains + tipGrains + feeNoChange) {
    throw new InsufficientFundsError(amountGrains + tipGrains + feeNoChange, totalAvail, avail.length, degraded);
  }
  if (picked.length > maxInputs) {
    const max = computeMaxSendable({ utxos: avail, feerateSatPerVbyte: feerate, includeTip, maxInputs });
    throw new TooManyInputsError(picked.length, maxInputs, avail.length, totalAvail, max.amountGrains);
  }
  const feeWithChange = estimateFee(picked.length, baseOutputs + 1, feerate);
  const change = sum - amountGrains - tipGrains - feeWithChange;
  if (change >= DUST_LIMIT_GRAINS) {
    return { picked, sum, feeGrains: feeWithChange, changeGrains: change };
  }
  // No change output: the leftover (< dust + one output's fee) is paid
  // to miners and is part of the fee — the fee line shows what the tx
  // really pays, and inputs = outputs + fee holds exactly.
  return { picked, sum, feeGrains: sum - amountGrains - tipGrains, changeGrains: 0n };
}

/**
 * Greedy coin selection. Adds UTXOs largest-first until total >= amount
 * + tip + estimated fee for the current input count. Re-estimates fee
 * on each input addition because adding a coin grows the tx.
 *
 * UTXO COMBINING: the loop walks the pool's whole UTXO set largest-first
 * and stacks coins until the total covers amount + fee + tip. A 100k
 * PRL send against a wallet holding 500k PRL spread across many smaller
 * UTXOs WILL combine enough of them — up to MAX_SEND_INPUTS coins per
 * transaction. Needing more raises TooManyInputsError (combine coins
 * first). If `cachedUtxos` covers the amount we use the cache (fast
 * path, no network); if a complete cache needs too many inputs that
 * TooManyInputsError is thrown at once; otherwise we walk the pool live with
 * `opts.maxPages` controlling depth. On a degraded walk that still
 * comes up short we throw an InsufficientFundsError that includes the
 * actual numbers — UI can offer a deeper-walk retry. Coins spent by a
 * recent broadcast from this wallet are never selected.
 */
export async function composePearlSend(opts: ComposeOptions): Promise<ComposedPearlTx> {
  const feerate = opts.feerateSatPerVbyte ?? PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE;
  if (feerate <= 0n) throw new Error("E_FEERATE");
  if (opts.amountGrains <= 0n) throw new Error("E_AMOUNT");
  const maxInputs = clampMaxInputs(opts.maxInputs);
  const tipGrains = opts.includeTip ? computeTipGrains(opts.amountGrains) : 0n;

  // The cache is a hint: use it when selection over it succeeds. If it
  // doesn't, do a live walk anyway — the cache may have been built with
  // a smaller maxPages and the user genuinely has more coins than the
  // cache shows.
  let avail: PoolUtxo[] = [];
  let degraded = false;
  let historyIncomplete = 0;
  let selection: CoinSelection | null = null;
  const cache = opts.cachedUtxos;
  if (cache && cache.length > 0) {
    const cached = sortLargestFirst(excludePendingSpends(dedupeOutpoints(cache)).spendable);
    const cachedDegraded = opts.cachedFrom?.degraded ?? false;
    if (cached.length > 0) {
      try {
        selection = selectCoins(cached, opts.amountGrains, tipGrains, feerate, maxInputs, opts.includeTip, cachedDegraded);
        avail = cached;
        degraded = cachedDegraded;
        historyIncomplete = opts.cachedFrom?.historyIncomplete ?? 0;
      } catch (err) {
        // Too many inputs over a complete cached scan is the answer: a
        // live walk sees the same coins (minutes of paced requests for a
        // large wallet) and can only differ if a larger coin arrived since,
        // which a rescan picks up. Surface it now. Short funds still fall
        // through to a live walk (a new receive may cover the amount).
        if (err instanceof TooManyInputsError && !cachedDegraded) throw err;
        selection = null;
      }
    }
  }

  if (!selection) {
    const live = await listPoolUtxos(opts);
    avail = live.utxos;
    degraded = live.degraded;
    historyIncomplete = live.historyIncomplete;
    if (avail.length === 0) {
      throw new NoSpendableCoinsError(live.addressesScanned, live.pending.length, live.degraded);
    }
    selection = selectCoins(avail, opts.amountGrains, tipGrains, feerate, maxInputs, opts.includeTip, degraded);
  }

  const { picked, feeGrains, changeGrains } = selection;
  const outputs: { address: string; amountGrains: bigint }[] = [
    { address: opts.destination, amountGrains: opts.amountGrains },
  ];
  if (tipGrains > 0n) {
    outputs.push({ address: tipAddressFor(opts.network), amountGrains: tipGrains });
  }
  if (changeGrains > 0n) {
    // Change stays on external index 0 (unchanged behaviour); paying
    // change to the internal branch is a separate, deliberate step.
    outputs.push({ address: opts.pool[0]!, amountGrains: changeGrains });
  }
  // Money invariant: every grain in is accounted for.
  if (selection.sum !== outputs.reduce((a, o) => a + o.amountGrains, 0n) + feeGrains || feeGrains <= 0n) {
    throw new Error("E_COMPOSE_INVARIANT");
  }

  return {
    utxos: picked.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueGrains: u.valueGrains,
      scriptHex: u.scriptHex,
      branch: u.branch,
      index: u.index,
    })),
    outputs,
    amountGrains: opts.amountGrains,
    feeGrains,
    tipGrains,
    changeGrains,
    degraded,
    historyIncomplete,
    spendableGrains: sumGrains(avail),
    spendableUtxoCount: avail.length,
  };
}

export interface MaxSendableOptions {
  /** Spendable coins (any order; duplicates and coins of pending
   *  broadcasts are ignored). */
  utxos: readonly PoolUtxo[];
  feerateSatPerVbyte?: bigint;
  includeTip: boolean;
  /** Per-tx input cap (default and ceiling MAX_SEND_INPUTS). */
  maxInputs?: number;
}

export interface MaxSendable {
  /** Largest destination amount one transaction can send. 0 = nothing. */
  amountGrains: bigint;
  tipGrains: bigint;
  /** sum(inputs) − amount − tip − change. */
  feeGrains: bigint;
  /** 0 unless `exact` is false (tip-floor gap, see below). */
  changeGrains: bigint;
  /** The coins that fund it: the largest `maxInputs` economic coins. */
  inputs: PoolUtxo[];
  inputGrains: bigint;
  /** amount + tip + fee == inputGrains and there is no change output. */
  exact: boolean;
  /** More economic coins exist than one tx may spend. */
  capped: boolean;
  /** Coins whose value does not cover their own input fee — left out. */
  uneconomicCount: number;
  /** Coins left out because of the input cap. */
  cappedOutCount: number;
}

/**
 * "Send max": the largest amount A such that
 *   A + tip(A) + fee == sum(selected inputs)
 * with no change output, where the selected inputs are the largest
 * `maxInputs` coins worth spending (value > marginal input fee) and the
 * fee is the size-based estimate for (inputs, dest [+ tip]) outputs.
 *
 * cost(A) = A + tip(A) + fee(tip(A) > 0 ? 2 : 1 outputs) is
 * non-decreasing in A (tip(A) is: 0 below 1 PRL, then the 1 PRL floor,
 * then 10 bps), so the max A with cost(A) ≤ S is found by binary search.
 * The leftover S − cost(A) is then:
 *   0             — the normal, exact case;
 *   1 grain       — 10-bps region, where A + floor(A/1000) skips a value;
 *                   the grain is added to the fee (still no change);
 *   larger        — the tip-floor gap: S can cover A < 1 PRL with no
 *                   tip but not A ≥ 1 PRL plus the 1 PRL tip. A is then
 *                   1 PRL − 1 grain and the leftover returns as change
 *                   (or is fee when below dust); `exact` is false. With
 *                   the tip off the same coins send everything.
 * composePearlSend with the returned amount selects the same inputs and
 * produces the same fee (tests pin this).
 */
export function computeMaxSendable(opts: MaxSendableOptions): MaxSendable {
  const feerate = opts.feerateSatPerVbyte ?? PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE;
  if (feerate <= 0n) throw new Error("E_FEERATE");
  const maxInputs = clampMaxInputs(opts.maxInputs);
  const marginal = PER_INPUT_VBYTES * feerate;
  // Coins of pending broadcasts are excluded here too, so the max always
  // matches what composePearlSend will select.
  const all = sortLargestFirst(excludePendingSpends(dedupeOutpoints(opts.utxos)).spendable);
  const economic = all.filter((u) => u.valueGrains > marginal);
  const inputs = economic.slice(0, maxInputs);
  const S = sumGrains(inputs);
  const zero: MaxSendable = {
    amountGrains: 0n,
    tipGrains: 0n,
    feeGrains: 0n,
    changeGrains: 0n,
    inputs: [],
    inputGrains: 0n,
    exact: false,
    capped: economic.length > maxInputs,
    uneconomicCount: all.length - economic.length,
    cappedOutCount: Math.max(0, economic.length - maxInputs),
  };
  if (inputs.length === 0) return zero;

  const k = inputs.length;
  const tipOf = (a: bigint) => (opts.includeTip ? computeTipGrains(a) : 0n);
  const feeOf = (tip: bigint) => estimateFee(k, tip > 0n ? 2 : 1, feerate);
  const cost = (a: bigint) => {
    const t = tipOf(a);
    return a + t + feeOf(t);
  };
  // Binary search the largest A in [0, S] with cost(A) ≤ S.
  let lo = 0n;
  let hi = S;
  if (cost(0n) > S) return zero;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (cost(mid) <= S) lo = mid;
    else hi = mid - 1n;
  }
  const A = lo;
  // A destination output at or below dust would not relay.
  if (A <= DUST_LIMIT_GRAINS) return zero;
  const tip = tipOf(A);
  const baseOutputs = tip > 0n ? 2 : 1;
  const leftover = S - cost(A);
  let fee = feeOf(tip);
  let change = 0n;
  if (leftover > 0n) {
    // Same rule composePearlSend applies: a change output only when it
    // is at least dust after paying for itself.
    const withChange = S - A - tip - estimateFee(k, baseOutputs + 1, feerate);
    if (withChange >= DUST_LIMIT_GRAINS) {
      change = withChange;
      fee = estimateFee(k, baseOutputs + 1, feerate);
    } else {
      fee += leftover;
    }
  }
  if (A + tip + fee + change !== S) throw new Error("E_MAX_INVARIANT");
  return {
    ...zero,
    amountGrains: A,
    tipGrains: tip,
    feeGrains: fee,
    changeGrains: change,
    inputs,
    inputGrains: S,
    exact: change === 0n,
  };
}


/** Caller-side helper that re-tries composePearlSend with the hard
 *  maximum walk depth. Use after catching an InsufficientFundsError
 *  whose `degraded` flag is true — gives the user one more shot at
 *  finding coins beyond the default cap before giving up. */
export async function composePearlSendDeepRetry(
  opts: ComposeOptions,
): Promise<ComposedPearlTx> {
  return composePearlSend({
    ...opts,
    cachedUtxos: undefined, // force live walk
    maxPages: MAX_UTXO_WALK_PAGES_HARD,
  });
}

export interface SendPearlResult {
  txid: string;
  composed: ComposedPearlTx;
}

/** Frozen preview the UI passes through to broadcast. v0.1.9 audit
 *  O2-H-1 ≡ M2-H-2 (sign-what-you-saw). */
export interface FrozenPearlTx {
  composed: ComposedPearlTx;
  composedAt: number;
}

/** Max age of a frozen preview before broadcast refuses.
 *  v0.3.1: bumped 30_000 → 120_000. The 30s window was too tight when
 *  a user paused to read the confirmation (especially on mobile),
 *  triggering E_PREVIEW_STALE and forcing them to re-confirm. 120s
 *  is still well inside any meaningful chain-reorg window — a hostile
 *  sentry can't swap our UTXO set out from under us in that span
 *  without us seeing it next walk. The UI shows a visible countdown
 *  and pre-empts staleness with a background re-quote at ~100s. */
export const PEARL_PREVIEW_FRESHNESS_MS = 120_000;

/** Background-refresh threshold. When a preview is older than this but
 *  still inside PEARL_PREVIEW_FRESHNESS_MS, the UI silently triggers a
 *  fresh compose so the user clicks Send against fresh coins. */
export const PEARL_PREVIEW_REFRESH_AT_MS = 100_000;

/** Addresses holding `utxos` (empty when any script isn't P2TR). */
export function inputAddresses(utxos: readonly { scriptHex: string }[]): string[] {
  const out = utxos.map((u) => p2trScriptAddress(u.scriptHex));
  return out.every((a): a is string => a !== null) ? [...new Set(out)] : [];
}

async function signAndBroadcast(
  composed: ComposedPearlTx,
  network: PearlNetwork,
  acknowledged: readonly string[] = [],
  /** Runs under the broadcast lock right before signing (may throw). */
  beforeSign: () => void = () => {},
): Promise<SendPearlResult> {
  const req: PearlTxRequest = {
    utxos: composed.utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueGrains: u.valueGrains.toString(),
      scriptHex: u.scriptHex,
      branch: u.branch,
      index: u.index,
    })),
    outputs: composed.outputs.map((o) => ({
      address: o.address,
      amountGrains: o.amountGrains.toString(),
    })),
    network,
    // The signer refuses a tx paying more than the fee the user reviewed.
    maxFeeGrains: composed.feeGrains.toString(),
  };
  const plan: BroadcastPlan = {
    kind: "payment",
    inputs: composed.utxos,
    addresses: inputAddresses(composed.utxos),
    destination: composed.outputs[0]?.address ?? null,
    amountGrains: composed.amountGrains,
    acknowledged,
  };
  const txid = await broadcastRecorded(plan, async () => {
    beforeSign();
    const { raw } = await cryptoWorker.call<"signPearlTx", { raw: string }>("signPearlTx", { req });
    return raw;
  });
  return { txid, composed };
}

/** Longest a signer may run while holding the broadcast lock. A crypto
 *  worker that hangs must not keep every tab from broadcasting until a
 *  reload; a signature that arrives later is discarded (never recorded or
 *  sent). */
export const SIGN_TIMEOUT_MS = 120_000;

async function signWithin(sign: () => Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("E_SIGN_TIMEOUT: signing didn't finish; nothing was sent. Reload the page and try again.")), SIGN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([sign(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one broadcast path for every Pearl spend (Send, consolidation,
 * offline, vault), all inside the wallet's broadcast lock
 * (services/pending-spends.ts):
 *   1. the gate — refused (nothing signed or sent) while another broadcast
 *      is "unknown" and not acknowledged, or if a coin is already spent by
 *      a recorded broadcast;
 *   2. sign (`tx` is a signer, given SIGN_TIMEOUT_MS, or the already-signed
 *      raw hex);
 *   3. record the tx as "unknown" — refused if that can't be saved;
 *   4. submit; then accepted → "accepted", status unknown → stays
 *      "unknown", definite rejection → the record this attempt made goes.
 * Holding the lock throughout means no other tab can release these coins
 * or broadcast until the outcome is saved, however long this tab stalls.
 */
export async function broadcastRecorded(plan: BroadcastPlan, tx: string | (() => Promise<string>)): Promise<string> {
  return withBroadcastLock(async () => {
    assertBroadcastAllowed(plan, typeof tx === "string" ? rawTxId(tx) : null);
    const raw = typeof tx === "string" ? tx : await signWithin(tx);
    const txid = rawTxId(raw);
    if (!txid) throw new Error("E_RAW_TX_PARSE: the signed transaction could not be decoded");
    const created = recordBroadcast(txid, plan);
    let outcome: "accepted" | "unknown" | "rejected" = "rejected";
    try {
      const sent = await broadcastPearlTx(raw);
      outcome = "accepted";
      return sent;
    } catch (e) {
      if (e instanceof BroadcastStatusUnknownError) outcome = "unknown";
      throw e;
    } finally {
      settleBroadcast(txid, outcome, created);
    }
  });
}

/**
 * Broadcasts a transaction signed elsewhere (offline signing, a vault).
 * Inputs, destination (outputs[0]) and amount are decoded from the raw tx
 * itself; a raw tx that can't be decoded is refused.
 */
export async function broadcastSignedPearlTx(
  raw: string,
  opts: { kind: "offline" | "vault"; addresses?: readonly string[] },
): Promise<string> {
  const inputs = rawTxInputs(raw);
  const outputs = rawTxOutputs(raw);
  if (!inputs || !outputs || !rawTxId(raw)) throw new Error("E_RAW_TX_PARSE: the signed transaction could not be decoded");
  return broadcastRecorded(
    {
      kind: opts.kind,
      inputs,
      addresses: opts.addresses,
      destination: outputs[0]?.address ?? null,
      amountGrains: outputs[0]?.amountGrains ?? null,
    },
    raw,
  );
}

/**
 * Sign + broadcast a Pearl tx the UI has already composed and shown the
 * user. Refuses to sign a preview older than PEARL_PREVIEW_FRESHNESS_MS
 * (checked on the click and again under the lock, just before signing)
 * so a long-delayed click can't capture a stale UTXO set (a hostile
 * sentry could have returned different coins on the second walk).
 */
export async function broadcastPearlPrecomposed(
  frozen: FrozenPearlTx,
  network: PearlNetwork,
  now: number = Date.now(),
  /** "unknown" broadcasts the user explicitly accepted may pay twice. */
  acknowledged: readonly string[] = [],
): Promise<SendPearlResult> {
  const stale = (t: number) => {
    if (t - frozen.composedAt > PEARL_PREVIEW_FRESHNESS_MS) throw new Error("E_PREVIEW_STALE");
  };
  stale(now);
  // Checked again at signing time: waiting for another tab's broadcast
  // (up to LOCK_WAIT_MS) must not stretch the preview's freshness.
  const skew = now - Date.now();
  return await signAndBroadcast(frozen.composed, network, acknowledged, () => stale(Date.now() + skew));
}

export async function sendPearl(opts: ComposeOptions): Promise<SendPearlResult> {
  const composed = await composePearlSend(opts);
  return await signAndBroadcast(composed, opts.network);
}

// Re-export for tests that need the constants.
export {
  PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE,
  PER_INPUT_VBYTES,
  PER_P2TR_OUTPUT_VBYTES,
  FIXED_OVERHEAD_VBYTES,
  DUST_LIMIT_GRAINS,
};
