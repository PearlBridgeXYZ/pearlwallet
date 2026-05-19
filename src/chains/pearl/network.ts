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

// rpcUrl points at a dedicated PearlBridge sentry. The sentry runs a btcd
// JSON-RPC allowlist proxy that exposes read methods + sendrawtransaction.
// Provisioning requirements: docs/SENTRY-RPC-REQUIREMENTS.md.
export const PEARL_MAINNET: PearlNetworkParams = {
  name: "mainnet",
  hrp: "prl",
  decimals: 8,
  rpcUrl: "https://pearl-sentry-fsn1-1.pearlbridge.xyz/rpc",
  rpcLabel: "pearl-sentry-fsn1-1",
  explorerUrl: "https://explorer.pearlbridge.xyz",
  magic: 0xd9b4bef9,
};

export const PEARL_TESTNET: PearlNetworkParams = {
  name: "testnet",
  hrp: "tprl",
  decimals: 8,
  rpcUrl: "https://pearl-sentry-testnet.pearlbridge.xyz/rpc",
  rpcLabel: "pearl-sentry-testnet",
  explorerUrl: "https://testnet-explorer.pearlbridge.xyz",
  magic: 0x0b110907,
};

export function pearlParams(net: PearlNetwork): PearlNetworkParams {
  return net === "mainnet" ? PEARL_MAINNET : PEARL_TESTNET;
}
