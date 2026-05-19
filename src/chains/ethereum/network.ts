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

// PearlBridge RC5 mainnet — UUPS proxies; addresses survive impl upgrades.
// Source: PearlBridgeXYZ/frontend src/lib/contracts.ts (mainnet).
export const WPRL_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0xbE0DDDD4d064Ae941EA379b651fEF0317af5387e",
  sepolia: "0x0000000000000000000000000000000000000000",
};

export const BRIDGE_ROUTER_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0x5b2C49f1B253dFbD404CeEe2843979a977ba4009",
  sepolia: "0x0000000000000000000000000000000000000000",
};

export const PEARL_LOCK_ADDRESS: Record<EthNetwork, string> = {
  mainnet: "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs",
  sepolia: "",
};

export const RELAY_API_BASE: Record<EthNetwork, string> = {
  mainnet: "https://pearlbridge.xyz/api",
  sepolia: "https://pearlbridge.xyz/api",
};

// Per PearlBridge RC5 contracts.
export const MINT_FEE_BPS_DEFAULT = 50;  // 0.5% — verify at runtime via mintFeeBps()
export const BURN_FEE_BPS_DEFAULT = 0;   // 0%   — verify at runtime via burnFeeBps()
