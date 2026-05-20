// Pearl L1 multisig — BIP-342 tapscript m-of-n (CHECKSIGADD) under a
// P2TR output, key-path locked to the BIP-341 NUMS point so the
// key-path spend is provably disabled.
//
// Why this shape (vs MuSig2 / FROST / pubkey-as-internal-key):
// - `@scure/btc-signer` already ships the primitives. No new deps.
// - 2-of-3 retail intent — MuSig2 alone can't do m-of-n.
// - NUMS as internal key is the single most important footgun
//   prevention: if a real cosigner pubkey were the internal key, any
//   single holder could drain via key-path and bypass m-of-n entirely.
// - BIP-67 (byte-lex) sort of the pubkeys before building the leaf:
//   anyone reconstructing the vault with the same pubkey set gets the
//   same script bytes → same address. That equality lets cosigners
//   independently verify "we all see the same vault address" before
//   funding it — the only defence against a malicious originator who
//   hands different cosigners different sets.
//
// On-chain shape (per spend):
//   witness = <sig_m> … <sig_1> <leaf_script> <control_block>
// Spends are not indistinguishable from singlesig (privacy cost
// accepted in research §1); the bytes-per-spend cost is also higher
// than MuSig2 (≈ 64*m + 104 + control-block). Both are deferred
// improvements; this is the minimal correct primitive.

import { p2tr, p2tr_ms, TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import { encodeTaprootAddress } from "./address";
import type { PearlNetworkParams } from "./network";

export const MULTISIG_MIN_THRESHOLD = 1;
export const MULTISIG_MAX_COSIGNERS = 15;

export interface VaultDescriptor {
  /** Required signatures (m). */
  threshold: number;
  /** Total cosigners (n). */
  total: number;
  /** 32-byte x-only cosigner pubkeys, **already BIP-67-sorted** for determinism. */
  sortedPubkeys: Uint8Array[];
  /** Pearl bech32m P2TR address derived from the tapscript output. */
  address: string;
  /** 34-byte witness-v1 output script for chain-side construction. */
  outputScript: Uint8Array;
  /** 32-byte tweaked output key (the bech32m program bytes). */
  outputKey: Uint8Array;
  /** Tapleaf script (the m-of-n tr_ms leaf). Needed for spend witness assembly. */
  leafScript: Uint8Array;
  /** Tapleaf version (0xc0 for BIP-342 / tr_ms). */
  leafVersion: number;
  /** NUMS internal key (provably unspendable via key-path). Constant — see TAPROOT_UNSPENDABLE_KEY. */
  internalKey: Uint8Array;
  /**
   * Raw PSBT-shape tapLeafScript field as @scure/btc-signer's `Transaction.addInput`
   * accepts it: an array of `[ControlBlock, script || leafVer]` tuples. For our
   * single-leaf NUMS-bound vault this array always has length 1. Passing this
   * through verbatim keeps the spend-compose path from reaching into btc-signer
   * internals to reconstruct the control block.
   */
  tapLeafScript: Array<
    [
      { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] },
      Uint8Array,
    ]
  >;
  /** Network the address was encoded for. Carrying it stops a mainnet vault from being silently misread under a future testnet HRP. */
  network: "mainnet";
}

function isXOnlyPubkey(b: Uint8Array): boolean {
  return b.length === 32;
}

/**
 * Byte-lexicographic sort of 32-byte x-only pubkeys (BIP-67 over taproot).
 * Returns a new array; the input is untouched.
 */
export function sortPubkeysBip67(pubkeys: Uint8Array[]): Uint8Array[] {
  const copy = pubkeys.map((p) => Uint8Array.from(p));
  copy.sort((a, b) => {
    for (let i = 0; i < a.length; i++) {
      const da = a[i]!;
      const db = b[i]!;
      if (da !== db) return da - db;
    }
    return 0;
  });
  return copy;
}

/**
 * Build the Pearl multisig vault address + descriptor from a set of
 * 32-byte x-only cosigner pubkeys.
 *
 * @param threshold m — required signatures (1 ≤ m ≤ n)
 * @param pubkeys   n x-only pubkeys (≥ 1, ≤ MULTISIG_MAX_COSIGNERS); order is normalised internally
 * @param params    Pearl network params (HRP)
 */
export function vaultDescriptorFromPubkeys(
  threshold: number,
  pubkeys: Uint8Array[],
  params: PearlNetworkParams,
): VaultDescriptor {
  if (!Number.isInteger(threshold) || threshold < MULTISIG_MIN_THRESHOLD) {
    throw new Error("E_MULTISIG_BAD_THRESHOLD");
  }
  if (pubkeys.length === 0 || pubkeys.length > MULTISIG_MAX_COSIGNERS) {
    throw new Error("E_MULTISIG_BAD_COSIGNER_COUNT");
  }
  if (threshold > pubkeys.length) {
    throw new Error("E_MULTISIG_THRESHOLD_EXCEEDS_COSIGNERS");
  }
  for (const p of pubkeys) {
    if (!isXOnlyPubkey(p)) throw new Error("E_MULTISIG_BAD_PUBKEY_LEN");
  }
  // Reject duplicate cosigner keys — a 2-of-3 with two slots held by the
  // same key collapses to 2-of-2 under the real keyholder, breaking the
  // m-of-n trust assumption silently.
  const seen = new Set<string>();
  for (const p of pubkeys) {
    const k = Array.from(p).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (seen.has(k)) throw new Error("E_MULTISIG_DUPLICATE_PUBKEY");
    seen.add(k);
  }

  const sorted = sortPubkeysBip67(pubkeys);
  const leaf = p2tr_ms(threshold, sorted);
  // Internal key is explicitly the NUMS point — `p2tr(undefined, ...)`
  // also defaults to it in @scure/btc-signer, but passing the constant
  // (a) documents intent and (b) lets the binding test assert that
  // the implementation tweaked from NUMS, not from a foreign key.
  const tr = p2tr(TAPROOT_UNSPENDABLE_KEY, leaf, undefined, false);

  const address = encodeTaprootAddress(tr.tweakedPubkey, params);

  // tapLeafScript is an array of [ControlBlock, script||leafVer] tuples.
  // For a single leaf the array has length 1; we crack open the leaf bytes
  // and the leaf version so spend assembly downstream doesn't reach into
  // btc-signer internals.
  const tls = tr.tapLeafScript;
  if (!tls || tls.length !== 1) {
    throw new Error("E_MULTISIG_UNEXPECTED_LEAF_COUNT");
  }
  const [, scriptPlusVer] = tls[0]!;
  // The last byte of (script || leafVersion) is the leaf-version byte
  // (0xc0 for BIP-342); the rest is the leaf script. btc-signer concats
  // them this way to satisfy PSBT's BIP-371 tapLeafScript field shape.
  const leafVersion = scriptPlusVer[scriptPlusVer.length - 1]!;
  const leafScript = scriptPlusVer.slice(0, -1);

  return {
    threshold,
    total: pubkeys.length,
    sortedPubkeys: sorted,
    address,
    outputScript: tr.script,
    outputKey: tr.tweakedPubkey,
    leafScript,
    leafVersion,
    internalKey: TAPROOT_UNSPENDABLE_KEY,
    tapLeafScript: tls as VaultDescriptor["tapLeafScript"],
    network: params.name,
  };
}

/**
 * Convenience: just the bech32m address, when you don't need the full descriptor.
 */
export function vaultAddressFromPubkeys(
  threshold: number,
  pubkeys: Uint8Array[],
  params: PearlNetworkParams,
): string {
  return vaultDescriptorFromPubkeys(threshold, pubkeys, params).address;
}

/**
 * BIP-341 NUMS x-only pubkey constant — the internal key for every Pearl
 * vault. Exposed so consumers (tests, descriptor verification) can pin it
 * without importing from `@scure/btc-signer` directly.
 */
export const PEARL_MULTISIG_NUMS_INTERNAL_KEY = TAPROOT_UNSPENDABLE_KEY;
