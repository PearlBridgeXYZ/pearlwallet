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
// Verified against PearlBridgeXYZ/frontend src/lib/contracts.ts on 2026-05-20.
// RC3 (0x5b2C/0xbE0D) and earlier are deprecated and dead. Wallet builds
// shipping RC3 will silently read 0 balance from the dead WPRL proxy and
// would broadcast mints to a deactivated controller — flagged Critical in
// the v0.1.5 audit and corrected here.
export const WPRL_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0x07696DcaB55E62cfef953666b29Fe1970518cB00",
  sepolia: "0x0000000000000000000000000000000000000000",
};

export const BRIDGE_ROUTER_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0xA6571B73489d4eBFA269a107208665dF7C80Aef5",
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

const ETH_EXPLORER_BASE: Record<EthNetwork, string> = {
  mainnet: "https://etherscan.io",
  sepolia: "https://sepolia.etherscan.io",
};

/** Public block-explorer URL for an Ethereum tx. */
export function ethTxExplorerUrl(net: EthNetwork, hash: string): string {
  return `${ETH_EXPLORER_BASE[net]}/tx/${hash}`;
}
