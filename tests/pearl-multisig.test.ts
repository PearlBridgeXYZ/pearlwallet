// Tests for Pearl multisig vault address construction.
//
// The invariants this suite locks in are the ones a cosigner would
// independently verify before funding the vault:
//   - Same pubkey set + same threshold ⇒ same address, regardless of
//     the order a UI happens to feed the pubkeys in (BIP-67 sort).
//   - Internal key is the BIP-341 NUMS point (key-path spend disabled).
//   - Duplicate cosigner pubkeys are rejected.
//   - Bad threshold / count / pubkey length are rejected.
//   - Address is a valid bech32m P2TR address under the Pearl HRP.

import { describe, it, expect } from "vitest";
import * as bip39 from "@scure/bip39";
import { TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import {
  vaultDescriptorFromPubkeys,
  vaultAddressFromPubkeys,
  sortPubkeysBip67,
  PEARL_MULTISIG_NUMS_INTERNAL_KEY,
  MULTISIG_MAX_COSIGNERS,
} from "../src/chains/pearl/multisig";
import { decodeTaprootAddress, isValidPearlAddress } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import { masterFromSeed, pearlMultisigPath } from "../src/crypto/hd";

const params = pearlParams("mainnet");

// Deterministic test pubkeys derived from the BIP-39 vector 1 seed.
// We use real x-only secp256k1 pubkeys because @scure/btc-signer's
// p2tr_ms script encoder validates that each input is a curve point,
// not just 32 arbitrary bytes. Caching the derivation cost across all
// tests in this file via the lazy `pubkeysPromise` keeps the suite
// fast.
const BIP86_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let _pubkeysPromise: Promise<Uint8Array[]> | null = null;
async function realPubkeys(n: number): Promise<Uint8Array[]> {
  if (!_pubkeysPromise) {
    _pubkeysPromise = (async () => {
      const seed = await bip39.mnemonicToSeed(BIP86_MNEMONIC);
      const master = masterFromSeed(seed);
      const out: Uint8Array[] = [];
      for (let i = 0; i < MULTISIG_MAX_COSIGNERS; i++) {
        const child = master.derive(pearlMultisigPath(0, i));
        out.push(child.publicKey!.slice(1));
      }
      return out;
    })();
  }
  const all = await _pubkeysPromise;
  return all.slice(0, n);
}

describe("BIP-67 pubkey sort", () => {
  it("sorts byte-lex ascending", async () => {
    const [a, b, c] = await realPubkeys(3);
    const sorted = sortPubkeysBip67([a!, b!, c!]);
    // The order depends on the actual byte content; we just verify
    // the result is monotonically non-decreasing.
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      let cmp = 0;
      for (let j = 0; j < prev.length; j++) {
        if (prev[j] !== cur[j]) {
          cmp = prev[j]! - cur[j]!;
          break;
        }
      }
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("returns a new array — input untouched", async () => {
    const [a, b] = await realPubkeys(2);
    const input = [a!, b!];
    const snapshot = input.map((p) => Buffer.from(p).toString("hex"));
    sortPubkeysBip67(input);
    expect(input.map((p) => Buffer.from(p).toString("hex"))).toEqual(snapshot);
  });
});

describe("vaultDescriptorFromPubkeys", () => {
  it("builds a valid Pearl P2TR address for 2-of-3", async () => {
    const [A, B, C] = await realPubkeys(3);
    const d = vaultDescriptorFromPubkeys(2, [A!, B!, C!], params);
    expect(d.address.startsWith("prl1p")).toBe(true);
    expect(isValidPearlAddress(d.address, params)).toBe(true);
    expect(d.threshold).toBe(2);
    expect(d.total).toBe(3);
    expect(d.network).toBe("mainnet");
  });

  it("internal key is the BIP-341 NUMS point (key-path spend disabled)", async () => {
    const [A, B, C] = await realPubkeys(3);
    const d = vaultDescriptorFromPubkeys(2, [A!, B!, C!], params);
    expect(Buffer.from(d.internalKey).toString("hex")).toBe(
      Buffer.from(TAPROOT_UNSPENDABLE_KEY).toString("hex"),
    );
    expect(Buffer.from(PEARL_MULTISIG_NUMS_INTERNAL_KEY).toString("hex")).toBe(
      Buffer.from(TAPROOT_UNSPENDABLE_KEY).toString("hex"),
    );
  });

  it("address is independent of input order (BIP-67 determinism)", async () => {
    const [A, B, C] = await realPubkeys(3);
    const a1 = vaultAddressFromPubkeys(2, [A!, B!, C!], params);
    const a2 = vaultAddressFromPubkeys(2, [C!, B!, A!], params);
    const a3 = vaultAddressFromPubkeys(2, [B!, A!, C!], params);
    expect(a1).toBe(a2);
    expect(a1).toBe(a3);
  });

  it("changing the threshold changes the address", async () => {
    const [A, B, C] = await realPubkeys(3);
    const a1 = vaultAddressFromPubkeys(2, [A!, B!, C!], params);
    const a2 = vaultAddressFromPubkeys(3, [A!, B!, C!], params);
    expect(a1).not.toBe(a2);
  });

  it("output script is 34 bytes (witness v1 P2TR)", async () => {
    const [A, B, C] = await realPubkeys(3);
    const d = vaultDescriptorFromPubkeys(2, [A!, B!, C!], params);
    expect(d.outputScript.length).toBe(34);
    expect(d.outputScript[0]).toBe(0x51); // OP_1
    expect(d.outputScript[1]).toBe(0x20); // push 32 bytes
  });

  it("output key is 32 bytes and decodes back from the address", async () => {
    const [A, B, C] = await realPubkeys(3);
    const d = vaultDescriptorFromPubkeys(2, [A!, B!, C!], params);
    expect(d.outputKey.length).toBe(32);
    const decoded = decodeTaprootAddress(d.address, params);
    expect(Buffer.from(decoded).toString("hex")).toBe(
      Buffer.from(d.outputKey).toString("hex"),
    );
  });

  it("exposes a tapleaf script with version 0xc0", async () => {
    const [A, B, C] = await realPubkeys(3);
    const d = vaultDescriptorFromPubkeys(2, [A!, B!, C!], params);
    expect(d.leafVersion).toBe(0xc0);
    expect(d.leafScript.length).toBeGreaterThan(0);
  });

  it("sortedPubkeys is BIP-67 sorted regardless of input order", async () => {
    const [A, B, C] = await realPubkeys(3);
    const d1 = vaultDescriptorFromPubkeys(2, [A!, B!, C!], params);
    const d2 = vaultDescriptorFromPubkeys(2, [C!, A!, B!], params);
    expect(d1.sortedPubkeys.map((p) => Buffer.from(p).toString("hex"))).toEqual(
      d2.sortedPubkeys.map((p) => Buffer.from(p).toString("hex")),
    );
  });

  it("rejects duplicate cosigner pubkeys", async () => {
    const [A, , C] = await realPubkeys(3);
    expect(() => vaultDescriptorFromPubkeys(2, [A!, A!, C!], params)).toThrow(
      /E_MULTISIG_DUPLICATE_PUBKEY/,
    );
  });

  it("rejects threshold < 1", async () => {
    const [A, B, C] = await realPubkeys(3);
    expect(() => vaultDescriptorFromPubkeys(0, [A!, B!, C!], params)).toThrow(
      /E_MULTISIG_BAD_THRESHOLD/,
    );
  });

  it("rejects non-integer threshold", async () => {
    const [A, B, C] = await realPubkeys(3);
    expect(() => vaultDescriptorFromPubkeys(1.5, [A!, B!, C!], params)).toThrow(
      /E_MULTISIG_BAD_THRESHOLD/,
    );
  });

  it("rejects threshold > total", async () => {
    const [A, B, C] = await realPubkeys(3);
    expect(() => vaultDescriptorFromPubkeys(4, [A!, B!, C!], params)).toThrow(
      /E_MULTISIG_THRESHOLD_EXCEEDS_COSIGNERS/,
    );
  });

  it("rejects empty cosigner set", () => {
    expect(() => vaultDescriptorFromPubkeys(1, [], params)).toThrow(
      /E_MULTISIG_BAD_COSIGNER_COUNT/,
    );
  });

  it(`rejects > ${MULTISIG_MAX_COSIGNERS} cosigners`, async () => {
    const many = await realPubkeys(MULTISIG_MAX_COSIGNERS);
    // Append one more by deriving an extra (distinct) pubkey.
    const seed = await bip39.mnemonicToSeed(BIP86_MNEMONIC);
    const master = masterFromSeed(seed);
    const extra = master
      .derive(pearlMultisigPath(0, MULTISIG_MAX_COSIGNERS))
      .publicKey!.slice(1);
    expect(() =>
      vaultDescriptorFromPubkeys(2, [...many, extra], params),
    ).toThrow(/E_MULTISIG_BAD_COSIGNER_COUNT/);
  });

  it("rejects non-32-byte pubkey", async () => {
    const [A, B] = await realPubkeys(2);
    const short = new Uint8Array(31);
    expect(() => vaultDescriptorFromPubkeys(2, [A!, B!, short], params)).toThrow(
      /E_MULTISIG_BAD_PUBKEY_LEN/,
    );
  });

  it("1-of-1 is allowed", async () => {
    const [A] = await realPubkeys(1);
    const d = vaultDescriptorFromPubkeys(1, [A!], params);
    expect(d.threshold).toBe(1);
    expect(d.total).toBe(1);
    expect(d.address.startsWith("prl1p")).toBe(true);
  });

  it(`${MULTISIG_MAX_COSIGNERS}-of-${MULTISIG_MAX_COSIGNERS} is allowed`, async () => {
    const many = await realPubkeys(MULTISIG_MAX_COSIGNERS);
    const d = vaultDescriptorFromPubkeys(MULTISIG_MAX_COSIGNERS, many, params);
    expect(d.threshold).toBe(MULTISIG_MAX_COSIGNERS);
    expect(d.address.startsWith("prl1p")).toBe(true);
  });
});

// Golden vector — if any of the construction primitives change, this
// address moves and the test fails loudly. The pubkeys are real BIP-86
// children of the BIP-39 vector 1 seed under the multisig account
// `m/86'/808276'/100'/0'/{0,1,2}` and the construction is the canonical
// Pearl 2-of-3 (NUMS internal, BIP-67 sort, tapscript m-of-n leaf).
// Address pinned once at v0.1.18; any drift in derivation, sort, leaf
// construction, taproot tweak, or address codec moves it.
describe("Pearl multisig golden vector", () => {
  it("2-of-3 of the canonical BIP-86 cosigner pubkeys produces a stable address", async () => {
    const [A, B, C] = await realPubkeys(3);
    const addr = vaultAddressFromPubkeys(2, [A!, B!, C!], params);
    expect(addr).toMatchSnapshot();
  });
});
