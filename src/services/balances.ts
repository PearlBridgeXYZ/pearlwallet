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
import { fetchPrlUtxos, type PrlUtxo } from "./pearl-rpc";
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

// Serialized pool walk with a 300ms inter-request gap. The public
// sentry behind rpc.pearlwallet.xyz is fronted by Cloudflare and rate
// limits burst traffic from a single IP at ~10 req/s. Strict
// serialization at ~3 req/s keeps us comfortably under the threshold.
// 20 zero-activity addresses (which return JSON-RPC code -5 quickly)
// finish in ~6s; once cached by react-query, only the 30s refetch
// repays that cost. To keep a single transient 503 from turning the
// whole balance into "error", we tolerate a per-address failure and
// surface the total as the sum of the addresses we DID see — the
// alternative (all-or-nothing) hides real funds when the sentry has
// even a tiny hiccup.
interface PoolWalkResult {
  grains: bigint[];
  failures: number;
  // `true` if ANY address in the pool returned a partial (page-cap-hit)
  // result. The total is still summed but under-reports — UI surfaces
  // a "partial" label so the user doesn't trust the visible balance.
  degraded: boolean;
  /** UTXO list aggregated across the pool, tagged with poolIndex.
   *  Surfaced so the wallet store can cache it; Send then opens the
   *  Preview instantly instead of repeating the ~6s pool walk. */
  utxos: PoolUtxoRecord[];
}

export interface PoolUtxoRecord extends PrlUtxo {
  poolIndex: number;
}

async function fetchPoolBalances(pool: string[]): Promise<PoolWalkResult> {
  const grains: bigint[] = new Array(pool.length).fill(0n);
  const utxos: PoolUtxoRecord[] = [];
  let failures = 0;
  let degraded = false;
  for (let i = 0; i < pool.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
    try {
      // v0.3.1: single unified walk. Same call Send uses — balance and
      // spendable can never diverge for any reason other than a UTXO
      // being spent between the two walks.
      const r = await fetchPrlUtxos(pool[i]!);
      let addrGrains = 0n;
      for (const u of r.utxos) {
        utxos.push({ ...u, poolIndex: i });
        addrGrains += u.valueGrains;
      }
      grains[i] = addrGrains;
      if (r.degraded || r.droppedNoScript > 0) degraded = true;
    } catch {
      failures++;
    }
  }
  // If MORE than half the pool failed we treat the whole walk as a
  // bust — the visible balance would be too suspect to show.
  if (failures > pool.length / 2) throw new Error("pool walk failed");
  return { grains, failures, degraded, utxos };
}

export interface Balances {
  prl: bigint;        // grains (10^8), summed across the pool
  wprl: bigint;       // wei (10^18)
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
  /** UTXO set returned by the pool walk, kept around so Send can skip
   *  its own walk and open Preview instantly. Empty array on walk
   *  failure ("error" source) — Send falls back to a live walk. */
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

export async function fetchBalances(
  pearlAddrs: string | string[],
  ethAddr: string,
  opts: FetchBalancesOpts = {},
): Promise<Balances> {
  const pool = Array.isArray(pearlAddrs) ? pearlAddrs : [pearlAddrs];
  const ethEnabled = opts.ethEnabled ?? true;

  let prl = 0n;
  let prlSource: Balances["prlSource"] = "live";
  let prlUtxos: PoolUtxoRecord[] = [];
  const prlUtxosFetchedAt = Date.now();
  try {
    const result = await fetchPoolBalances(pool);
    prl = result.grains.reduce((acc, g) => acc + g, 0n);
    prlUtxos = result.utxos;
    // Either a per-address failure OR a page-cap hit makes the sum
    // a lower bound rather than a true balance — both surface as
    // "partial" so the UI can warn the user.
    if (result.failures > 0 || result.degraded) prlSource = "partial";
  } catch {
    prlSource = "error";
  }

  let wprl = 0n;
  let wprlSource: Balances["wprlSource"] = ethEnabled ? "live" : "off";
  if (ethEnabled) {
    try {
      wprl = await readWprlBalance(ethAddr as `0x${string}`, "mainnet");
    } catch {
      wprlSource = "error";
    }
  }

  let eth = 0n;
  let ethSource: Balances["ethSource"] = ethEnabled ? "live" : "off";
  if (ethEnabled) {
    try {
      eth = await fetchEthBalanceWei(ethAddr as `0x${string}`, "mainnet");
    } catch {
      ethSource = "error";
    }
  }

  let price = 0;
  let priceSource: Balances["priceSource"] = "live";
  try {
    price = await fetchPrlPriceUsd();
  } catch {
    priceSource = "error";
  }

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
