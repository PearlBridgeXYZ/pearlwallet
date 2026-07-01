// BTX transaction builder + P2MR/ML-DSA signer.
//
// Spends single-key (default 2-leaf) P2MR outputs: sign the ML-DSA leaf, commit
// the SLH-DSA backup leaf hash as the control-block sibling. Sighash is BIP-341
// SignatureHashSchnorr with the P2MR epoch byte 0x02 (see btx-crypto-spec §4),
// SIGHASH_DEFAULT only. Witness = [sig(2420), leafScript(1316), control(33)].
//
// Spec-conformant against btx-crypto-spec §4 (sighash) / §5 (witness) and
// reviewed byte-by-byte; tests/btx-tx.test.ts validates it against on-chain
// spend 8e4929…e214 (txid reproduction + verifying the real on-chain ML-DSA
// signature against the computed sighash). Wrong bytes = lost funds.

import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import {
  mldsaLeafScript,
  slhdsaLeafScript,
  p2mrLeafHash,
  decodeP2MRAddress,
  compactSize,
  P2MR_LEAF_VERSION,
} from "./address";

const sha256d = (b: Uint8Array) => sha256(sha256(b));
function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function u64le(n: bigint): Uint8Array {
  // setBigUint64 silently two's-complements negatives and wraps >=2^64; reject
  // both so a bad amount fails loudly rather than mis-serializing.
  if (n < 0n || n >= 1n << 64n) throw new Error("value out of u64 range");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
/** display txid (RPC byte order) -> internal little-endian bytes. */
function txidToInternal(txidHex: string): Uint8Array {
  return hexToBytes(txidHex).reverse();
}
function varBytes(b: Uint8Array): Uint8Array {
  return concatBytes(compactSize(b.length), b);
}

export interface BtxTxInput {
  txid: string; // display order
  vout: number;
  valueSat: bigint;
  // scriptPubKey of the prevout — for our own P2MR address it's OP_2 <program>.
  scriptPubKey: Uint8Array;
  // nSequence; defaults to 0xffffffff (final). Per-input so a validation test
  // can reproduce an on-chain tx that used a different sequence.
  sequence?: number;
}
export interface BtxTxOutput {
  scriptPubKey: Uint8Array;
  valueSat: bigint;
}

/** P2MR output scriptPubKey for an address: OP_2 (0x52) <push32 program>. */
export function p2mrScriptPubKey(address: string): Uint8Array {
  const { program } = decodeP2MRAddress(address);
  return concatBytes(new Uint8Array([0x52, 0x20]), program);
}

// ── serialization ───────────────────────────────────────────────────────────
const SEQ_FINAL = 0xffffffff;

const seqOf = (i: BtxTxInput) => i.sequence ?? SEQ_FINAL;

function serializeInputs(ins: BtxTxInput[]): Uint8Array {
  const parts = [compactSize(ins.length)];
  for (const i of ins) {
    parts.push(txidToInternal(i.txid), u32le(i.vout), new Uint8Array([0x00]), u32le(seqOf(i)));
  }
  return concatBytes(...parts);
}
function serializeOutputs(outs: BtxTxOutput[]): Uint8Array {
  const parts = [compactSize(outs.length)];
  for (const o of outs) parts.push(u64le(o.valueSat), varBytes(o.scriptPubKey));
  return concatBytes(...parts);
}

/** Non-witness serialization (the txid preimage). */
function serializeLegacy(version: number, ins: BtxTxInput[], outs: BtxTxOutput[], locktime: number): Uint8Array {
  return concatBytes(u32le(version), serializeInputs(ins), serializeOutputs(outs), u32le(locktime));
}

/** txid (display order) of an unsigned/signed tx (witness-stripped hash). */
export function computeTxid(version: number, ins: BtxTxInput[], outs: BtxTxOutput[], locktime: number): string {
  return bytesToHex(sha256d(serializeLegacy(version, ins, outs, locktime)).reverse());
}

// ── sighash (BIP-341 style, P2MR epoch 0x02, SIGHASH_DEFAULT) ─────────────────
export function p2mrSighash(
  version: number,
  ins: BtxTxInput[],
  outs: BtxTxOutput[],
  locktime: number,
  inputIndex: number,
  leafScript: Uint8Array,
): Uint8Array {
  const shaPrevouts = sha256(concatBytes(...ins.map((i) => concatBytes(txidToInternal(i.txid), u32le(i.vout)))));
  const shaAmounts = sha256(concatBytes(...ins.map((i) => u64le(i.valueSat))));
  const shaScriptpubkeys = sha256(concatBytes(...ins.map((i) => varBytes(i.scriptPubKey))));
  const shaSequences = sha256(concatBytes(...ins.map((i) => u32le(seqOf(i)))));
  const shaOutputs = sha256(concatBytes(...outs.map((o) => concatBytes(u64le(o.valueSat), varBytes(o.scriptPubKey)))));
  const leafHash = p2mrLeafHash(leafScript);

  const msg = concatBytes(
    new Uint8Array([0x02]), // epoch (P2MR)
    new Uint8Array([0x00]), // hash_type = SIGHASH_DEFAULT
    u32le(version),
    u32le(locktime),
    shaPrevouts,
    shaAmounts,
    shaScriptpubkeys,
    shaSequences,
    shaOutputs,
    new Uint8Array([0x02]), // spend_type: ext_flag=1, no annex
    u32le(inputIndex),
    leafHash,
    new Uint8Array([0x00]), // key_version
    u32le(0xffffffff), // codeseparator_pos (none)
  );
  return taggedHash("TapSighash", msg);
}

// ── witness assembly + full signing ──────────────────────────────────────────
export interface BtxSignerKey {
  mldsaPublicKey: Uint8Array; // 1312
  mldsaSecretKey: Uint8Array; // 2560
  slhdsaPublicKey: Uint8Array; // 32 — for the control-block sibling
}

/** control block for spending the ML-DSA leaf of a 2-leaf tree: 0xc2 || slhdsaLeafHash. */
function controlBlock(slhdsaPublicKey: Uint8Array): Uint8Array {
  const sibling = p2mrLeafHash(slhdsaLeafScript(slhdsaPublicKey));
  return concatBytes(new Uint8Array([P2MR_LEAF_VERSION]), sibling);
}

function serializeWitness(items: Uint8Array[]): Uint8Array {
  return concatBytes(compactSize(items.length), ...items.map(varBytes));
}

export interface SignedBtxTx {
  txid: string;
  hex: string;
}

/**
 * Build + sign a spend. All inputs must belong to `key` (single-key wallet).
 * Outputs are the caller's recipient + change (caller computes amounts/fee).
 */
export function buildSignedBtxTx(
  key: BtxSignerKey,
  ins: BtxTxInput[],
  outs: BtxTxOutput[],
  opts: { version?: number; locktime?: number } = {},
): SignedBtxTx {
  const version = opts.version ?? 2;
  const locktime = opts.locktime ?? 0;
  const leafScript = mldsaLeafScript(key.mldsaPublicKey);
  const control = controlBlock(key.slhdsaPublicKey);

  const witnesses: Uint8Array[][] = ins.map((_, idx) => {
    const sighash = p2mrSighash(version, ins, outs, locktime, idx, leafScript);
    const sig = Uint8Array.from(ml_dsa44.sign(sighash, key.mldsaSecretKey)); // 2420B, SIGHASH_DEFAULT
    return [sig, leafScript, control];
  });

  const parts = [
    u32le(version),
    new Uint8Array([0x00, 0x01]), // segwit marker + flag
    serializeInputs(ins),
    serializeOutputs(outs),
    ...witnesses.map(serializeWitness),
    u32le(locktime),
  ];
  const raw = concatBytes(...parts);
  return { txid: computeTxid(version, ins, outs, locktime), hex: bytesToHex(raw) };
}

/** Worst-case vsize estimate for fee calc (per-input witness ~3771 wu). */
export function estimateBtxVsize(nIn: number, nOut: number): number {
  const base = 4 + 1 + nIn * (32 + 4 + 1 + 4) + 1 + nOut * (8 + 1 + 34) + 4;
  const witness = 2 + nIn * (1 + (3 + 2420) + (3 + 1316) + (1 + 33)); // items+lengths
  return Math.ceil(base + witness / 4);
}
