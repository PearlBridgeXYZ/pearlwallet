// Pearl L1 network params. Mainnet-only — Pearl has no testnet.

import { isAllowedRpcOverride } from "../../state/ui-store";

export type PearlNetwork = "mainnet";

export interface PearlNetworkParams {
  name: PearlNetwork;
  hrp: string;
  decimals: number;
  rpcUrl: string;
  rpcLabel: string;
  explorerUrl: string;
  // Network magic — provisional value pending Pearl spec confirmation.
  magic: number;
}

// Default rpcUrl points at the PearlBridgeXYZ public sentry RPC, terminated
// behind Cloudflare (origin IP hidden). Origin is one of the outer Pearl
// sentries running a btcd JSON-RPC method-whitelist proxy. See
// docs/SENTRY-RPC-REQUIREMENTS.md for the public-RPC contract.
// Users can override via Settings → "Pearl RPC endpoint" (ui-store).
export const PEARL_MAINNET: PearlNetworkParams = {
  name: "mainnet",
  hrp: "prl",
  decimals: 8,
  rpcUrl: "https://rpc.pearlwallet.xyz/",
  rpcLabel: "rpc.pearlwallet.xyz",
  explorerUrl: "https://explorer.pearlbridge.xyz",
  magic: 0xd9b4bef9,
};

/**
 * Default network params. If a non-empty override is supplied (from
 * Settings → custom RPC), the rpcUrl + rpcLabel are replaced; all other
 * fields stay canonical so the address codec / explorer / magic don't
 * silently change when a user points at a third-party node.
 */
export function pearlParams(_net: PearlNetwork = "mainnet", override?: string): PearlNetworkParams {
  const trimmed = override?.trim();
  if (!trimmed) return PEARL_MAINNET;
  // v0.1.8 audit Opus2 H-2: the consumer (every rpcUrl() reader) cannot
  // assume the override was validated at write time. localStorage might
  // have been tampered with by a bookmarklet, the store's setter throw
  // might have been swallowed by a caller, or a stale value might have
  // been persisted by an older build before the allowlist existed.
  // Re-check at the boundary — if it's not allowed, silently fall back
  // to the canonical RPC. The store's load-time re-validation already
  // catches the persistent case but a transient in-memory override
  // (Settings page mid-edit) won't have gone through that path.
  if (!isAllowedRpcOverride(trimmed)) return PEARL_MAINNET;
  return { ...PEARL_MAINNET, rpcUrl: trimmed, rpcLabel: "custom" };
}
