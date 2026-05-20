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
import { fetchPrlBalanceGrains } from "./pearl-rpc";
import { fetchPrlPriceUsd } from "./prices";

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
}

async function fetchPoolBalances(pool: string[]): Promise<PoolWalkResult> {
  const grains: bigint[] = new Array(pool.length).fill(0n);
  let failures = 0;
  for (let i = 0; i < pool.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
    try {
      grains[i] = await fetchPrlBalanceGrains(pool[i]!);
    } catch {
      failures++;
    }
  }
  // If MORE than half the pool failed we treat the whole walk as a
  // bust — the visible balance would be too suspect to show.
  if (failures > pool.length / 2) throw new Error("pool walk failed");
  return { grains, failures };
}

export interface Balances {
  prl: bigint;        // grains (10^8), summed across the pool
  wprl: bigint;       // wei (10^18)
  prlUsd: number;
  wprlUsd: number;
  // "live" = full pool walked. "partial" = some pool addresses errored
  //   but at least half succeeded — sum is under-reported; UI must
  //   surface a warning so the user doesn't act on a low number.
  // "error" = whole walk failed.
  prlSource: "live" | "partial" | "error";
  wprlSource: "live" | "error";
  priceSource: "live" | "error";
}

export async function fetchBalances(
  pearlAddrs: string | string[],
  ethAddr: string,
): Promise<Balances> {
  const pool = Array.isArray(pearlAddrs) ? pearlAddrs : [pearlAddrs];

  let prl = 0n;
  let prlSource: Balances["prlSource"] = "live";
  try {
    const result = await fetchPoolBalances(pool);
    prl = result.grains.reduce((acc, g) => acc + g, 0n);
    if (result.failures > 0) prlSource = "partial";
  } catch {
    prlSource = "error";
  }

  let wprl = 0n;
  let wprlSource: Balances["wprlSource"] = "live";
  try {
    wprl = await readWprlBalance(ethAddr as `0x${string}`, "mainnet");
  } catch {
    wprlSource = "error";
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
    // WPRL is 1:1 wrapped PRL — same USD price.
    prlUsd: price,
    wprlUsd: price,
    prlSource,
    wprlSource,
    priceSource,
  };
}
