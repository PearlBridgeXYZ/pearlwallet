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

// Default fallback chain (order matters: tried in sequence by viem
// `fallback`). Diversified across independent providers so one operator's
// outage doesn't blind the wallet — all verified live 2026-06-10. ENS
// resolution rides this same chain.
export const ETH_RPC_DEFAULTS: Record<EthNetwork, readonly string[]> = {
  // cloudflare-eth.com dropped from the automatic chain (2026-10-07): it
  // now answers JSON-RPC errors (-32603 / -32046) instead of data, which
  // only adds latency before viem reaches a working provider.
  mainnet: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
  ],
  sepolia: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.drpc.org",
  ],
};

// User-selectable RPC presets surfaced in Settings (G ask 2026-06-10:
// "MEW RPC or PublicNode"). ONLY browser-CORS-usable endpoints are listed —
// a preset that a browser can't actually reach is worse than no preset.
// MEW (nodes.mewapi.io) and LlamaNodes were evaluated and DROPPED: their
// public endpoints send no Access-Control-Allow-Origin, so a browser
// wallet gets a CORS failure regardless of our CSP. PublicNode (also named
// by G) is the default and works perfectly. Each host below is in the
// override allowlist (ui-store) and the CSP connect-src.
// v0.7: Cloudflare (cloudflare-eth.com) removed — it answers JSON-RPC
// errors (-32603 / -32046) instead of data. Its host stays on the
// override allowlist and in the CSP so an override saved by an older
// build keeps loading until the user picks another provider.
export interface EthRpcPreset {
  label: string;
  url: string;
}
export const ETH_RPC_PRESETS: readonly EthRpcPreset[] = [
  { label: "PublicNode (default)", url: "https://ethereum-rpc.publicnode.com" },
  { label: "dRPC", url: "https://eth.drpc.org" },
];

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
