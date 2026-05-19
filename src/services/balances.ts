// Balances service. Eth-side (WPRL) reads live from the WPRL ERC-20.
// Pearl-side (PRL) reads live from the configured sentry RPC if reachable;
// otherwise returns 0 with `prlSource = "pending-sentry"` so the UI can
// surface "PRL balance loading via sentry RPC" rather than a stale mock.

import { useUI } from "../state/ui-store";
import { readWprlBalance } from "./bridge";

export interface Balances {
  prl: bigint;        // grains (10^8)
  wprl: bigint;       // wei (10^18)
  prlUsd: number;
  wprlUsd: number;
  prlSource: "live" | "mock" | "pending-sentry";
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

  // Pearl-side: TODO when sentry RPC allowlist proxy is provisioned.
  // For now, return 0 with `pending-sentry` so the UI shows the right state.
  const prl = 0n;
  const prlSource: Balances["prlSource"] = "pending-sentry";

  // Eth-side: real WPRL.balanceOf via viem.
  let wprl = 0n;
  let wprlSource: Balances["wprlSource"] = "live";
  try {
    wprl = await readWprlBalance(ethAddr as `0x${string}`, "mainnet");
  } catch {
    wprlSource = "error";
  }

  // USD prices: not wired yet — leave 0; UI hides USD col when missing.
  void pearlAddr; // suppress unused-arg lint until Pearl reads land
  return {
    prl,
    wprl,
    prlUsd: 0,
    wprlUsd: 0,
    prlSource,
    wprlSource,
  };
}
