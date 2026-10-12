// R8 Q3 (Sonnet R5 F04) — the offline manual composer no longer pre-fills a
// 500,000-grain fee.
//
// Before: the fee field started at "500000" (about 2,000 times the fee of a
// 1-input, 2-output spend at the default 2 sat/vB, ~308 grains). The
// signer's acknowledgement guard asks only above 2 % of the inputs, so any
// manual spend of 0.25 PRL or more signed that default without a prompt.
//
// Now the field starts empty, and empty means the exact size of the
// entered spend (p2trKeyPathVsize) at Send's default feerate
// (manualDefaultFeeGrains); a typed fee is used as typed and the signer's
// high-fee acknowledgement guard is unchanged.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { manualDefaultFeeGrains, manualFeeInput } from "../src/ui/pages/OfflineSign";
import { DUST_LIMIT_GRAINS, PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE, p2trKeyPathVsize } from "../src/services/pearl-tx";
import { planManualSpend } from "../src/lib/offline-signing/manual-utxo";
import { checkPearlUnsignedFee } from "../src/lib/offline-signing/payload";

const plan = (n: number, totalIn: bigint, amount: bigint, typed = "") =>
  planManualSpend({
    totalInGrains: totalIn,
    amountGrains: amount,
    feeInput: manualFeeInput(typed, n, totalIn, amount),
    dustLimitGrains: DUST_LIMIT_GRAINS,
  });
/** A manual payload's fee check, as the signer runs it. */
function signerCheck(n: number, totalIn: bigint, amount: bigint, p: { feeGrains: bigint; changeGrains: bigint }) {
  const each = totalIn / BigInt(n);
  const utxos = Array.from({ length: n }, (_, i) => ({
    txid: (i + 1).toString(16).padStart(64, "0"), vout: 0,
    valueGrains: (i === n - 1 ? totalIn - each * BigInt(n - 1) : each).toString(),
    scriptHex: "5120" + "aa".repeat(32), poolIndex: 0,
  }));
  const outputs = [{ address: "prl1pdest", amountGrains: amount.toString() }];
  if (p.changeGrains > 0n) outputs.push({ address: "prl1pchange", amountGrains: p.changeGrains.toString() });
  return checkPearlUnsignedFee({ utxos, outputs, meta: { composedAt: 0, summary: "", feeGrains: p.feeGrains.toString() } } as never);
}

describe("R8 Q3 — manual offline composer fee default", () => {
  it("the default is Send's feerate on the exact size: 1 input, payment + change = 154 vB = 308 grains (not 500,000)", () => {
    expect(PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE).toBe(2n);
    expect(manualDefaultFeeGrains(1, 50_000_000n, 25_000_000n)).toBe(308n);
    expect(manualFeeInput("", 1, 50_000_000n, 25_000_000n)).toBe("308");
    expect(manualFeeInput("   ", 1, 50_000_000n, 25_000_000n)).toBe("308");
    expect(plan(1, 50_000_000n, 25_000_000n)).toEqual({ feeGrains: 308n, changeGrains: 24_999_692n });
    // The signer sees a normal fee: no acknowledgement needed, and the fee
    // is a few hundred grains, not 0.005 PRL.
    const c = signerCheck(1, 50_000_000n, 25_000_000n, plan(1, 50_000_000n, 25_000_000n));
    expect([c.feeGrains, c.needsAck, c.claimMismatch]).toEqual([308n, false, false]);
  });

  it("scales with the entered inputs (exact vsize × 2)", () => {
    for (const n of [1, 2, 3, 10, 253]) {
      const total = 10n ** 9n;
      expect(manualDefaultFeeGrains(n, total, 1_000_000n)).toBe(p2trKeyPathVsize(n, 2) * 2n);
      const p = plan(n, total, 1_000_000n);
      expect(signerCheck(n, total, 1_000_000n, p).feeGrains).toBe(p.feeGrains);
    }
  });

  it("no change output when what is left would be dust: the remainder is the fee (as in Send), at least the one-output fee", () => {
    // 100,000 in, 99,300 out: 700 left; with change 392 (< dust) → one output.
    const single = p2trKeyPathVsize(1, 1) * 2n;
    expect(single).toBe(222n);
    expect(manualDefaultFeeGrains(1, 100_000n, 99_300n)).toBe(700n);
    expect(plan(1, 100_000n, 99_300n)).toEqual({ feeGrains: 700n, changeGrains: 0n });
    // Change exactly at the dust limit after the two-output fee: kept.
    expect(plan(1, 100_000n, 100_000n - 308n - 546n)).toEqual({ feeGrains: 308n, changeGrains: 546n });
  });

  it("inputs that can't cover the payment plus the one-output fee are refused", () => {
    expect(manualDefaultFeeGrains(1, 100_000n, 99_900n)).toBe(222n);
    expect(() => plan(1, 100_000n, 99_900n)).toThrow(/^Insufficient/);
  });

  it("a typed fee is used as typed, and a high one still needs the signer's acknowledgement", () => {
    expect(manualFeeInput("1000", 1, 50_000_000n, 25_000_000n)).toBe("1000");
    expect(plan(1, 50_000_000n, 25_000_000n, "1000")).toEqual({ feeGrains: 1000n, changeGrains: 24_999_000n });
    expect(() => plan(1, 50_000_000n, 25_000_000n, "12abc")).toThrow(/whole number of grains/);
    const high = plan(1, 50_000_000n, 25_000_000n, "1500000"); // 3 % of the inputs
    expect(signerCheck(1, 50_000_000n, 25_000_000n, high)).toMatchObject({ highFee: true, needsAck: true });
  });

  it("the page starts with an empty fee field, never a fixed amount, and routes the empty field through the default", () => {
    const page = readFileSync("src/ui/pages/OfflineSign.tsx", "utf8");
    expect(page).toMatch(/const \[feeGrainsInput, setFeeGrainsInput\] = useState\(""\);/);
    expect(page).not.toMatch(/(?<![0-9_])500_?000(?![0-9_])/);
    expect(page).not.toMatch(/setFeeGrainsInput\("\d/);
    expect(page).toMatch(/feeInput: manualFeeInput\(feeGrainsInput, inputs\.length, totalIn, amountGrains\),/);
  });
});
