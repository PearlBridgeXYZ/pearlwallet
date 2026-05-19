// Pearl L1 network params. Default HRPs follow docs/06 + Q2 in docs/11.
// Testnet HRP "tprl" is provisional; verify against Pearl chain spec before mainnet ship.
export const PEARL_MAINNET = {
    name: "mainnet",
    hrp: "prl",
    decimals: 8,
    rpcUrl: "https://rpc.pearlwallet.xyz",
    explorerUrl: "https://explorer.pearl.example",
    magic: 0xd9b4bef9,
};
export const PEARL_TESTNET = {
    name: "testnet",
    hrp: "tprl",
    decimals: 8,
    rpcUrl: "https://testnet-rpc.pearlwallet.xyz",
    explorerUrl: "https://testnet-explorer.pearl.example",
    magic: 0x0b110907,
};
export function pearlParams(net) {
    return net === "mainnet" ? PEARL_MAINNET : PEARL_TESTNET;
}
