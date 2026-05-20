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
import { pearlParams } from "../chains/pearl/network";
import { useUI } from "../state/ui-store";
import { ethClient } from "../chains/ethereum/rpc";
import { WPRL_ADDRESS, type EthNetwork } from "../chains/ethereum/network";
import { MAX_RPC_PAGE_LENGTH, MAX_UTXO_WALK_PAGES } from "./pearl-rpc";

export type ActivityChain = "pearl" | "wprl";
export type ActivityDirection = "in" | "out";

export interface ActivityItem {
  chain: ActivityChain;
  txid: string;            // pearl txid or eth tx hash (no 0x for pearl, 0x for eth)
  direction: ActivityDirection;
  amount: bigint;          // pearl grains (10^8) OR wprl wei (10^18)
  // Unix seconds. 0 if unknown (rare — sentry returns `time` on most txs;
  // viem getBlock resolves Eth timestamps). Used purely for ordering;
  // the UI does not render absolute timestamps yet.
  timeSec: number;
  // For Pearl: best-effort counterparty (first non-pool vout address on
  // an "out" tx, first non-pool vin's referenced-output address on "in"
  // is harder to resolve so we leave it undefined). For WPRL: the other
  // party to the Transfer (from on "in", to on "out").
  counterparty?: string;
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
}

interface RawTx {
  txid: string;
  vin: RawTxVin[];
  vout: RawTxVout[];
  time?: number;       // unix seconds (some sentries omit on unconfirmed)
  blocktime?: number;
}

function rpcUrl(): string {
  const override = useUI.getState().pearlRpcOverride;
  return pearlParams("mainnet", override).rpcUrl;
}

// Sentry 5xx retry policy: mirror pearl-rpc.ts:call(). A pool walk fires
// many heavyweight searchrawtransactions calls in sequence; the public
// sentry has been observed to emit transient nginx-level 503s under
// concurrent load (measured 2026-05-20: 9/20 parallel calls 503'd). A
// single 503 on any pool address would otherwise flag the whole walk
// as "partial" and surface a "sentry errors on some addresses" warning
// to users with a perfectly healthy wallet. v0.1.14 hotfix.
const ACTIVITY_RPC_ATTEMPTS = 3;

async function searchrawtransactions(
  address: string,
  skip: number,
  count: number,
): Promise<RawTx[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < ACTIVITY_RPC_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "searchrawtransactions",
        params: [address, 1, skip, count],
        id: 1,
      }),
    });
    if (!res.ok) {
      lastErr = new Error(`rpc http ${res.status}`);
      if (res.status >= 500 && res.status < 600) continue;
      throw lastErr;
    }
    const body = (await res.json()) as {
      result: RawTx[] | null;
      error: { code: number; message: string } | null;
    };
    if (body.error) {
      if (body.error.message.includes("No information available about address")) {
        return [];
      }
      throw new Error(`rpc ${body.error.code}: ${body.error.message}`);
    }
    return body.result ?? [];
  }
  throw lastErr ?? new Error("rpc exhausted retries");
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

async function scanPearlActivity(pool: string[], limit: number): Promise<PearlWalkResult> {
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

  for (let i = 0; i < pool.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300));  // rate-limit cushion, mirrors balances.ts
    const addr = pool[i]!;
    try {
      let skip = 0;
      let pageCount = 0;
      let collectedFromAddr = 0;
      while (collectedFromAddr < PER_ADDR_MAX && pageCount < MAX_UTXO_WALK_PAGES) {
        let page: RawTx[];
        try {
          page = await searchrawtransactions(addr, skip, PAGE);
        } catch (err) {
          // Empty-address (-5) is caught inside; anything else propagates.
          throw err;
        }
        if (!page || page.length === 0) break;
        if (page.length > MAX_RPC_PAGE_LENGTH) {
          degraded = true;
          page = page.slice(0, MAX_RPC_PAGE_LENGTH);
        }
        collected.push(...page);
        collectedFromAddr += page.length;
        pageCount++;
        if (page.length < PAGE) break;
        skip += page.length;
      }
      if (pageCount >= MAX_UTXO_WALK_PAGES) degraded = true;
    } catch {
      failures++;
    }
  }

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

  // Pass 2: classify each unique txid.
  const byTxid = new Map<string, RawTx>();
  for (const tx of collected) {
    if (!byTxid.has(tx.txid)) byTxid.set(tx.txid, tx);
  }

  const items: ActivityItem[] = [];
  for (const tx of byTxid.values()) {
    let spendsOurs = false;
    for (const vin of tx.vin) {
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
        timeSec: tx.time ?? tx.blocktime ?? 0,
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
        timeSec: tx.time ?? tx.blocktime ?? 0,
      });
    }
  }

  // Most-recent first.
  items.sort((a, b) => b.timeSec - a.timeSec);

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
): Promise<WprlWalkResult> {
  const cfg = WPRL_ADDRESS[network];
  // The zero-address placeholder is what we ship for sepolia until WPRL
  // is deployed there. No point firing a useless getLogs against it.
  if (/^0x0+$/.test(cfg)) return { items: [], source: "live" };

  const client = ethClient(network);

  try {
    const head = await client.getBlockNumber();
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
      [outLogs, inLogs] = await scanOnce(fromBlockNarrow);
    }

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
  } catch {
    return { items: [], source: "error" };
  }
}

export async function fetchActivity(
  pearlPool: string[],
  ethAddr: `0x${string}` | undefined,
  network: EthNetwork = "mainnet",
  limit = 25,
): Promise<ActivityResult> {
  const [pearlResult, wprlResult] = await Promise.all([
    scanPearlActivity(pearlPool, limit),
    ethAddr ? scanWprlActivity(ethAddr, network, limit) : Promise.resolve({ items: [] as ActivityItem[], source: "live" as const }),
  ]);

  const merged = [...pearlResult.items, ...wprlResult.items];
  merged.sort((a, b) => b.timeSec - a.timeSec);

  return {
    items: merged.slice(0, limit),
    pearlSource: pearlResult.source,
    wprlSource: wprlResult.source,
  };
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

