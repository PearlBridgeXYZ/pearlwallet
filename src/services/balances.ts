// Balances service. Eth-side (WPRL) reads live from the WPRL ERC-20.
// Pearl-side (PRL) reads live from the configured sentry RPC via
// searchrawtransactions (UTXO walk). On RPC failure the UI surfaces
// `error` rather than showing a stale or fabricated value.

import { readWprlBalance } from "./bridge";
import { fetchPrlBalanceGrains } from "./pearl-rpc";
import { fetchPrlPriceUsd } from "./prices";

export interface Balances {
  prl: bigint;        // grains (10^8)
  wprl: bigint;       // wei (10^18)
  prlUsd: number;
  wprlUsd: number;
  prlSource: "live" | "error";
  wprlSource: "live" | "error";
  priceSource: "live" | "error";
}

export async function fetchBalances(pearlAddr: string, ethAddr: string): Promise<Balances> {
  let prl = 0n;
  let prlSource: Balances["prlSource"] = "live";
  try {
    prl = await fetchPrlBalanceGrains(pearlAddr);
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
