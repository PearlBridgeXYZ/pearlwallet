import { describe, it, expect } from "vitest";
import {
  decodeTaprootAddress,
  encodeTaprootAddress,
  isValidPearlAddress,
  bip86Tweak,
  pearlAddressFromInternalKey,
} from "../src/chains/pearl/address";
import { pearlParams, PEARL_MAINNET } from "../src/chains/pearl/network";

const params = pearlParams("mainnet");

// BIP-86 reference vector (BIP-86 test vector 1) — internal pubkey + tweaked
// output pubkey. We only swap the HRP from "bc" → "prl"; the tweak and the
// 32-byte output key are identical regardless of HRP.
const BIP86_VECTOR_1 = {
  // m/86'/0'/0'/0/0 internal x-only pubkey from BIP-86 test vector 1
  internalXOnly: "cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115",
  // Output key after TapTweak with empty merkle root.
  outputXOnly: "a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
};

describe("BIP-86 tweak math", () => {
  it("matches BIP-86 test vector 1", () => {
    const internal = Buffer.from(BIP86_VECTOR_1.internalXOnly, "hex");
    const tweaked = bip86Tweak(new Uint8Array(internal));
    const hex = Buffer.from(tweaked).toString("hex");
    expect(hex).toBe(BIP86_VECTOR_1.outputXOnly);
  });

  it("rejects non-32-byte internal keys", () => {
    expect(() => bip86Tweak(new Uint8Array(31))).toThrow();
    expect(() => bip86Tweak(new Uint8Array(33))).toThrow();
  });
});

describe("encode/decode round-trip", () => {
  it("round-trips a fresh 32-byte output key", () => {
    const outputKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) outputKey[i] = (i * 7 + 3) & 0xff;
    const addr = encodeTaprootAddress(outputKey, params);
    expect(addr.startsWith("prl1p")).toBe(true);
    const decoded = decodeTaprootAddress(addr, params);
    expect(Array.from(decoded)).toEqual(Array.from(outputKey));
  });

  it("round-trips BIP-86 vector 1 output key into a prl1p address", () => {
    const outputKey = new Uint8Array(Buffer.from(BIP86_VECTOR_1.outputXOnly, "hex"));
    const addr = encodeTaprootAddress(outputKey, params);
    expect(addr.startsWith("prl1p")).toBe(true);
    const decoded = decodeTaprootAddress(addr, params);
    expect(Buffer.from(decoded).toString("hex")).toBe(BIP86_VECTOR_1.outputXOnly);
  });

  it("derives identical address from internal pubkey + tweak", () => {
    const internal = new Uint8Array(Buffer.from(BIP86_VECTOR_1.internalXOnly, "hex"));
    const addrViaTweak = pearlAddressFromInternalKey(internal, params);
    const expectedOutput = new Uint8Array(Buffer.from(BIP86_VECTOR_1.outputXOnly, "hex"));
    const addrDirect = encodeTaprootAddress(expectedOutput, params);
    expect(addrViaTweak).toBe(addrDirect);
  });
});

describe("isValidPearlAddress", () => {
  it("accepts a well-formed prl1p address", () => {
    expect(isValidPearlAddress(
      "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs",
      params,
    )).toBe(true);
  });

  it("rejects a BTC bech32m address (wrong HRP)", () => {
    expect(isValidPearlAddress(
      "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9",
      params,
    )).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isValidPearlAddress("hello world", params)).toBe(false);
    expect(isValidPearlAddress("", params)).toBe(false);
    expect(isValidPearlAddress("prl1qpzry9x8gf2tvdw0s3jn54khce6mua7l", params)).toBe(false);
  });

  it("rejects a corrupted checksum", () => {
    const corrupted = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvt";
    expect(isValidPearlAddress(corrupted, params)).toBe(false);
  });
});

describe("HRP guard", () => {
  it("PEARL_MAINNET.hrp is prl", () => {
    expect(PEARL_MAINNET.hrp).toBe("prl");
  });
});
