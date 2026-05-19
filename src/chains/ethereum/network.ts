import { mainnet, sepolia, type Chain } from "viem/chains";

export type EthNetwork = "mainnet" | "sepolia";

export function ethChain(net: EthNetwork): Chain {
  return net === "mainnet" ? mainnet : sepolia;
}

export const ETH_RPC_PRIMARY: Record<EthNetwork, string> = {
  mainnet: "https://ethereum-rpc.publicnode.com",
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
};

export const ETH_RPC_FALLBACK: Record<EthNetwork, string> = {
  mainnet: "https://eth.drpc.org",
  sepolia: "https://sepolia.drpc.org",
};

// WPRL contract addresses — TBD per docs/11 Q4. Placeholder zero until PearlBridge deployment lands.
export const WPRL_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0x0000000000000000000000000000000000000000",
  sepolia: "0x0000000000000000000000000000000000000000",
};

export const BRIDGE_ROUTER_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0x0000000000000000000000000000000000000000",
  sepolia: "0x0000000000000000000000000000000000000000",
};
