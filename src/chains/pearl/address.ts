// Pearl P2TR bech32m address codec.
// Pearl is a btcd fork using SegWit v1 (Taproot, BIP-340 Schnorr).
//
// Encoding: bech32m, witness version 1, 32-byte x-only public key.
// HRP: "prl" (mainnet only — Pearl has no testnet).

import { bech32m } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import type { PearlNetworkParams } from "./network";

const TAPROOT_VERSION = 1;
const TAPROOT_PROGRAM_LEN = 32;

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const concat = new Uint8Array(tagHash.length * 2 + data.length);
  concat.set(tagHash, 0);
  concat.set(tagHash, tagHash.length);
  concat.set(data, tagHash.length * 2);
  return sha256(concat);
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function bigIntToBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let cur = v;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(cur & 0xffn);
    cur >>= 8n;
  }
  return out;
}

/**
 * BIP-86 Taproot tweak: given a 32-byte x-only internal pubkey, produce the
 * 32-byte x-only output pubkey for use in a P2TR address.
 *
 * tweaked = internal + H_TapTweak(internal) * G
 */
export function bip86Tweak(xOnlyInternal: Uint8Array): Uint8Array {
  if (xOnlyInternal.length !== 32) {
    throw new Error("internal pubkey must be 32 bytes (x-only)");
  }
  const tweak = taggedHash("TapTweak", xOnlyInternal);
  const internalPoint = secp256k1.ProjectivePoint.fromHex(
    Uint8Array.from([0x02, ...xOnlyInternal]),
  );
  const tweakScalar = bytesToBigInt(tweak);
  const G = secp256k1.ProjectivePoint.BASE;
  const tweakedPoint = internalPoint.add(G.multiply(tweakScalar));
  const affine = tweakedPoint.toAffine();
  return bigIntToBytes(affine.x, 32);
}

/**
 * Encode a P2TR (Taproot key-path) Pearl address from a 32-byte x-only output pubkey.
 */
export function encodeTaprootAddress(
  outputKey: Uint8Array,
  params: PearlNetworkParams,
): string {
  if (outputKey.length !== TAPROOT_PROGRAM_LEN) {
    throw new Error("output key must be 32 bytes");
  }
  const words = bech32m.toWords(outputKey);
  const all = [TAPROOT_VERSION, ...words];
  return bech32m.encode(params.hrp, all, 90);
}

/**
 * Decode a Pearl P2TR address. Returns the 32-byte x-only output key.
 * Throws on bad checksum, HRP mismatch, wrong witness version, wrong program length.
 */
export function decodeTaprootAddress(
  address: string,
  params: PearlNetworkParams,
): Uint8Array {
  const decoded = bech32m.decode(address as `${string}1${string}`, 90);
  if (decoded.prefix !== params.hrp) {
    throw new Error(`E_INVALID_ADDRESS: expected HRP "${params.hrp}"`);
  }
  const version = decoded.words[0];
  const programWords = decoded.words.slice(1);
  if (version !== TAPROOT_VERSION) {
    throw new Error(`E_INVALID_ADDRESS: unsupported witness version ${version}`);
  }
  const program = bech32m.fromWords(programWords);
  if (program.length !== TAPROOT_PROGRAM_LEN) {
    throw new Error("E_INVALID_ADDRESS: program length");
  }
  return Uint8Array.from(program);
}

/** Returns true/false; never throws. */
export function isValidPearlAddress(address: string, params: PearlNetworkParams): boolean {
  try {
    decodeTaprootAddress(address, params);
    return true;
  } catch {
    return false;
  }
}

/** Derive Pearl receive address from a 32-byte x-only internal pubkey. */
export function pearlAddressFromInternalKey(
  xOnlyInternal: Uint8Array,
  params: PearlNetworkParams,
): string {
  return encodeTaprootAddress(bip86Tweak(xOnlyInternal), params);
}

/**
 * Derive Pearl receive address from a 33-byte compressed secp256k1 pubkey.
 * Strips the parity byte and applies BIP-86 tweak.
 */
export function pearlAddressFromCompressedPubkey(
  compressed: Uint8Array,
  params: PearlNetworkParams,
): string {
  if (compressed.length !== 33) {
    throw new Error("compressed pubkey must be 33 bytes");
  }
  return pearlAddressFromInternalKey(compressed.slice(1), params);
}
