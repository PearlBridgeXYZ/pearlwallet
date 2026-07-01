// BTX P2MR (Pay-to-Merkle-Root) address codec — witness v2, post-quantum.
//
// A BTX output is `OP_2 <32-byte merkle root>`, encoded bech32m with HRP "btx"
// (first data char "z"). The 32-byte program is the Merkle root of a P2MR script
// tree. A btxd DEFAULT receive address is a 2-leaf tree: an ML-DSA-44 spend leaf
// + an SLH-DSA-SHAKE-128s backup leaf. A single-key tree (ML-DSA only) is also
// valid and its program == the ML-DSA leaf hash directly.
//
// All constants verified from github.com/btxchain/btx@main (doc/btx-pqc-spec.md,
// src/script/pqm.cpp) AND reproduced against on-chain addresses — see
// tests/btx-address.test.ts. Wrong bytes = lost funds; this file is validated,
// not guessed.

import { bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";

export const BTX_HRP = "btx";
export const BTX_WITNESS_VERSION = 2;
export const P2MR_LEAF_VERSION = 0xc2;
export const OP_CHECKSIG_MLDSA = 0xbb;
export const OP_CHECKSIG_SLHDSA = 0xbc;
const MLDSA_PUBKEY_LEN = 1312;
const SLHDSA_PUBKEY_LEN = 32;

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** Bitcoin tagged hash: SHA256( SHA256(tag) || SHA256(tag) || msg ). */
function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
}

/** Bitcoin CompactSize (varint) encoding of a length. */
export function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, n, true);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = new Uint8Array(5);
    b[0] = 0xfe;
    new DataView(b.buffer).setUint32(1, n, true);
    return b;
  }
  throw new Error("compactSize too large");
}

/** OP_PUSHDATA-prefixed push of `data` (minimal encoding, matches btxd BuildP2MRPubkeyPush). */
function pushData(data: Uint8Array): Uint8Array {
  const n = data.length;
  if (n < 0x4c) return concatBytes(new Uint8Array([n]), data); // direct push
  if (n <= 0xff) return concatBytes(new Uint8Array([0x4c, n]), data); // OP_PUSHDATA1
  if (n <= 0xffff) {
    const hdr = new Uint8Array(3);
    hdr[0] = 0x4d; // OP_PUSHDATA2
    new DataView(hdr.buffer).setUint16(1, n, true);
    return concatBytes(hdr, data); // matches "4d 2005 <1312B>" for ML-DSA
  }
  throw new Error("pushData too large");
}

/** ML-DSA leaf script: `OP_PUSHDATA2 <1312B pubkey> OP_CHECKSIG_MLDSA` (1316 bytes). */
export function mldsaLeafScript(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length !== MLDSA_PUBKEY_LEN) throw new Error(`ML-DSA pubkey must be ${MLDSA_PUBKEY_LEN} bytes`);
  return concatBytes(pushData(pubkey), new Uint8Array([OP_CHECKSIG_MLDSA]));
}

/** SLH-DSA backup leaf script: `<32B pubkey> OP_CHECKSIG_SLHDSA` (34 bytes). */
export function slhdsaLeafScript(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length !== SLHDSA_PUBKEY_LEN) throw new Error(`SLH-DSA pubkey must be ${SLHDSA_PUBKEY_LEN} bytes`);
  return concatBytes(pushData(pubkey), new Uint8Array([OP_CHECKSIG_SLHDSA]));
}

/** P2MR leaf hash = taggedHash("P2MRLeaf", leafVersion || compactSize(len) || script). */
export function p2mrLeafHash(script: Uint8Array, leafVersion = P2MR_LEAF_VERSION): Uint8Array {
  return taggedHash("P2MRLeaf", concatBytes(new Uint8Array([leafVersion]), compactSize(script.length), script));
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** P2MR branch hash = taggedHash("P2MRBranch", sort(a,b)) — lexicographic sort. */
export function p2mrBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = cmpBytes(a, b) < 0 ? [a, b] : [b, a];
  return taggedHash("P2MRBranch", concatBytes(lo, hi));
}

/** Merkle root over leaf hashes (bottom-up pairwise, odd promoted). 1 leaf => itself. */
export function p2mrMerkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) return new Uint8Array(32);
  let level = leafHashes;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? p2mrBranchHash(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** bech32m-encode a 32-byte witness-v2 program as a btx1z… address. */
export function encodeP2MRAddress(program: Uint8Array): string {
  if (program.length !== 32) throw new Error("P2MR program must be 32 bytes");
  const words = [BTX_WITNESS_VERSION, ...bech32m.toWords(program)];
  return bech32m.encode(BTX_HRP, words, 1000);
}

/** Decode a btx1z… address to {version, program}. Throws on bad hrp/version/checksum. */
export function decodeP2MRAddress(addr: string): { version: number; program: Uint8Array } {
  const { prefix, words } = bech32m.decode(addr as `${string}1${string}`, 1000);
  if (prefix !== BTX_HRP) throw new Error(`expected hrp ${BTX_HRP}, got ${prefix}`);
  const version = words[0];
  if (version !== BTX_WITNESS_VERSION) throw new Error(`expected witness v${BTX_WITNESS_VERSION}, got v${version}`);
  const program = bech32m.fromWords(words.slice(1));
  if (program.length !== 32) throw new Error("P2MR program must be 32 bytes");
  return { version, program: Uint8Array.from(program) };
}

/** The btxd DEFAULT receive address: 2-leaf tree (ML-DSA spend + SLH-DSA backup). */
export function defaultBtxAddress(mldsaPubkey: Uint8Array, slhdsaPubkey: Uint8Array): string {
  const leaves = [p2mrLeafHash(mldsaLeafScript(mldsaPubkey)), p2mrLeafHash(slhdsaLeafScript(slhdsaPubkey))];
  return encodeP2MRAddress(p2mrMerkleRoot(leaves));
}

/** Single-leaf ML-DSA-only address (program == the ML-DSA leaf hash). NOT btxd-default. */
export function singleLeafBtxAddress(mldsaPubkey: Uint8Array): string {
  return encodeP2MRAddress(p2mrLeafHash(mldsaLeafScript(mldsaPubkey)));
}

/** Quick structural validity check (hrp + witness version + 32-byte program). */
export function isValidBtxAddress(addr: string): boolean {
  try {
    decodeP2MRAddress(addr);
    return true;
  } catch {
    return false;
  }
}
