// Pearl L1 network params. Default HRPs follow docs/06 + Q2 in docs/11.
// Testnet HRP "tprl" is provisional; verify against Pearl chain spec before mainnet ship.

export type PearlNetwork = "mainnet" | "testnet";

export interface PearlNetworkParams {
  name: PearlNetwork;
  hrp: string;
  decimals: number;
  rpcUrl: string;
  rpcLabel: string;
  explorerUrl: string;
  // Network magic — provisional values pending Pearl spec confirmation.
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

export const PEARL_TESTNET: PearlNetworkParams = {
  name: "testnet",
  hrp: "tprl",
  decimals: 8,
  rpcUrl: "https://rpc-testnet.pearlwallet.xyz/",
  rpcLabel: "rpc-testnet.pearlwallet.xyz",
  explorerUrl: "https://testnet-explorer.pearlbridge.xyz",
  magic: 0x0b110907,
};

/**
 * Default network params. If a non-empty override is supplied (from
 * Settings → custom RPC), the rpcUrl + rpcLabel are replaced; all other
 * fields stay canonical so the address codec / explorer / magic don't
 * silently change when a user points at a third-party node.
 */
export function pearlParams(net: PearlNetwork, override?: string): PearlNetworkParams {
  const base = net === "mainnet" ? PEARL_MAINNET : PEARL_TESTNET;
  const trimmed = override?.trim();
  if (!trimmed) return base;
  return { ...base, rpcUrl: trimmed, rpcLabel: "custom" };
}
