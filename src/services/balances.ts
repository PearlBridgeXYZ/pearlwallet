// Balances service. Eth-side (WPRL) reads live from the WPRL ERC-20.
// Pearl-side (PRL) reads live from the configured sentry RPC via
// searchrawtransactions (UTXO walk). On RPC failure the UI surfaces
// `error` rather than showing a stale or fabricated value.

import { useUI } from "../state/ui-store";
import { readWprlBalance } from "./bridge";
import { fetchPrlBalanceGrains } from "./pearl-rpc";

export interface Balances {
  prl: bigint;        // grains (10^8)
  wprl: bigint;       // wei (10^18)
  prlUsd: number;
  wprlUsd: number;
  prlSource: "live" | "mock" | "error";
  wprlSource: "live" | "mock" | "error";
}

const MOCK_BALANCES: Pick<Balances, "prl" | "wprl" | "prlUsd" | "wprlUsd"> = {
  prl: 100_00000000n,
  wprl: 100_000000000000000000n,
  prlUsd: 6.20,
  wprlUsd: 6.15,
};

export async function fetchBalances(pearlAddr: string, ethAddr: string): Promise<Balances> {
  const mock = useUI.getState().mockMode;
  if (mock) {
    await new Promise((r) => setTimeout(r, 250));
    return {
      ...MOCK_BALANCES,
      prlSource: "mock",
      wprlSource: "mock",
    };
  }

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

  // USD prices: not wired yet — leave 0; UI hides USD col when missing.
  return {
    prl,
    wprl,
    prlUsd: 0,
    wprlUsd: 0,
    prlSource,
    wprlSource,
  };
}
