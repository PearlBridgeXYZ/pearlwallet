// Send-flow simulation. Currently the wallet's broadcast path is
// stubbed (`Live PRL send … in progress`) — so we simulate by:
//   1. validating the destination address shape (validPearl)
//   2. parsing the amount (parsePRL)
//   3. computing fees + tip (matching the preview UI math)
//   4. asserting Total = amount + fee + tip
//
// This pins the math the preview screen will display, so any
// regression in tip/fee composition fails CI before it hits a real
// broadcast.

import { describe, it, expect } from "vitest";
import { validPearl } from "../src/lib/validate";
import { parsePRL, formatGrains } from "../src/lib/format";
import { computeTipGrains, tipAddressFor } from "../src/chains/pearl/tip";

const G_ADDR = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";

const FEE_BY_TIER: Record<"low" | "normal" | "high", bigint> = {
  low: 1000n,
  normal: 5000n,
  high: 20000n,
};

function buildSendPreview(opts: {
  destination: string;
  amount: string;
  feeTier: "low" | "normal" | "high";
  tipEnabled: boolean;
}) {
  if (!validPearl(opts.destination, "mainnet")) {
    throw new Error("E_INVALID_DESTINATION");
  }
  const amount = parsePRL(opts.amount);
  if (amount <= 0n) throw new Error("E_AMOUNT_NONPOSITIVE");
  const fee = FEE_BY_TIER[opts.feeTier];
  const tip = opts.tipEnabled ? computeTipGrains(amount) : 0n;
  return { amount, fee, tip, total: amount + fee + tip };
}

describe("Send-preview math (simulated tx composition)", () => {
  it("validates address, parses amount, sums total — with tip", () => {
    const r = buildSendPreview({
      destination: G_ADDR,
      amount: "100",
      feeTier: "normal",
      tipEnabled: true,
    });
    expect(r.amount).toBe(100n * 100_000_000n);
    expect(r.fee).toBe(5000n);
    // 100 PRL × 10 bps = 0.1 PRL → 1 PRL floor → 100_000_000 grains
    expect(r.tip).toBe(100_000_000n);
    expect(r.total).toBe(100n * 100_000_000n + 5000n + 100_000_000n);
    expect(formatGrains(r.total)).toBe("101.00005");
  });

  it("composes total correctly without a tip", () => {
    const r = buildSendPreview({
      destination: G_ADDR,
      amount: "50",
      feeTier: "high",
      tipEnabled: false,
    });
    expect(r.tip).toBe(0n);
    expect(r.total).toBe(50n * 100_000_000n + 20_000n);
  });

  it("tip recipient is the canonical mainnet tip address", () => {
    expect(tipAddressFor("mainnet")).toMatch(/^prl1p/);
    expect(tipAddressFor("mainnet").length).toBe(63);
  });

  it("rejects non-prl addresses", () => {
    expect(() => buildSendPreview({
      destination: "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9",
      amount: "1",
      feeTier: "normal",
      tipEnabled: false,
    })).toThrow(/E_INVALID_DESTINATION/);
  });

  it("rejects zero-amount sends", () => {
    expect(() => buildSendPreview({
      destination: G_ADDR,
      amount: "0",
      feeTier: "normal",
      tipEnabled: true,
    })).toThrow(/E_AMOUNT_NONPOSITIVE/);
  });

  it("at large send amounts the bps tip dominates the floor", () => {
    const r = buildSendPreview({
      destination: G_ADDR,
      amount: "10000",
      feeTier: "low",
      tipEnabled: true,
    });
    // 10_000 PRL × 10 bps = 10 PRL = 10*10^8 grains  > 1 PRL floor
    expect(r.tip).toBe(10n * 100_000_000n);
  });
});
