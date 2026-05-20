import { createPublicClient, http, fallback } from "viem";
import { ethChain, ETH_RPC_PRIMARY, ETH_RPC_FALLBACK, type EthNetwork } from "./network";
import { useUI, isAllowedEthRpcOverride } from "../../state/ui-store";

/**
 * Public ETH client. If a user-configured ETH RPC override is set in the
 * UI store, the override is preferred as the primary transport and the
 * built-in primary becomes the first fallback (with drpc still the
 * second). The override URL is allowlist-validated at the store
 * boundary, but we re-check here as a defence-in-depth: a future
 * persistence-shape regression must not silently turn into "user RPC
 * override points at attacker-controlled host".
 */
export function ethClient(net: EthNetwork) {
  const override = readEthRpcOverride();
  const transports = override
    ? [http(override), http(ETH_RPC_PRIMARY[net]), http(ETH_RPC_FALLBACK[net])]
    : [http(ETH_RPC_PRIMARY[net]), http(ETH_RPC_FALLBACK[net])];
  return createPublicClient({
    chain: ethChain(net),
    transport: fallback(transports, {
      rank: false,
      retryCount: 2,
    }),
  });
}

function readEthRpcOverride(): string | undefined {
  try {
    const ov = useUI.getState().ethRpcOverride;
    if (ov && isAllowedEthRpcOverride(ov)) return ov;
  } catch {
    // Store may not have hydrated yet (SSR/test environments without
    // localStorage); fall back to defaults silently.
  }
  return undefined;
}
