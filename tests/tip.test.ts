import { describe, it, expect } from "vitest";
import {
  computeTipGrains,
  tipAddressFor,
  TIP_ADDRESS_MAINNET,
  TIP_MIN_GRAINS,
  TIP_BPS,
} from "../src/chains/pearl/tip";

describe("computeTipGrains", () => {
  it("applies 1 PRL floor when send is >= floor but bps tip is below it", () => {
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

  it("returns 0 when the send is smaller than the floor (don't tip 100× principal)", () => {
    // v0.1.6 fix: a 0.01 PRL send carrying a 1 PRL tip would silently
    // 100× the user's outgoing total. Skip the tip entirely when send
    // is below the floor — bps-only tips kick in at >= 1 PRL.
    expect(computeTipGrains(1n)).toBe(0n);
    expect(computeTipGrains(100n)).toBe(0n);
    expect(computeTipGrains(TIP_MIN_GRAINS - 1n)).toBe(0n);
  });

  it("applies the floor at exactly the floor amount", () => {
    expect(computeTipGrains(TIP_MIN_GRAINS)).toBe(TIP_MIN_GRAINS);
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
