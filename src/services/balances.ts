// Balances service. Eth-side (WPRL) reads live from the WPRL ERC-20.
// Pearl-side (PRL) reads live from the configured sentry RPC via
// searchrawtransactions (UTXO walk). On RPC failure the UI surfaces
// `error` rather than showing a stale or fabricated value.
//
// Pearl L1 is UTXO-based and an HD wallet may hold balances at any of its
// derived receive indexes (oyster advances the index per `getnewaddress`).
// So we accept a *pool* of pearl addresses and aggregate balances across
// all of them. The first address in the pool is the primary receive
// address that the UI displays; the rest let restored wallets discover
// funds that were sent to a non-zero index.

import { readWprlBalance } from "./bridge";
import { fetchPrlUtxos, pearlRpcTuning, type PrlUtxo } from "./pearl-rpc";
import { mapWithConcurrency } from "./rpc-limiter";
import { fetchPrlPriceUsd } from "./prices";
import { ethClient } from "../chains/ethereum/rpc";
import type { EthNetwork } from "../chains/ethereum/network";

/**
 * Native ETH balance in wei. Used for the gas-balance pre-check on the
 * WPRL send flow — a user with full WPRL but zero ETH can't pay gas.
 */
export async function fetchEthBalanceWei(
  addr: `0x${string}`,
  network: EthNetwork = "mainnet",
): Promise<bigint> {
  const client = ethClient(network);
  return await client.getBalance({ address: addr });
}

// Pool walk. v0.7: the ad-hoc 300 ms gap is gone — every request draws
// from the shared Pearl RPC token bucket (services/rpc-limiter.ts, tuned
// to the measured origin limit), so a small bounded number of addresses
// can be walked in parallel without tripping the origin's 503s. A busy
// page is retried with backoff inside the RPC client and the walk resumes
// where it stopped. To keep a single persistent failure from turning the
// whole balance into "error", we tolerate a per-address failure and
// surface the total as the sum of the addresses we DID see, labelled
// "partial" — the alternative (all-or-nothing) hides real funds.
interface PoolWalkResult {
  grains: bigint[];
  failures: number;
  // `true` if ANY address in the pool returned a partial (page-cap-hit)
  // result. The total is still summed but under-reports — UI surfaces
  // a "partial" label so the user doesn't trust the visible balance.
  degraded: boolean;
  /** UTXO list aggregated across the pool, tagged with poolIndex.
   *  Surfaced so the wallet store can cache it; Send then opens the
   *  Preview instantly instead of repeating the pool walk. */
  utxos: PoolUtxoRecord[];
}

export interface PoolUtxoRecord extends PrlUtxo {
  poolIndex: number;
}

/** Outcome of one pool address in a scan. */
export type PoolAddressResult =
  | { status: "ok"; grains: bigint; degraded: boolean; utxos: PrlUtxo[] }
  | { status: "error"; error: string };

export interface PrlPoolScanProgress {
  done: number;
  total: number;
  /** Index of the address that just finished. */
  index: number;
  result: PoolAddressResult;
}

/**
 * Result of ONE fresh walk of the whole pool. Never merged with earlier
 * scans — display-side keep-last-good lives in the UI hook, not here.
 */
export interface PrlPoolScan {
  pool: string[];
  perAddress: PoolAddressResult[];
  /** Sum over addresses that succeeded in THIS scan. */
  grains: bigint;
  failures: number;
  degraded: boolean;
  /** "live" = every address walked fully. "partial" = some failed (at
   *  most half) or hit a page cap. "error" = more than half failed. */
  source: "live" | "partial" | "error";
  /** Spendable set for Send. Present ONLY when this single scan was
   *  complete (no failures, no page-cap degradation). Partial / failed
   *  scans set it to null so Send performs its own live walk. */
  spendable: { utxos: PoolUtxoRecord[]; fetchedAt: number } | null;
  startedAt: number;
  finishedAt: number;
}

export interface ScanPrlPoolOptions {
  onProgress?: (p: PrlPoolScanProgress) => void;
  signal?: AbortSignal;
  /** Override parallelism (default: pearlRpcTuning().scanConcurrency). */
  concurrency?: number;
}

/**
 * Walks every pool address (bounded concurrency, shared rate limiter) and
 * reports per-address progress as each one finishes. Never throws for
 * per-address RPC failures — they are reported in `perAddress`/`source`.
 */
export async function scanPrlPool(pool: string[], opts: ScanPrlPoolOptions = {}): Promise<PrlPoolScan> {
  const startedAt = Date.now();
  let done = 0;
  const perAddress = await mapWithConcurrency(
    pool,
    opts.concurrency ?? pearlRpcTuning().scanConcurrency,
    async (addr, index): Promise<PoolAddressResult> => {
      let result: PoolAddressResult;
      try {
        // v0.3.1: single unified walk. Same call Send uses — balance and
        // spendable can never diverge for any reason other than a UTXO
        // being spent between the two walks.
        const r = await fetchPrlUtxos(addr, { signal: opts.signal, priority: "high" });
        let g = 0n;
        for (const u of r.utxos) g += u.valueGrains;
        result = { status: "ok", grains: g, degraded: r.degraded || r.droppedNoScript > 0, utxos: r.utxos };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        result = { status: "error", error: err instanceof Error ? err.message : String(err) };
      }
      done++;
      opts.onProgress?.({ done, total: pool.length, index, result });
      return result;
    },
  );

  let grains = 0n;
  let failures = 0;
  let degraded = false;
  const utxos: PoolUtxoRecord[] = [];
  perAddress.forEach((r, i) => {
    if (r.status === "error") {
      failures++;
      return;
    }
    grains += r.grains;
    if (r.degraded) degraded = true;
    for (const u of r.utxos) utxos.push({ ...u, poolIndex: i });
  });
  // If MORE than half the pool failed we treat the whole walk as a
  // bust — the visible balance would be too suspect to show.
  const source: PrlPoolScan["source"] =
    failures > pool.length / 2 ? "error" : failures > 0 || degraded ? "partial" : "live";
  const finishedAt = Date.now();
  return {
    pool: [...pool],
    perAddress,
    grains: source === "error" ? 0n : grains,
    failures,
    degraded,
    source,
    // fetchedAt = scan START (conservative: the oldest data in the set is
    // at most this old), so Send's freshness window is never overstated.
    spendable: source === "live" ? { utxos, fetchedAt: startedAt } : null,
    startedAt,
    finishedAt,
  };
}

async function fetchPoolBalances(pool: string[]): Promise<PoolWalkResult> {
  const scan = await scanPrlPool(pool);
  if (scan.source === "error") throw new Error("pool walk failed");
  const grains = scan.perAddress.map((r) => (r.status === "ok" ? r.grains : 0n));
  const utxos: PoolUtxoRecord[] = [];
  scan.perAddress.forEach((r, i) => {
    if (r.status === "ok") for (const u of r.utxos) utxos.push({ ...u, poolIndex: i });
  });
  return { grains, failures: scan.failures, degraded: scan.degraded, utxos };
}

/** WPRL ERC-20 balance (8 decimals) on Ethereum mainnet. */
export async function fetchWprlBalance(ethAddr: string): Promise<bigint> {
  return await readWprlBalance(ethAddr as `0x${string}`, "mainnet");
}

export interface Balances {
  prl: bigint;        // grains (10^8), summed across the pool
  wprl: bigint;       // WPRL base units (8 decimals)
  eth: bigint;        // wei — native gas balance for WPRL sends + ETH txs
  prlUsd: number;
  wprlUsd: number;
  // "live" = full pool walked. "partial" = some pool addresses errored
  //   but at least half succeeded — sum is under-reported; UI must
  //   surface a warning so the user doesn't act on a low number.
  // "error" = whole walk failed.
  prlSource: "live" | "partial" | "error";
  wprlSource: "live" | "error" | "off";
  ethSource: "live" | "error" | "off";
  priceSource: "live" | "error";
  /** UTXO set returned by the pool walk. Empty unless the walk was
   *  complete ("live") — partial/failed walks never expose a spendable
   *  set. (Send now reads the split scan query instead; see
   *  ui/hooks/useWalletBalances.ts.) */
  prlUtxos: PoolUtxoRecord[];
  /** Wall-clock timestamp the walk completed. Used by Send to decide
   *  whether the cache is fresh enough to use as-is. */
  prlUtxosFetchedAt: number;
}

export interface FetchBalancesOpts {
  /** v0.2.0: when the Ethereum surface is off in Settings the wallet
   *  must not even reach for the Eth RPC — saves network calls, avoids
   *  CSP-blocked requests showing up as errors in devtools, and keeps a
   *  Pearl-only user fully off-eth. The Eth/WPRL fields are returned as
   *  0n with `ethSource: "off"`/`wprlSource: "off"`. */
  ethEnabled?: boolean;
}

/**
 * Legacy all-in-one fetch (kept for callers/tests). v0.7: the four sources
 * now run in parallel instead of serially; the dashboard uses the split
 * queries in ui/hooks/useWalletBalances.ts instead.
 */
export async function fetchBalances(
  pearlAddrs: string | string[],
  ethAddr: string,
  opts: FetchBalancesOpts = {},
): Promise<Balances> {
  const pool = Array.isArray(pearlAddrs) ? pearlAddrs : [pearlAddrs];
  const ethEnabled = opts.ethEnabled ?? true;
  const prlUtxosFetchedAt = Date.now();

  const [prlR, wprlR, ethR, priceR] = await Promise.allSettled([
    fetchPoolBalances(pool),
    ethEnabled ? fetchWprlBalance(ethAddr) : Promise.resolve(0n),
    ethEnabled ? fetchEthBalanceWei(ethAddr as `0x${string}`, "mainnet") : Promise.resolve(0n),
    fetchPrlPriceUsd(),
  ]);

  let prl = 0n;
  let prlSource: Balances["prlSource"] = "live";
  let prlUtxos: PoolUtxoRecord[] = [];
  if (prlR.status === "fulfilled") {
    prl = prlR.value.grains.reduce((acc, g) => acc + g, 0n);
    prlUtxos = prlR.value.utxos;
    // Either a per-address failure OR a page-cap hit makes the sum
    // a lower bound rather than a true balance — both surface as
    // "partial" so the UI can warn the user.
    if (prlR.value.failures > 0 || prlR.value.degraded) prlSource = "partial";
    // Spendable UTXOs only from a complete scan; a partial one must never
    // be handed to Send as if it were the whole set.
    if (prlSource !== "live") prlUtxos = [];
  } else {
    prlSource = "error";
  }

  const wprl = wprlR.status === "fulfilled" ? wprlR.value : 0n;
  const wprlSource: Balances["wprlSource"] = !ethEnabled ? "off" : wprlR.status === "fulfilled" ? "live" : "error";
  const eth = ethR.status === "fulfilled" ? ethR.value : 0n;
  const ethSource: Balances["ethSource"] = !ethEnabled ? "off" : ethR.status === "fulfilled" ? "live" : "error";
  const price = priceR.status === "fulfilled" ? priceR.value : 0;
  const priceSource: Balances["priceSource"] = priceR.status === "fulfilled" ? "live" : "error";

  return {
    prl,
    wprl,
    eth,
    // WPRL is 1:1 wrapped PRL — same USD price.
    prlUsd: price,
    wprlUsd: price,
    prlSource,
    wprlSource,
    ethSource,
    priceSource,
    prlUtxos,
    prlUtxosFetchedAt,
  };
}
