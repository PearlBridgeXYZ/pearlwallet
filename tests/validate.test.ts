// v0.1.7: tests for the shared passwordAcceptable() helper that gates
// onboarding-create / onboarding-restore / settings-change-password
// flows. Closes L8 — keystore password floor.

import { describe, it, expect } from "vitest";
import {
  passwordAcceptable,
  passwordStrength,
  MIN_PASSWORD_LENGTH,
  validEth,
  validPearl,
} from "../src/lib/validate";

describe("passwordAcceptable — L8 floor", () => {
  it("MIN_PASSWORD_LENGTH is at least 10", () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(10);
  });

  it("rejects passwords shorter than MIN_PASSWORD_LENGTH", () => {
    const out = passwordAcceptable("abc12!");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/at least/);
  });

  it("rejects a mid-length mono-class password (10–15 chars, one class only)", () => {
    // 10 chars (= MIN_PASSWORD_LENGTH) all lowercase → still rejected.
    // v0.1.8 only opens an escape hatch at PASSPHRASE_MIN_LENGTH (16+).
    const out = passwordAcceptable("aaaaaaaaaa");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/two of/);
  });

  it("rejects a 15-char mono-class digits password", () => {
    const out = passwordAcceptable("123456789012345");
    expect(out.ok).toBe(false);
  });

  it("accepts a long mono-class passphrase (16+ chars, one class)", () => {
    // v0.1.8 (opus2 cross-Low): a 16-char all-lowercase string draws
    // its entropy from length, not class diversity. The classic XKCD
    // passphrase shape should not be rejected.
    expect(passwordAcceptable("correcthorsebatterystaple").ok).toBe(true);
    expect(passwordAcceptable("aaaaaaaaaaaaaaaa").ok).toBe(true); // 16 a's
  });

  it("accepts a passphrase mixing lower and digits", () => {
    const out = passwordAcceptable("correct-horse-battery-staple-2026");
    expect(out.ok).toBe(true);
  });

  it("accepts upper+lower combo at minimum length", () => {
    const out = passwordAcceptable("AbcAbcAbcA");
    expect(out.ok).toBe(true);
  });

  it("accepts upper+symbol combo", () => {
    const out = passwordAcceptable("ABCDEF!@#$");
    expect(out.ok).toBe(true);
  });

  it("the message references the exact MIN_PASSWORD_LENGTH constant", () => {
    const out = passwordAcceptable("x");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain(String(MIN_PASSWORD_LENGTH));
  });
});

describe("passwordStrength — heuristic labels (unchanged in v0.1.7)", () => {
  it("returns a score 0..4 with a non-empty label", () => {
    const out = passwordStrength("abc");
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(4);
    expect(typeof out.label).toBe("string");
    expect(out.label.length).toBeGreaterThan(0);
  });

  it("scores a long mixed password >= 3", () => {
    const out = passwordStrength("Tr0ub4dor&3-strong");
    expect(out.score).toBeGreaterThanOrEqual(3);
  });
});

describe("validEth", () => {
  it("accepts a valid checksummed address", () => {
    expect(validEth("0x07696DcaB55E62cfef953666b29Fe1970518cB00")).toBe(true);
  });

  it("accepts a valid all-lowercase address", () => {
    expect(validEth("0x07696dcab55e62cfef953666b29fe1970518cb00")).toBe(true);
  });

  it("rejects too-short input", () => {
    expect(validEth("0xabc")).toBe(false);
  });

  it("rejects non-hex content", () => {
    expect(validEth("0xnotanaddressreallyno0123456789012345678900")).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    expect(validEth("   0x07696DcaB55E62cfef953666b29Fe1970518cB00   ")).toBe(true);
  });
});

describe("validPearl", () => {
  it("accepts the canonical mainnet PearlLock address", () => {
    expect(
      validPearl("prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs", "mainnet"),
    ).toBe(true);
  });

  it("rejects junk that's not bech32m", () => {
    expect(validPearl("not-a-real-address", "mainnet")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(validPearl("", "mainnet")).toBe(false);
  });
});
