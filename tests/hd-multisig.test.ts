// Tests for the dedicated multisig derivation path.
//
// pearlMultisigPath returns the BIP-86-shaped path we hand to cosigners
// when they're enrolling in a Pearl vault. The path must be:
//   - In a separate hardened account from singlesig receive (no
//     overlap with the RECEIVE_GAP_LIMIT walk, no leakage between the
//     two surfaces).
//   - Deterministic: same (vaultAccount, index) → same path string.
//   - Bounds-checked: any non-integer / negative / > 2^31-1 input
//     throws rather than silently producing a string that derives
//     to garbage.

import { describe, it, expect } from "vitest";
import * as bip39 from "@scure/bip39";
import {
  PEARL_COIN_TYPE,
  PEARL_MULTISIG_ACCOUNT_PREFIX,
  masterFromSeed,
  pearlMultisigPath,
  pearlReceivePath,
} from "../src/crypto/hd";

const BIP86_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("pearlMultisigPath", () => {
  it("uses the m/86'/808276'/100'/{vault}'/{i} shape", () => {
    expect(pearlMultisigPath(0, 0)).toBe(`m/86'/${PEARL_COIN_TYPE}'/100'/0'/0`);
    expect(pearlMultisigPath(7, 3)).toBe(`m/86'/${PEARL_COIN_TYPE}'/100'/7'/3`);
  });

  it("pins PEARL_MULTISIG_ACCOUNT_PREFIX to 100", () => {
    // If we ever move the prefix, every vault address moves with it
    // and every cosigner descriptor stops verifying. Lock the number.
    expect(PEARL_MULTISIG_ACCOUNT_PREFIX).toBe(100);
  });

  it("is deterministic — same inputs, same path", () => {
    expect(pearlMultisigPath(2, 4)).toBe(pearlMultisigPath(2, 4));
  });

  it("does not collide with the singlesig receive path at any index", () => {
    // Singlesig receive walks the 0' account; multisig walks the 100'
    // account. The paths must be disjoint so a single mnemonic can
    // safely back both surfaces.
    for (let i = 0; i < 20; i++) {
      expect(pearlMultisigPath(0, i)).not.toBe(pearlReceivePath(i));
    }
  });

  it("rejects non-integer vaultAccount", () => {
    expect(() => pearlMultisigPath(1.5, 0)).toThrow();
    expect(() => pearlMultisigPath(NaN, 0)).toThrow();
  });

  it("rejects negative vaultAccount", () => {
    expect(() => pearlMultisigPath(-1, 0)).toThrow();
  });

  it("rejects vaultAccount past 2^31-1 (hardened range)", () => {
    expect(() => pearlMultisigPath(0x80000000, 0)).toThrow();
  });

  it("rejects non-integer / negative / overflow index", () => {
    expect(() => pearlMultisigPath(0, 1.5)).toThrow();
    expect(() => pearlMultisigPath(0, NaN)).toThrow();
    expect(() => pearlMultisigPath(0, -1)).toThrow();
    expect(() => pearlMultisigPath(0, 0x80000000)).toThrow();
  });

  it("derives without error from a real seed and yields a 32-byte x-only pubkey", async () => {
    const seed = await bip39.mnemonicToSeed(BIP86_MNEMONIC);
    const master = masterFromSeed(seed);
    const child = master.derive(pearlMultisigPath(0, 0));
    const compressed = child.publicKey;
    expect(compressed).toBeTruthy();
    expect(compressed!.length).toBe(33);
    // x-only = compressed[1:]
    expect(compressed!.slice(1).length).toBe(32);
  });

  it("different (vaultAccount, index) yield different pubkeys", async () => {
    const seed = await bip39.mnemonicToSeed(BIP86_MNEMONIC);
    const master = masterFromSeed(seed);
    const a = master.derive(pearlMultisigPath(0, 0)).publicKey!;
    const b = master.derive(pearlMultisigPath(0, 1)).publicKey!;
    const c = master.derive(pearlMultisigPath(1, 0)).publicKey!;
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(c).toString("hex"));
    expect(Buffer.from(b).toString("hex")).not.toBe(Buffer.from(c).toString("hex"));
  });
});
