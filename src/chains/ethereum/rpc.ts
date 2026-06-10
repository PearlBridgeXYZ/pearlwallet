import { createPublicClient, http, fallback } from "viem";
import { ethChain, ETH_RPC_DEFAULTS, type EthNetwork } from "./network";
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
  const defaults = ETH_RPC_DEFAULTS[net];
  // Override (if set + allowlisted) goes first, then the full diversified
  // default chain as fallback. dedupe so an override that equals a default
  // doesn't appear twice.
  const urls = override ? [override, ...defaults.filter((u) => u !== override)] : [...defaults];
  return createPublicClient({
    chain: ethChain(net),
    transport: fallback(
      urls.map((u) => http(u)),
      { rank: false, retryCount: 2 },
    ),
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
