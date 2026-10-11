// Recent activity scanner. Returns a unified list of recent transactions
// touching the wallet's Pearl pool and Eth WPRL address.
//
// Pearl: walks `searchrawtransactions` per pool address. Per-address page
// walk follows the same shape as services/balances.ts (a 100-tx page with
// pagination caps from pearl-rpc.ts). Each touched tx is classified by
// looking at whether any vin spends a UTXO we ever credited to one of
// our pool addresses (= "out") or whether vouts pay to our pool with no
// matching vin spend (= "in"). Amount is best-effort: for "in" it's the
// sum of vouts paying our pool; for "out" it's the sum of vouts paying
// non-pool addresses (i.e. value that left the pool; ignores change).
// True value-sent would need a getrawtransaction round-trip per vin to
// resolve prev-vout values — deferred to v0.1.14+.
//
// Eth WPRL: viem getLogs() against the WPRL ERC-20 Transfer event,
// filtered by `from = ethAddr` (out) and `to = ethAddr` (in). Native ETH
// transfers are NOT scanned — there's no efficient log-based filter for
// native value transfer; an indexer (Etherscan-style) is required. The
// Eth address is still linkable from the dashboard for users who want
// the full picture.
//
// Both walks fail soft. A sentry outage that nukes the Pearl scan still
// returns the WPRL portion; a getLogs error still returns the Pearl
// portion. The combined `sources` field on the result lets the UI label
// each side independently.

import { parseAbiItem } from "viem";
import { ethClient } from "../chains/ethereum/rpc";
import { WPRL_ADDRESS, type EthNetwork } from "../chains/ethereum/network";
import {
  MAX_RPC_PAGE_LENGTH,
  MAX_UTXO_WALK_PAGES,
  callPearlRpc,
  getFreshAddressHistory,
  pearlRpcTuning,
} from "./pearl-rpc";
import { mapWithConcurrency } from "./rpc-limiter";
import { memoryEpoch, onBalanceMemoryClear } from "../state/balance-memory";

export type ActivityChain = "pearl" | "wprl";
export type ActivityDirection = "in" | "out";

export interface ActivityItem {
  chain: ActivityChain;
  txid: string;            // pearl txid or eth tx hash (no 0x for pearl, 0x for eth)
  direction: ActivityDirection;
  amount: bigint;          // pearl grains (10^8) OR WPRL base units (10^8 — decimals()==8 on-chain, NOT 18)
  // Unix seconds. 0 if unknown (rare — sentry returns `time` on most txs;
  // viem getBlock resolves Eth timestamps). Used purely for ordering;
  // the UI does not render absolute timestamps yet.
  timeSec: number;
  // Pearl only: the transaction is not in a block yet (the node reports no
  // time and no blocktime for mempool transactions). Pending items sort
  // first — they are the newest thing the user did.
  pending?: boolean;
  // For Pearl: best-effort counterparty (first non-pool vout address on
  // an "out" tx, first non-pool vin's referenced-output address on "in"
  // is harder to resolve so we leave it undefined). For WPRL: the other
  // party to the Transfer (from on "in", to on "out").
  counterparty?: string;
}

/** Cancellation for an activity scan. */
export interface ActivityOptions {
  /** Aborts queued, backing-off and in-flight requests (react-query's
   *  query signal: cancelled on lock / wipe / wallet switch). */
  signal?: AbortSignal;
  /** Session epoch the scan belongs to (memoryEpoch() at its start by
   *  default). After a lock, wipe or wallet switch no further request of
   *  the scan starts and it rejects instead of returning a result. */
  epoch?: number;
}

const SESSION_CLEARED = "E_SESSION_CLEARED: the wallet session ended during this scan";

/** Throws when the scan was cancelled or its session ended. */
function checkCurrent(opts: { signal?: AbortSignal; epoch: number }): void {
  if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
  if (memoryEpoch() !== opts.epoch) throw new Error(SESSION_CLEARED);
}

export interface ActivityResult {
  items: ActivityItem[];
  pearlSource: "live" | "partial" | "error";
  wprlSource: "live" | "error";
}

interface RawTxVout {
  value: number;
  n: number;
  scriptPubKey: {
    address?: string;
    addresses?: string[];
  };
}

interface RawTxVin {
  txid?: string;
  vout?: number;
  // Present when searchrawtransactions is called with vinextra=1: the
  // spent output's address(es) and value. Lets us classify "out" even when
  // the funding tx is older than the scanned (newest-first) window.
  prevOut?: {
    addresses?: string[];
    value?: number;
  };
}

interface RawTx {
  txid: string;
  vin: RawTxVin[];
  vout: RawTxVout[];
  time?: number;       // unix seconds (some sentries omit on unconfirmed)
  blocktime?: number;
}

/** Ordering time and pending flag of a Pearl tx. The sentry omits both
 *  `time` and `blocktime` for a transaction still in the mempool. */
function pearlTxTiming(tx: RawTx): { timeSec: number; pending?: true } {
  const timeSec = tx.time ?? tx.blocktime ?? 0;
  return timeSec > 0 ? { timeSec } : { timeSec: 0, pending: true };
}

/**
 * Activity order: pending (unconfirmed) first, newest of those first;
 * then confirmed items newest first; items whose time could not be
 * resolved (e.g. a failed Ethereum block lookup) last.
 */
export function compareActivity(a: ActivityItem, b: ActivityItem): number {
  const pa = a.pending ? 1 : 0;
  const pb = b.pending ? 1 : 0;
  if (pa !== pb) return pb - pa;
  return b.timeSec - a.timeSec;
}

// v0.7: activity goes through the SAME Pearl RPC client as the balance
// walk and Send (services/pearl-rpc.ts callPearlRpc): same endpoint pool
// and override handling, same per-request timeout, same backoff/retry on
// 503/429, and — crucially — the same shared token bucket. Activity asks
// for the "low" lane, so while the balance scan is running its requests
// are served first and the two scans can no longer race each other into
// the origin's rate limit.
//
// btcd signature: searchrawtransactions address verbose skip count
// vinextra reverse filteraddrs. We request verbose=1, vinextra=1 (prevOut
// data for classification) and reverse=true (NEWEST first — without it
// the first page is the address's oldest history, verified live
// 2026-10-07).
/** How old a balance-walk history may be and still stand in for an
 *  activity fetch (balances refetch every 60 s on the dashboard). */
const HISTORY_REUSE_MAX_AGE_MS = 90_000;

async function searchrawtransactions(
  address: string,
  skip: number,
  count: number,
  signal?: AbortSignal,
): Promise<RawTx[]> {
  try {
    const r = await callPearlRpc<RawTx[]>(
      "searchrawtransactions",
      [address, 1, skip, count, 1, true],
      { priority: "low", signal },
    );
    return r ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No information available about address")) return [];
    throw err;
  }
}

function voutPaysAnyOf(vout: RawTxVout, addresses: Set<string>): string | null {
  if (vout.scriptPubKey.address && addresses.has(vout.scriptPubKey.address)) {
    return vout.scriptPubKey.address;
  }
  if (Array.isArray(vout.scriptPubKey.addresses)) {
    for (const a of vout.scriptPubKey.addresses) {
      if (addresses.has(a)) return a;
    }
  }
  return null;
}

function firstNonPoolAddress(vout: RawTxVout, pool: Set<string>): string | undefined {
  if (vout.scriptPubKey.address && !pool.has(vout.scriptPubKey.address)) {
    return vout.scriptPubKey.address;
  }
  if (Array.isArray(vout.scriptPubKey.addresses)) {
    for (const a of vout.scriptPubKey.addresses) {
      if (!pool.has(a)) return a;
    }
  }
  return undefined;
}

// Same value-conversion guard as pearl-rpc.ts. Rejecting NaN/Infinity/
// negative protects the activity walk from a single bad vout poisoning
// the running totals or crashing toFixed.
function prlToGrains(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("E_INVALID_RPC_VALUE");
  }
  const [whole, frac = ""] = value.toFixed(8).split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole) * 100_000_000n + BigInt(fracPadded);
}

interface PearlWalkResult {
  items: ActivityItem[];
  source: "live" | "partial" | "error";
}

async function scanPearlActivity(
  pool: string[],
  limit: number,
  cur: { signal?: AbortSignal; epoch: number },
): Promise<PearlWalkResult> {
  if (pool.length === 0) return { items: [], source: "live" };

  const poolSet = new Set(pool);
  const PAGE = 100;
  const PER_ADDR_MAX = limit * 2;  // small heuristic — gather more than we need so we can dedupe and sort.

  // We have to walk every pool address. Across the pool we may see the
  // same tx multiple times (an outgoing tx that spends from 2 pool
  // addresses produces one tx but appears in both address histories).
  // We dedupe by txid at the end.
  //
  // To classify a tx as "out" vs "in", we need to know whether the tx's
  // vins are spending UTXOs we ever owned. We do TWO passes over the
  // collected txs:
  //   Pass 1: collect every (txid:vout) → address mapping where that
  //           vout pays a pool address. This is our "ever-owned UTXOs"
  //           set. (We don't care if it's been spent yet; we only need
  //           to know if it was ours to begin with.)
  //   Pass 2: for each tx, if any vin matches a key in the
  //           ever-owned set, the tx spends our funds = "out". Otherwise
  //           if any vout pays our pool = "in". (Both = "out" — change
  //           output from a send to ourselves.)
  const collected: RawTx[] = [];
  let failures = 0;
  let degraded = false;

  // Pages come back newest-first, so the first PER_ADDR_MAX entries of
  // each address ARE its most recent history. Pacing is the shared token
  // bucket (no fixed sleeps); a few addresses run in parallel.
  const perAddr = await mapWithConcurrency(pool, pearlRpcTuning().scanConcurrency, async (addr) => {
    // A cancelled scan or an ended session starts no further address.
    checkCurrent(cur);
    // Shared scan: if a recent balance walk already saw this address's
    // complete history (one short page, or no history), reuse it instead
    // of spending another request against the ~1 req/s origin budget.
    const known = getFreshAddressHistory(addr, HISTORY_REUSE_MAX_AGE_MS);
    if (known) return known.txs as RawTx[];
    const txs: RawTx[] = [];
    try {
      let skip = 0;
      let pageCount = 0;
      while (txs.length < PER_ADDR_MAX && pageCount < MAX_UTXO_WALK_PAGES) {
        const want = Math.min(PAGE, PER_ADDR_MAX - txs.length);
        // Empty-address (-5) is mapped to [] inside; anything else
        // propagates (after the client's own backoff/retry).
        checkCurrent(cur);
        let page = await searchrawtransactions(addr, skip, want, cur.signal);
        if (!page || page.length === 0) break;
        if (page.length > MAX_RPC_PAGE_LENGTH) {
          degraded = true;
          page = page.slice(0, MAX_RPC_PAGE_LENGTH);
        }
        txs.push(...page);
        pageCount++;
        if (page.length < want) break;
        skip += page.length;
      }
      if (pageCount >= MAX_UTXO_WALK_PAGES) degraded = true;
      return txs;
    } catch (err) {
      // Cancellation and an ended session end the whole scan; only a
      // genuine read failure counts against this address.
      if (cur.signal?.aborted || memoryEpoch() !== cur.epoch) throw err;
      failures++;
      return null;
    }
  });
  for (const txs of perAddr) if (txs) collected.push(...txs);

  if (failures > pool.length / 2) return { items: [], source: "error" };

  // Pass 1: build ever-owned key set.
  const owned = new Set<string>();
  for (const tx of collected) {
    for (const vout of tx.vout) {
      if (voutPaysAnyOf(vout, poolSet)) {
        owned.add(`${tx.txid}:${vout.n}`);
      }
    }
  }

  // prevOut evidence (vinextra=1) merged across every copy of a txid: a
  // copy reused from the balance walk's history carries none, so keeping
  // only the first copy could turn a payment into "Received".
  const spendsPoolPrevOut = new Set<string>();
  for (const tx of collected) {
    if (tx.vin.some((vin) => vin.prevOut?.addresses?.some((a) => poolSet.has(a)))) spendsPoolPrevOut.add(tx.txid);
  }

  // Pass 2: classify each unique txid.
  const byTxid = new Map<string, RawTx>();
  for (const tx of collected) {
    if (!byTxid.has(tx.txid)) byTxid.set(tx.txid, tx);
  }

  const items: ActivityItem[] = [];
  for (const tx of byTxid.values()) {
    let spendsOurs = spendsPoolPrevOut.has(tx.txid);
    for (const vin of spendsOurs ? [] : tx.vin) {
      // Preferred: prevOut data (vinextra=1) names the spent output's
      // owner directly, even when the funding tx is outside the window.
      if (vin.prevOut?.addresses?.some((a) => poolSet.has(a))) {
        spendsOurs = true;
        break;
      }
      if (vin.txid === undefined || vin.vout === undefined) continue;
      if (owned.has(`${vin.txid}:${vin.vout}`)) {
        spendsOurs = true;
        break;
      }
    }

    if (spendsOurs) {
      // "out": value that left the pool is sum of vouts paying non-pool
      // addresses. Internal pool→pool moves (change) are not included.
      let leaving = 0n;
      let counterparty: string | undefined;
      for (const vout of tx.vout) {
        if (voutPaysAnyOf(vout, poolSet)) continue;
        try {
          leaving += prlToGrains(vout.value);
        } catch { /* bad value — skip this vout, don't crash the whole tx */ }
        if (!counterparty) counterparty = firstNonPoolAddress(vout, poolSet);
      }
      // A self-spend (all outputs to our own pool) has leaving=0. Skip
      // it from the activity list — it's not interesting to the user
      // (consolidation / pool rebalancing).
      if (leaving === 0n) continue;
      items.push({
        chain: "pearl",
        txid: tx.txid,
        direction: "out",
        amount: leaving,
        ...pearlTxTiming(tx),
        counterparty,
      });
    } else {
      // "in": vouts paying our pool.
      let received = 0n;
      for (const vout of tx.vout) {
        if (!voutPaysAnyOf(vout, poolSet)) continue;
        try {
          received += prlToGrains(vout.value);
        } catch { /* skip bad vout */ }
      }
      if (received === 0n) continue;
      items.push({
        chain: "pearl",
        txid: tx.txid,
        direction: "in",
        amount: received,
        ...pearlTxTiming(tx),
      });
    }
  }

  // Pending first, then most-recent first.
  items.sort(compareActivity);

  return {
    items,
    source: failures > 0 || degraded ? "partial" : "live",
  };
}

// WPRL ERC-20 Transfer scanning. We use a bounded recent-blocks window
// (~14 days at 12s blocks). Public RPCs cap getLogs ranges — a hard
// failure on the wide range falls back to a narrow recent window so the
// UI doesn't go fully blank on a slightly less-tolerant provider.
const WPRL_LOG_WINDOW_BLOCKS = 100_000n;
const WPRL_LOG_FALLBACK_BLOCKS = 5_000n;
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

interface WprlWalkResult {
  items: ActivityItem[];
  source: "live" | "error";
}

async function scanWprlActivity(
  ethAddr: `0x${string}`,
  network: EthNetwork,
  limit: number,
  cur: { signal?: AbortSignal; epoch: number },
): Promise<WprlWalkResult> {
  const cfg = WPRL_ADDRESS[network];
  // The zero-address placeholder is what we ship for sepolia until WPRL
  // is deployed there. No point firing a useless getLogs against it.
  if (/^0x0+$/.test(cfg)) return { items: [], source: "live" };

  // The scan's own cancellation reaches into viem: once cur.signal aborts
  // no further request (retry or fallback hop included) leaves this
  // client, so the former wallet's address stops appearing in filters.
  const client = ethClient(network, { signal: cur.signal });

  checkCurrent(cur);
  try {
    const head = await client.getBlockNumber();
    checkCurrent(cur);
    const fromBlockWide = head > WPRL_LOG_WINDOW_BLOCKS
      ? head - WPRL_LOG_WINDOW_BLOCKS
      : 0n;
    const fromBlockNarrow = head > WPRL_LOG_FALLBACK_BLOCKS
      ? head - WPRL_LOG_FALLBACK_BLOCKS
      : 0n;

    const scanOnce = (fromBlock: bigint) => Promise.all([
      client.getLogs({
        address: cfg,
        event: TRANSFER_EVENT,
        args: { from: ethAddr },
        fromBlock,
        toBlock: head,
      }),
      client.getLogs({
        address: cfg,
        event: TRANSFER_EVENT,
        args: { to: ethAddr },
        fromBlock,
        toBlock: head,
      }),
    ]);

    let outLogs: Awaited<ReturnType<typeof scanOnce>>[0];
    let inLogs: Awaited<ReturnType<typeof scanOnce>>[1];
    try {
      [outLogs, inLogs] = await scanOnce(fromBlockWide);
    } catch {
      checkCurrent(cur);
      [outLogs, inLogs] = await scanOnce(fromBlockNarrow);
    }
    checkCurrent(cur);

    // Merge + dedupe by transaction hash. A user transferring to
    // themselves shows up in both queries with the same tx hash; we
    // collapse it to a single "out" item (the user-perceived direction).
    const byHash = new Map<string, ActivityItem>();

    const ingest = (log: typeof outLogs[number], direction: ActivityDirection) => {
      if (!log.transactionHash) return;
      const args = log.args;
      const value = args.value ?? 0n;
      const counterparty = direction === "out" ? args.to : args.from;
      const existing = byHash.get(log.transactionHash);
      if (existing) {
        // Prefer "out" — that's the cause from the user's perspective.
        if (existing.direction === "in" && direction === "out") {
          existing.direction = "out";
          existing.counterparty = counterparty;
        }
        return;
      }
      byHash.set(log.transactionHash, {
        chain: "wprl",
        txid: log.transactionHash,
        direction,
        amount: value,
        timeSec: 0,  // filled below
        counterparty,
      });
    };

    for (const l of outLogs) ingest(l, "out");
    for (const l of inLogs) ingest(l, "in");

    const items = [...byHash.values()];

    // Resolve block timestamps for ordering. Limit to `limit` items —
    // viem getBlock is one RPC each, and the most-recent block numbers
    // give us a stable enough ordering. Fetch in parallel; failures
    // leave timeSec=0 (will sort to the bottom).
    //
    // To avoid hammering the RPC for old logs we don't display, sort by
    // block number (which IS on every log) first and trim to `limit`.
    const itemBlocks = new Map<string, bigint>();
    const allLogs = [...outLogs, ...inLogs];
    for (const l of allLogs) {
      if (l.transactionHash && l.blockNumber !== null && l.blockNumber !== undefined) {
        const cur = itemBlocks.get(l.transactionHash);
        if (cur === undefined || cur < l.blockNumber) {
          itemBlocks.set(l.transactionHash, l.blockNumber);
        }
      }
    }
    items.sort((a, b) => {
      const ba = itemBlocks.get(a.txid) ?? 0n;
      const bb = itemBlocks.get(b.txid) ?? 0n;
      if (ba === bb) return 0;
      return ba < bb ? 1 : -1;
    });
    const trimmed = items.slice(0, limit);

    checkCurrent(cur);
    await Promise.all(trimmed.map(async (it) => {
      const bn = itemBlocks.get(it.txid);
      if (bn === undefined) return;
      try {
        const block = await client.getBlock({ blockNumber: bn });
        it.timeSec = Number(block.timestamp);
      } catch {
        /* leave timeSec=0 */
      }
    }));

    return { items: trimmed, source: "live" };
  } catch (err) {
    // A cancelled scan surfaces its abort reason / E_SESSION_CLEARED, not
    // the viem HttpRequestError the cancellation guard produced.
    checkCurrent(cur);
    return { items: [], source: "error" };
  }
}

export async function fetchActivity(
  pearlPool: string[],
  ethAddr: `0x${string}` | undefined,
  network: EthNetwork = "mainnet",
  limit = 25,
  opts: ActivityOptions = {},
): Promise<ActivityResult> {
  // One controller per scan: it follows the caller's signal AND the
  // balance-memory clear (lock / wipe / wallet switch), so both the Pearl
  // transport and the viem client always see a signal — also in the
  // epoch-only case where the caller passed none.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  if (opts.signal?.aborted) ctrl.abort(opts.signal.reason);
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const off = onBalanceMemoryClear(() => ctrl.abort(new Error(SESSION_CLEARED)));
  const cur = { signal: ctrl.signal, epoch: opts.epoch ?? memoryEpoch() };
  try {
    let pearlResult: Awaited<ReturnType<typeof scanPearlActivity>>;
    let wprlResult: WprlWalkResult;
    try {
      [pearlResult, wprlResult] = await Promise.all([
        scanPearlActivity(pearlPool, limit, cur),
        ethAddr ? scanWprlActivity(ethAddr, network, limit, cur) : Promise.resolve({ items: [] as ActivityItem[], source: "live" as const }),
      ]);
    } catch (err) {
      // A cancelled scan always rejects with the cancellation reason (the
      // caller's abort reason or E_SESSION_CLEARED), whichever transport
      // noticed first: the Pearl fetch aborts with a bare DOMException and
      // the viem guard with an HttpRequestError.
      if (ctrl.signal.aborted) throw ctrl.signal.reason;
      throw err;
    }
    // A result from an ended session is never handed back.
    checkCurrent(cur);

    const merged = [...pearlResult.items, ...wprlResult.items];
    merged.sort(compareActivity);

    return {
      items: merged.slice(0, limit),
      pearlSource: pearlResult.source,
      wprlSource: wprlResult.source,
    };
  } finally {
    off();
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// Re-exported for test ergonomics. The real implementation reaches into
// the sentry RPC and viem; tests assemble its inputs by mocking the
// transport layer (see tests/activity.test.ts).
export const __internal = {
  prlToGrains,
  voutPaysAnyOf,
  firstNonPoolAddress,
  WPRL_LOG_WINDOW_BLOCKS,
  WPRL_LOG_FALLBACK_BLOCKS,
};

