import { HDKey } from "@scure/bip32";

// Pearl L1 uses HDCoinType = 808276 (ASCII "PRL" packed), matching the
// btcd-oyster reference wallet (pearl-research-labs/pearl,
// node/chaincfg/params.go: MainNetParams.HDCoinType). Verified against
// oyster mainnet by deriving the BIP-39 vector 1 seed through both wallets
// and asserting bit-exact equality across the first five addresses. Eth is
// 60' (standard SLIP-44).
export const PEARL_COIN_TYPE = 808276;
export const ETH_COIN_TYPE = 60;

// BIP-86 (Taproot) for Pearl, BIP-44 for Eth.
export const DEFAULT_PEARL_PATH = `m/86'/${PEARL_COIN_TYPE}'/0'/0/0`;
export const DEFAULT_ETH_PATH = `m/44'/${ETH_COIN_TYPE}'/0'/0/0`;

// Number of external receive addresses to derive and track per wallet.
// Pearl L1 is UTXO-based: a user funding their wallet from oyster (or any
// HD wallet that advances the receive index per `getnewaddress` call) will
// hold balances across multiple addresses. Mirroring BIP-44's standard
// gap-limit convention, we derive RECEIVE_GAP_LIMIT external addresses on
// every create/restore/unlock and aggregate balances across all of them.
export const RECEIVE_GAP_LIMIT = 20;

export function pearlReceivePath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`pearlReceivePath: bad index ${index}`);
  }
  return `m/86'/${PEARL_COIN_TYPE}'/0'/0/${index}`;
}

export function masterFromSeed(seed: Uint8Array): HDKey {
  return HDKey.fromMasterSeed(seed);
}

export function derive(master: HDKey, path: string): HDKey {
  return master.derive(path);
}

export interface ChildKeys {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function childKeys(master: HDKey, path: string): ChildKeys {
  const node = master.derive(path);
  if (!node.privateKey || !node.publicKey) {
    throw new Error("HD derivation produced empty key material");
  }
  return {
    privateKey: node.privateKey,
    publicKey: node.publicKey,
  };
}
