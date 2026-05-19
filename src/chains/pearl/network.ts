// Pearl L1 network params. Default HRPs follow docs/06 + Q2 in docs/11.
// Testnet HRP "tprl" is provisional; verify against Pearl chain spec before mainnet ship.

export type PearlNetwork = "mainnet" | "testnet";

export interface PearlNetworkParams {
  name: PearlNetwork;
  hrp: string;
  decimals: number;
  rpcUrl: string;
  explorerUrl: string;
  // Network magic — provisional values pending Pearl spec confirmation.
  magic: number;
}

export const PEARL_MAINNET: PearlNetworkParams = {
  name: "mainnet",
  hrp: "prl",
  decimals: 8,
  rpcUrl: "https://rpc.pearlwallet.xyz",
  explorerUrl: "https://explorer.pearl.example",
  magic: 0xd9b4bef9,
};

export const PEARL_TESTNET: PearlNetworkParams = {
  name: "testnet",
  hrp: "tprl",
  decimals: 8,
  rpcUrl: "https://testnet-rpc.pearlwallet.xyz",
  explorerUrl: "https://testnet-explorer.pearl.example",
  magic: 0x0b110907,
};

export function pearlParams(net: PearlNetwork): PearlNetworkParams {
  return net === "mainnet" ? PEARL_MAINNET : PEARL_TESTNET;
}
