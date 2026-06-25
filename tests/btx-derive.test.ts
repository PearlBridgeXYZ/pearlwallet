import { describe, it, expect } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { deriveBtxAccount, btxMasterIkm, deriveBtxAddressFromSeed } from "../src/chains/btx/derive";

// GOLDEN VECTOR from a real btxd node (deriveaddresses / listdescriptors on a
// throwaway wallet): master IKM 1c3ee382… at m/87h/0h/0h/0/0 produces this
// default 2-leaf (ML-DSA + SLH-DSA) address. If this ever fails, the derivation
// no longer matches btxd — DO NOT ship; funds would be unrecoverable.
const GOLDEN_IKM = "1c3ee38248427f90751b8f098493592432ea4eb78aa1ba587445d0b6cb938bd7";
const GOLDEN_ADDR = "btx1z8ln9ar77vt5aty603rjajhcx90udeaw6zxnrsfla8ee470wqja4qa22k9f";

describe("BTX key derivation — byte-exact vs btxd golden vector", () => {
  it("reproduces the btxd golden address from the master IKM (change=0,index=0)", () => {
    const acct = deriveBtxAccount(hexToBytes(GOLDEN_IKM), 0, 0);
    expect(acct.address).toBe(GOLDEN_ADDR);
    expect(acct.mldsaPublicKey.length).toBe(1312);
    expect(acct.slhdsaPublicKey.length).toBe(32);
    expect(acct.mldsaSecretKey).toBeUndefined(); // not requested
  });

  it("returns the ML-DSA secret (2560B) only when withSecret=true", () => {
    const acct = deriveBtxAccount(hexToBytes(GOLDEN_IKM), 0, 0, true);
    expect(acct.address).toBe(GOLDEN_ADDR); // same address regardless of withSecret
    expect(acct.mldsaSecretKey?.length).toBe(2560);
  });

  it("change and index produce distinct addresses", () => {
    const ikm = hexToBytes(GOLDEN_IKM);
    const a = deriveBtxAccount(ikm, 0, 0).address;
    const b = deriveBtxAccount(ikm, 0, 1).address;
    const c = deriveBtxAccount(ikm, 1, 0).address;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("wallet master IKM is deterministic from the BIP-39 seed", () => {
    const seed = hexToBytes("00".repeat(64));
    expect(btxMasterIkm(seed)).toEqual(btxMasterIkm(seed));
    // and the full seed->address path is deterministic + valid btx1z…
    const addr = deriveBtxAddressFromSeed(seed, 0);
    expect(addr).toBe(deriveBtxAddressFromSeed(seed, 0));
    expect(addr.startsWith("btx1z")).toBe(true);
  });
});
