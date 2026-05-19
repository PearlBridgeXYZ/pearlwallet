// Pearl L1 network params. Mainnet-only — Pearl has no testnet.

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
  return { ...PEARL_MAINNET, rpcUrl: trimmed, rpcLabel: "custom" };
}
