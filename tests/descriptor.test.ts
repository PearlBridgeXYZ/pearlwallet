// Tests for the cosigner pubkey descriptor JSON format.
//
// This is the payload one Pearl user hands to another when enrolling
// in a vault. The parser must be strict: a silently-truncated or
// type-coerced descriptor results in the wrong vault address, which
// results in funds at an unspendable script.

import { describe, it, expect } from "vitest";
import {
  encodePubkeyDescriptor,
  parsePubkeyDescriptor,
  bytesToHex,
  hexToBytes,
} from "../src/crypto/descriptor";

function pk(byte: number): Uint8Array {
  const a = new Uint8Array(32);
  a.fill(byte);
  return a;
}

const GOOD_PATH = "m/86'/808276'/100'/0'/0";

describe("hex helpers", () => {
  it("bytesToHex produces lowercase, 2*n chars", () => {
    expect(bytesToHex(new Uint8Array([0xab, 0xcd, 0xef]))).toBe("abcdef");
    expect(bytesToHex(new Uint8Array([0x00, 0x0f]))).toBe("000f");
  });

  it("hexToBytes inverts bytesToHex for 32-byte payload", () => {
    const a = pk(0x42);
    expect(bytesToHex(hexToBytes(bytesToHex(a)))).toBe(bytesToHex(a));
  });

  it("hexToBytes rejects uppercase", () => {
    expect(() => hexToBytes("AB".repeat(32))).toThrow(/E_DESCRIPTOR_BAD_HEX/);
  });

  it("hexToBytes rejects wrong length", () => {
    expect(() => hexToBytes("ab".repeat(31))).toThrow(/E_DESCRIPTOR_BAD_HEX/);
    expect(() => hexToBytes("ab".repeat(33))).toThrow(/E_DESCRIPTOR_BAD_HEX/);
  });

  it("hexToBytes rejects non-hex chars", () => {
    expect(() => hexToBytes("zz".repeat(32))).toThrow(/E_DESCRIPTOR_BAD_HEX/);
  });
});

describe("encodePubkeyDescriptor", () => {
  it("round-trips through parsePubkeyDescriptor", () => {
    const xOnly = pk(0x42);
    const json = encodePubkeyDescriptor({
      xOnlyPubkey: xOnly,
      originPath: GOOD_PATH,
      label: "Alice",
    });
    const { descriptor, xOnlyPubkey } = parsePubkeyDescriptor(json);
    expect(descriptor.version).toBe(1);
    expect(descriptor.type).toBe("pearl-multisig-pubkey");
    expect(descriptor.network).toBe("mainnet");
    expect(descriptor.xOnlyPubkey).toBe(bytesToHex(xOnly));
    expect(descriptor.originPath).toBe(GOOD_PATH);
    expect(descriptor.label).toBe("Alice");
    expect(Buffer.from(xOnlyPubkey).toString("hex")).toBe(bytesToHex(xOnly));
  });

  it("output is human-readable JSON (pretty-printed)", () => {
    const json = encodePubkeyDescriptor({
      xOnlyPubkey: pk(0x01),
      originPath: GOOD_PATH,
      label: "X",
    });
    expect(json).toContain("\n");
    expect(json).toContain('"version": 1');
  });

  it("trims the label", () => {
    const json = encodePubkeyDescriptor({
      xOnlyPubkey: pk(0x01),
      originPath: GOOD_PATH,
      label: "  Bob  ",
    });
    const { descriptor } = parsePubkeyDescriptor(json);
    expect(descriptor.label).toBe("Bob");
  });

  it("rejects pubkey of wrong length", () => {
    expect(() =>
      encodePubkeyDescriptor({
        xOnlyPubkey: new Uint8Array(31),
        originPath: GOOD_PATH,
        label: "X",
      }),
    ).toThrow(/E_DESCRIPTOR_BAD_PUBKEY_LEN/);
  });

  it("rejects malformed origin path", () => {
    expect(() =>
      encodePubkeyDescriptor({
        xOnlyPubkey: pk(0x01),
        originPath: "not/a/path",
        label: "X",
      }),
    ).toThrow(/E_DESCRIPTOR_BAD_PATH/);
  });

  it("rejects empty / whitespace-only label", () => {
    expect(() =>
      encodePubkeyDescriptor({
        xOnlyPubkey: pk(0x01),
        originPath: GOOD_PATH,
        label: "   ",
      }),
    ).toThrow(/E_DESCRIPTOR_BAD_LABEL/);
  });

  it("rejects label > 64 chars", () => {
    expect(() =>
      encodePubkeyDescriptor({
        xOnlyPubkey: pk(0x01),
        originPath: GOOD_PATH,
        label: "x".repeat(65),
      }),
    ).toThrow(/E_DESCRIPTOR_BAD_LABEL/);
  });
});

describe("parsePubkeyDescriptor — strict shape", () => {
  function good(): Record<string, unknown> {
    return {
      version: 1,
      type: "pearl-multisig-pubkey",
      network: "mainnet",
      xOnlyPubkey: bytesToHex(pk(0x42)),
      originPath: GOOD_PATH,
      label: "Alice",
    };
  }

  it("accepts the canonical good descriptor", () => {
    const { descriptor } = parsePubkeyDescriptor(JSON.stringify(good()));
    expect(descriptor.label).toBe("Alice");
  });

  it("rejects non-JSON", () => {
    expect(() => parsePubkeyDescriptor("not json")).toThrow(/E_DESCRIPTOR_BAD_JSON/);
  });

  it("rejects JSON that isn't an object", () => {
    expect(() => parsePubkeyDescriptor("42")).toThrow(/E_DESCRIPTOR_BAD_SHAPE/);
    expect(() => parsePubkeyDescriptor("null")).toThrow(/E_DESCRIPTOR_BAD_SHAPE/);
    expect(() => parsePubkeyDescriptor("[]")).toThrow(/E_DESCRIPTOR_BAD_SHAPE/);
  });

  it("rejects version !== 1", () => {
    const o = good();
    o.version = 2;
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_VERSION/);
  });

  it("rejects wrong type tag", () => {
    const o = good();
    o.type = "something-else";
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_TYPE/);
  });

  it("rejects non-mainnet network", () => {
    const o = good();
    o.network = "testnet";
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_NETWORK/);
  });

  it("rejects bad pubkey hex", () => {
    const o = good();
    o.xOnlyPubkey = "deadbeef";
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_HEX/);
  });

  it("rejects non-string pubkey", () => {
    const o = good();
    o.xOnlyPubkey = 12345;
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_PUBKEY/);
  });

  it("rejects malformed path", () => {
    const o = good();
    o.originPath = "not/a/path";
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_PATH/);
  });

  it("rejects empty label after trim", () => {
    const o = good();
    o.label = "   ";
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_LABEL/);
  });

  it("rejects oversized label", () => {
    const o = good();
    o.label = "x".repeat(65);
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_LABEL/);
  });

  it("rejects non-string label", () => {
    const o = good();
    o.label = 42;
    expect(() => parsePubkeyDescriptor(JSON.stringify(o))).toThrow(/E_DESCRIPTOR_BAD_LABEL/);
  });
});
