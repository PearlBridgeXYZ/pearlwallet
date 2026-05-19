import { mainnet, sepolia } from "viem/chains";
export function ethChain(net) {
    return net === "mainnet" ? mainnet : sepolia;
}
export const ETH_RPC_PRIMARY = {
    mainnet: "https://ethereum-rpc.publicnode.com",
    sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
};
export const ETH_RPC_FALLBACK = {
    mainnet: "https://eth.drpc.org",
    sepolia: "https://sepolia.drpc.org",
};
// WPRL contract addresses — TBD per docs/11 Q4. Placeholder zero until PearlBridge deployment lands.
export const WPRL_ADDRESS = {
    mainnet: "0x0000000000000000000000000000000000000000",
    sepolia: "0x0000000000000000000000000000000000000000",
};
export const BRIDGE_ROUTER_ADDRESS = {
    mainnet: "0x0000000000000000000000000000000000000000",
    sepolia: "0x0000000000000000000000000000000000000000",
};
