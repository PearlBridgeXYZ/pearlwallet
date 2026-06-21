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

// Multisig pubkey derivation. We use a dedicated `account'` of 100 to
// keep multisig cosigner keys in a different subtree from the
// singlesig receive pool — sharing the pool would (a) collide with
// RECEIVE_GAP_LIMIT walks and (b) let an observer who saw one
// cosigner's vault membership link it back to their singlesig
// receive addresses. The {vaultAccount}'/{index} sub-path is a
// Sparrow-compatible shape: one hardened account per vault the
// user participates in, one index per cosigner-slot within that
// vault. This sub-path is *only* used as a cosigner pubkey export
// — the on-chain output is a tapscript m-of-n leaf, not a P2TR
// key-path spend of this child key.
export const PEARL_MULTISIG_ACCOUNT_PREFIX = 100;

export function pearlMultisigPath(vaultAccount: number, index: number): string {
  if (!Number.isInteger(vaultAccount) || vaultAccount < 0 || vaultAccount > 0x7fffffff) {
    throw new Error(`pearlMultisigPath: bad vaultAccount ${vaultAccount}`);
  }
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new Error(`pearlMultisigPath: bad index ${index}`);
  }
  return `m/86'/${PEARL_COIN_TYPE}'/${PEARL_MULTISIG_ACCOUNT_PREFIX}'/${vaultAccount}'/${index}`;
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

export interface MultisigSlotMatch {
  vaultAccount: number;
  keyIndex: number;
  /** Lowercase x-only (32-byte) pubkey hex at the matched slot. */
  pubkeyHex: string;
  originPath: string;
}

function xOnlyHex(compressedPubkey: Uint8Array): string {
  // Drop the 1-byte parity prefix → 32-byte x-only, lowercase hex.
  let out = "";
  for (let i = 1; i < compressedPubkey.length; i++) {
    out += compressedPubkey[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Scan the multisig cosigner slot grid (vaultAccount × keyIndex) for a key
 * whose x-only pubkey is in `targetPubkeysHex`, returning the first match
 * or null. Used by vault auto-import to prove local membership in a vault
 * recovered from a cosign request — no privkey leaves the caller.
 *
 * Pure over `master`; both the crypto worker and the test suite call it.
 */
export function findMultisigSlot(
  master: HDKey,
  targetPubkeysHex: ReadonlySet<string>,
  maxAccount: number,
  maxIndex: number,
): MultisigSlotMatch | null {
  for (let vaultAccount = 0; vaultAccount < maxAccount; vaultAccount++) {
    for (let keyIndex = 0; keyIndex < maxIndex; keyIndex++) {
      const path = pearlMultisigPath(vaultAccount, keyIndex);
      const child = master.derive(path);
      if (!child.publicKey) continue;
      const hex = xOnlyHex(child.publicKey);
      if (targetPubkeysHex.has(hex)) {
        return { vaultAccount, keyIndex, pubkeyHex: hex, originPath: path };
      }
    }
  }
  return null;
}
