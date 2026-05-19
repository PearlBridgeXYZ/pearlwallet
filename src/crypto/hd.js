import { HDKey } from "@scure/bip32";
// Per docs/06 + docs/11 Q1: default to BTC coin type (0') for Pearl until SLIP-44
// assigns Pearl its own number. Eth is 60' (standard).
export const PEARL_COIN_TYPE = 0;
export const ETH_COIN_TYPE = 60;
// BIP-86 (Taproot) for Pearl, BIP-44 for Eth.
export const DEFAULT_PEARL_PATH = `m/86'/${PEARL_COIN_TYPE}'/0'/0/0`;
export const DEFAULT_ETH_PATH = `m/44'/${ETH_COIN_TYPE}'/0'/0/0`;
export function masterFromSeed(seed) {
    return HDKey.fromMasterSeed(seed);
}
export function derive(master, path) {
    return master.derive(path);
}
export function childKeys(master, path) {
    const node = master.derive(path);
    if (!node.privateKey || !node.publicKey) {
        throw new Error("HD derivation produced empty key material");
    }
    return {
        privateKey: node.privateKey,
        publicKey: node.publicKey,
    };
}
