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

// Initial address window per branch, and the BIP-44 gap limit. Pearl L1
// is UTXO-based: a user funding their wallet from oyster (or any HD wallet
// that advances the receive index per `getnewaddress` call) will hold
// balances across multiple addresses. We derive RECEIVE_GAP_LIMIT
// addresses per branch on create/restore (more on unlock if discovery
// previously found more) and services/discovery.ts extends each branch
// until RECEIVE_GAP_LIMIT consecutive addresses are unused.
export const RECEIVE_GAP_LIMIT = 20;

export function pearlReceivePath(index: number): string {
  return pearlBranchPath(PEARL_EXTERNAL_BRANCH, index);
}

// ─── BIP-86 account branches (v0.7 address discovery) ────────────────────
//
// BIP-44-style chains under the single-sig account m/86'/808276'/0':
//   branch 0 = external (receive addresses shown to payers)
//   branch 1 = internal (change). The Pearl reference wallet (oyster, and
//              the desktop wallet built on it) pays change to branch 1, so a
//              seed that has ever sent PRL from there holds coins at
//              m/86'/808276'/0'/1/i. Both branches are plain BIP-86 P2TR.
//
// Discovery (services/discovery.ts) walks each branch until
// DISCOVERY_GAP_LIMIT consecutive addresses have no history, never past
// MAX_ADDRESSES_PER_BRANCH.
//
// KNOWN GAP (not emulated): btcutil hdkeychain issue #172. Oyster derives
// the hardened purpose'/coin'/account' levels with DeriveNonStandard, which
// for the ~2/256 of seeds where an intermediate private key has a leading
// zero byte (shorter than 32 bytes) yields a different subtree than BIP-32
// (and @scure/bip32). For those seeds every address here differs from the
// one oyster shows, so their funds are not found. Emulating the
// non-standard derivation is a separate, attended change.
export type HdBranch = 0 | 1;
export const PEARL_EXTERNAL_BRANCH: HdBranch = 0;
export const PEARL_INTERNAL_BRANCH: HdBranch = 1;
export const PEARL_SINGLESIG_ACCOUNT = 0;

/** Consecutive unused addresses that end discovery on a branch (BIP-44). */
export const DISCOVERY_GAP_LIMIT = RECEIVE_GAP_LIMIT;
/** Hard safety cap on addresses derived/scanned per branch. */
export const MAX_ADDRESSES_PER_BRANCH = 1000;
/** Upper bound on one worker derivation request. */
export const MAX_DERIVE_BATCH = 200;
/** Non-hardened BIP-32 child index ceiling (exclusive). */
const NON_HARDENED_LIMIT = 0x80000000;

export function isHdBranch(b: unknown): b is HdBranch {
  return b === 0 || b === 1;
}

function checkChildIndex(fn: string, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= NON_HARDENED_LIMIT) {
    throw new Error(`${fn}: bad index ${index}`);
  }
}

/** Account-level path for a BIP-86 coin type (account is hardened). */
export function bip86AccountPath(coinType: number, account = 0): string {
  checkChildIndex("bip86AccountPath", coinType);
  checkChildIndex("bip86AccountPath", account);
  return `m/86'/${coinType}'/${account}'`;
}

/** Full BIP-86 path m/86'/coin'/account'/branch/index. Parametrised by
 *  coin type so the official BIP-86 vectors (coin type 0) can be asserted
 *  with the exact code path Pearl (coin type 808276) uses. */
export function bip86Path(coinType: number, branch: HdBranch, index: number, account = 0): string {
  if (!isHdBranch(branch)) throw new Error(`bip86Path: bad branch ${String(branch)}`);
  checkChildIndex("bip86Path", index);
  return `${bip86AccountPath(coinType, account)}/${branch}/${index}`;
}

/** Pearl single-sig account node path: m/86'/808276'/0'. */
export function pearlAccountPath(): string {
  return bip86AccountPath(PEARL_COIN_TYPE, PEARL_SINGLESIG_ACCOUNT);
}

/** Pearl single-sig address path: m/86'/808276'/0'/{branch}/{index}. */
export function pearlBranchPath(branch: HdBranch, index: number): string {
  return bip86Path(PEARL_COIN_TYPE, branch, index, PEARL_SINGLESIG_ACCOUNT);
}

/**
 * Public-only account node (no private key) for address derivation.
 * Non-hardened children of a public parent equal those of the private
 * parent, so addresses match private derivation exactly.
 */
export function publicAccountNode(master: HDKey, accountPath: string): HDKey {
  const acct = master.derive(accountPath);
  const pub = HDKey.fromExtendedKey(acct.publicExtendedKey);
  acct.wipePrivateData();
  return pub;
}

/** Compressed (33-byte) pubkeys at account/branch/[start, start+count). */
export function branchPubkeys(
  account: HDKey,
  branch: HdBranch,
  start: number,
  count: number,
): Uint8Array[] {
  if (!isHdBranch(branch)) throw new Error(`branchPubkeys: bad branch ${String(branch)}`);
  checkChildIndex("branchPubkeys", start);
  if (!Number.isInteger(count) || count < 0) throw new Error(`branchPubkeys: bad count ${count}`);
  checkChildIndex("branchPubkeys", start + Math.max(0, count - 1));
  const chain = account.deriveChild(branch);
  const out: Uint8Array[] = [];
  for (let i = start; i < start + count; i++) {
    const node = chain.deriveChild(i);
    if (!node.publicKey) throw new Error(`HD derivation failed at branch ${branch} index ${i}`);
    out.push(node.publicKey);
  }
  return out;
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
      try {
        if (!child.publicKey) continue;
        const hex = xOnlyHex(child.publicKey);
        if (targetPubkeysHex.has(hex)) return { vaultAccount, keyIndex, pubkeyHex: hex, originPath: path };
      } finally { child.wipePrivateData(); }
    }
  }
  return null;
}
