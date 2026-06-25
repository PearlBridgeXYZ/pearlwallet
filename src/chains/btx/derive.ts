// BTX post-quantum key derivation — VALIDATED byte-for-byte against btxd.
//
// btxd derives P2MR keys NOT through BIP32 but via a dedicated BIP-87 HKDF
// scheme (src/pq/pq_keyderivation.cpp), keyed by a 32-byte master seed. A
// default receive address is a 2-leaf tree: an ML-DSA-44 spend leaf + an
// SLH-DSA-SHAKE-128s backup leaf, both from the same master seed.
//
// This module reproduces that exactly. Proven against a btxd golden vector
// (deriveaddresses on a real node) AND on-chain addresses — see
// tests/btx-derive.test.ts. Pipeline:
//   bip39Seed --HKDF("BTX-PQ-MASTER-SEED-V1")--> 32B master IKM   (wallet-defined)
//   IKM --HKDF("BTX-PQ-BIP87-HKDF-V1", info=path||algo)--> seed32  (btxd-exact)
//   seed32 --SHA256(seed32||LE32(c))--> entropy buffer
//   ML-DSA: keygen(entropy[0..32]);  SLH-DSA: keygen(entropy[0..48])
//
// The wallet's master IKM derivation (first line) is wallet-defined and tied to
// the user's mnemonic so BTX funds are recoverable by re-entering the phrase.
// btx-cli interop is via descriptor import of the exported IKM hex, not mnemonic.

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes } from "@noble/hashes/utils";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_shake_128s } from "@noble/post-quantum/slh-dsa.js";
import { defaultBtxAddress } from "./address";

const HARDENED = 0x80000000;
const PURPOSE = 87; // BIP-87
const BTX_COIN_TYPE = 0; // mainnet (btxd coin_type 0h); 1h would be testnet
const ALGO_MLDSA = 0x00;
const ALGO_SLHDSA = 0x01;

const utf8 = (s: string) => new TextEncoder().encode(s);

function be32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}
function le32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

/** Wallet master IKM (32 bytes) from the BIP-39 seed. Wallet-defined namespace. */
export function btxMasterIkm(bip39Seed: Uint8Array): Uint8Array {
  return hkdf(sha256, bip39Seed, utf8("BTX-PQ-MASTER-SEED-V1"), new Uint8Array(0), 32);
}

/** btxd-exact: master IKM -> per-key 32-byte PQ seed (HKDF-SHA256, BIP-87 info). */
function derivePqSeed32(
  ikm: Uint8Array,
  algo: number,
  coinType: number,
  account: number,
  change: number,
  index: number,
): Uint8Array {
  const info = concatBytes(
    utf8("m/87h"),
    be32(PURPOSE | HARDENED),
    be32(coinType | HARDENED),
    be32(account | HARDENED),
    be32(change),
    be32(index),
    new Uint8Array([algo]),
  );
  return hkdf(sha256, ikm, utf8("BTX-PQ-BIP87-HKDF-V1"), info, 32);
}

/** Copy into a fresh ArrayBuffer-backed Uint8Array (noble returns ArrayBufferLike). */
function toU8(x: Uint8Array): Uint8Array {
  const o = new Uint8Array(x.length);
  o.set(x);
  return o;
}

/** btxd-exact: 32-byte PQ seed -> N bytes of keygen entropy (SHA256 counter, LE). */
function pqEntropy(seed32: Uint8Array, nbytes: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(nbytes / 32) * 32);
  for (let c = 0; c * 32 < nbytes; c++) {
    out.set(sha256(concatBytes(seed32, le32(c))), c * 32);
  }
  return out.slice(0, nbytes);
}

export interface BtxAccount {
  address: string;
  change: number;
  index: number;
  mldsaPublicKey: Uint8Array; // 1312 bytes
  slhdsaPublicKey: Uint8Array; // 32 bytes
  /** ML-DSA secret key (2560 bytes) — present only when withSecret=true (signing). */
  mldsaSecretKey?: Uint8Array;
}

/**
 * Derive a BTX account (default 2-leaf address) at change/index from the master
 * IKM. Pass withSecret=true only when a signature is needed (send) — the ML-DSA
 * secret key is 2560 bytes and should not be kept resident otherwise.
 */
export function deriveBtxAccount(
  ikm: Uint8Array,
  change = 0,
  index = 0,
  withSecret = false,
): BtxAccount {
  const mSeed = derivePqSeed32(ikm, ALGO_MLDSA, BTX_COIN_TYPE, 0, change, index);
  const mKp = ml_dsa44.keygen(pqEntropy(mSeed, 32)); // ξ = entropy[0..32]
  const sSeed = derivePqSeed32(ikm, ALGO_SLHDSA, BTX_COIN_TYPE, 0, change, index);
  const sKp = slh_dsa_shake_128s.keygen(pqEntropy(sSeed, 48)); // SLH reads 48 bytes
  const mldsaPublicKey = toU8(mKp.publicKey);
  const slhdsaPublicKey = toU8(sKp.publicKey);
  return {
    address: defaultBtxAddress(mldsaPublicKey, slhdsaPublicKey),
    change,
    index,
    mldsaPublicKey,
    slhdsaPublicKey,
    ...(withSecret ? { mldsaSecretKey: toU8(mKp.secretKey) } : {}),
  };
}

/** Convenience: just the receive address at change=0/index. */
export function deriveBtxAddressFromIkm(ikm: Uint8Array, index = 0): string {
  return deriveBtxAccount(ikm, 0, index, false).address;
}

/** Full path: BIP-39 seed -> receive address at index. */
export function deriveBtxAddressFromSeed(bip39Seed: Uint8Array, index = 0): string {
  return deriveBtxAddressFromIkm(btxMasterIkm(bip39Seed), index);
}

/** Test/recovery seam: the descriptor a user imports into btx-cli to recover. */
export function btxDescriptorFromIkm(ikmHex: string, change = 0): string {
  return `mr(pqhd(${ikmHex}/0h/0h/${change}/*),pk_slh(pqhd(${ikmHex}/0h/0h/${change}/*)))`;
}
