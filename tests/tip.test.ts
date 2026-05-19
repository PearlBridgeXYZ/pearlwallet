import { describe, it, expect } from "vitest";
import {
  computeTipGrains,
  tipAddressFor,
  TIP_ADDRESS_MAINNET,
  TIP_MIN_GRAINS,
  TIP_BPS,
} from "../src/chains/pearl/tip";

describe("computeTipGrains", () => {
  it("applies 1 PRL floor on small sends", () => {
    // 100 PRL × 10 bps = 0.1 PRL → below 1 PRL floor → 1 PRL
    expect(computeTipGrains(100n * 100_000_000n)).toBe(TIP_MIN_GRAINS);
  });

  it("uses 10 bps once the basis-points tip exceeds the floor", () => {
    // 10_000 PRL × 10 bps = 10 PRL = 10*10^8 grains
    const amount = 10_000n * 100_000_000n;
    const expected = (amount * TIP_BPS) / 10_000n;
    expect(computeTipGrains(amount)).toBe(expected);
    expect(expected).toBe(10n * 100_000_000n);
  });

  it("returns 0 for non-positive send amounts", () => {
    expect(computeTipGrains(0n)).toBe(0n);
    expect(computeTipGrains(-1n)).toBe(0n);
  });

  it("never produces a sub-floor tip from a small but positive send", () => {
    expect(computeTipGrains(1n)).toBe(TIP_MIN_GRAINS);
    expect(computeTipGrains(100n)).toBe(TIP_MIN_GRAINS);
  });

  it("monotonically increases with send amount once past the floor", () => {
    const a = computeTipGrains(50_000n * 100_000_000n);
    const b = computeTipGrains(60_000n * 100_000_000n);
    expect(b).toBeGreaterThan(a);
  });
});

describe("tipAddressFor", () => {
  it("returns the mainnet tip address", () => {
    expect(tipAddressFor("mainnet")).toBe(TIP_ADDRESS_MAINNET);
  });

  it("returns the same address when called without argument", () => {
    expect(tipAddressFor()).toBe(TIP_ADDRESS_MAINNET);
  });

  it("tip address has prl1p prefix", () => {
    expect(TIP_ADDRESS_MAINNET.startsWith("prl1p")).toBe(true);
  });
});
