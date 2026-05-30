// PRL send service. Aggregates UTXOs across the receive-address pool,
// picks coins, builds + signs + broadcasts the tx via the crypto worker
// and the sentry RPC.

import {
  fetchPrlUtxos,
  broadcastPearlTx,
  MAX_UTXO_WALK_PAGES_HARD,
  type PrlUtxo,
} from "./pearl-rpc";
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

export interface ComposedPearlTx {
  utxos: { txid: string; vout: number; valueGrains: bigint; scriptHex: string; poolIndex: number }[];
  outputs: { address: string; amountGrains: bigint }[];
  feeGrains: bigint;
  tipGrains: bigint;
  changeGrains: bigint;
  degraded: boolean;
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
  pool: string[]; // receive-pool addresses, ordered by index
  destination: string;
  amountGrains: bigint;
  /** Change is paid back to the pool's primary address (index 0). */
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
  /** Override walk depth. Caller bumps this on retry after a degraded
   *  walk produced E_INSUFFICIENT_FUNDS. Clamped server-side to
   *  MAX_UTXO_WALK_PAGES_HARD. */
  maxPages?: number;
}

function estimateFee(numInputs: number, numOutputs: number, feerate: bigint): bigint {
  const vbytes =
    FIXED_OVERHEAD_VBYTES +
    BigInt(numInputs) * PER_INPUT_VBYTES +
    BigInt(numOutputs) * PER_P2TR_OUTPUT_VBYTES;
  return vbytes * feerate;
}

export interface PoolUtxo extends PrlUtxo { poolIndex: number }

async function listPoolUtxos(
  pool: string[],
  opts: { maxPages?: number } = {},
): Promise<{ utxos: PoolUtxo[]; degraded: boolean }> {
  let degraded = false;
  const out: PoolUtxo[] = [];
  for (let i = 0; i < pool.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await fetchPrlUtxos(pool[i]!, { maxPages: opts.maxPages });
      if (r.degraded) degraded = true;
      for (const u of r.utxos) out.push({ ...u, poolIndex: i });
    } catch {
      // Mirror balances.ts tolerance — a single pool address being
      // unavailable shouldn't deny the user spending from the rest.
      degraded = true;
    }
  }
  // Largest-first selection is the simplest, lowest-input-count
  // strategy. We don't have on-chain confirmation height in the UTXO
  // walk so we can't filter unconfirmed; the sentry-side mempool view
  // already includes mempool transactions, which means we'll happily
  // spend a 1-conf input.
  out.sort((a, b) => (a.valueGrains > b.valueGrains ? -1 : a.valueGrains < b.valueGrains ? 1 : 0));
  return { utxos: out, degraded };
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

/**
 * Greedy coin selection. Adds UTXOs largest-first until total >= amount
 * + tip + estimated fee for the current input count. Re-estimates fee
 * on each input addition because adding a coin grows the tx.
 *
 * UTXO COMBINING: there's no per-tx input cap here — the loop walks
 * the entire pool's UTXO set largest-first and stacks coins until the
 * total covers amount + fee + tip. A 100k PRL send against a wallet
 * holding 500k PRL spread across many smaller UTXOs WILL combine
 * enough of them. If `cachedUtxos` covers the amount we use the cache
 * (fast path, no network); otherwise we walk the pool live with
 * `opts.maxPages` controlling depth. On a degraded walk that still
 * comes up short we throw an InsufficientFundsError that includes
 * the actual numbers — UI can offer a deeper-walk retry.
 */
export async function composePearlSend(opts: ComposeOptions): Promise<ComposedPearlTx> {
  const feerate = opts.feerateSatPerVbyte ?? PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE;

  // Decide whether to use the cache or do a live walk. The cache is a
  // hint: trust it if it covers the requested amount + a generous
  // worst-case fee headroom. If it doesn't, do a live walk anyway —
  // the cache may have been built with a smaller maxPages and the
  // user genuinely has more coins than the cache shows.
  let avail: PoolUtxo[] = [];
  let degraded = false;
  const cache = opts.cachedUtxos;
  const tipGrainsEarly = opts.includeTip ? computeTipGrains(opts.amountGrains) : 0n;
  const cacheCovers =
    !!cache &&
    cache.length > 0 &&
    sumGrains(cache) >=
      opts.amountGrains +
        tipGrainsEarly +
        // Worst-case fee headroom: cache might pick many small inputs.
        // Reserve fee for up to 100 inputs at the requested feerate —
        // if we genuinely need more than that, fall through to live.
        estimateFee(Math.min(cache.length, 100), 3, feerate);

  if (cacheCovers) {
    avail = [...cache!].sort((a, b) =>
      a.valueGrains > b.valueGrains ? -1 : a.valueGrains < b.valueGrains ? 1 : 0,
    );
  } else {
    const live = await listPoolUtxos(opts.pool, { maxPages: opts.maxPages });
    avail = live.utxos;
    degraded = live.degraded;
  }

  if (avail.length === 0) throw new Error("E_NO_UTXOS");

  const tipGrains = opts.includeTip ? computeTipGrains(opts.amountGrains) : 0n;
  // Output count: dest + optional tip + change (provisional — may
  // collapse if change ends up under dust).
  let numOutputs = opts.includeTip ? 3 : 2;
  const picked: PoolUtxo[] = [];
  let sum = 0n;
  for (const u of avail) {
    picked.push(u);
    sum += u.valueGrains;
    const fee = estimateFee(picked.length, numOutputs, feerate);
    const need = opts.amountGrains + tipGrains + fee;
    if (sum >= need) break;
  }
  let fee = estimateFee(picked.length, numOutputs, feerate);
  let need = opts.amountGrains + tipGrains + fee;
  const totalAvail = sumGrains(avail);
  if (sum < need) {
    throw new InsufficientFundsError(need, totalAvail, avail.length, degraded);
  }

  let change = sum - need;
  if (change < DUST_LIMIT_GRAINS) {
    // Drop the change output. Recompute fee for one fewer output and
    // donate the would-be change to the miners — cheaper than burning
    // a tx for a dust UTXO that can't be spent.
    numOutputs -= 1;
    fee = estimateFee(picked.length, numOutputs, feerate);
    need = opts.amountGrains + tipGrains + fee;
    if (sum < need) {
      throw new InsufficientFundsError(need, totalAvail, avail.length, degraded);
    }
    change = 0n;
  }

  const outputs: { address: string; amountGrains: bigint }[] = [
    { address: opts.destination, amountGrains: opts.amountGrains },
  ];
  if (opts.includeTip && tipGrains > 0n) {
    outputs.push({ address: tipAddressFor(opts.network), amountGrains: tipGrains });
  }
  if (change > 0n) {
    outputs.push({ address: opts.pool[0]!, amountGrains: change });
  }

  return {
    utxos: picked,
    outputs,
    feeGrains: fee,
    tipGrains,
    changeGrains: change,
    degraded,
    spendableGrains: totalAvail,
    spendableUtxoCount: avail.length,
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

async function signAndBroadcast(
  composed: ComposedPearlTx,
  network: PearlNetwork,
): Promise<SendPearlResult> {
  const req: PearlTxRequest = {
    utxos: composed.utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueGrains: u.valueGrains.toString(),
      scriptHex: u.scriptHex,
      poolIndex: u.poolIndex,
    })),
    outputs: composed.outputs.map((o) => ({
      address: o.address,
      amountGrains: o.amountGrains.toString(),
    })),
    network,
  };
  const { raw } = await cryptoWorker.call<"signPearlTx", { raw: string }>("signPearlTx", { req });
  const txid = await broadcastPearlTx(raw);
  return { txid, composed };
}

/**
 * Sign + broadcast a Pearl tx the UI has already composed and shown the
 * user. Refuses to sign a preview older than PEARL_PREVIEW_FRESHNESS_MS
 * so a long-delayed click can't capture a stale UTXO set (a hostile
 * sentry could have returned different coins on the second walk).
 */
export async function broadcastPearlPrecomposed(
  frozen: FrozenPearlTx,
  network: PearlNetwork,
  now: number = Date.now(),
): Promise<SendPearlResult> {
  if (now - frozen.composedAt > PEARL_PREVIEW_FRESHNESS_MS) {
    throw new Error("E_PREVIEW_STALE");
  }
  return await signAndBroadcast(frozen.composed, network);
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
