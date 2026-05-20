import { describe, it, expect } from "vitest";
import {
  formatGrains,
  formatWei,
  parsePRL,
  parseWPRL,
  parseDecimal,
  formatUSD,
  shortAddr,
} from "../src/lib/format";

describe("parsePRL / formatGrains round-trip", () => {
  it("parses and formats whole PRL", () => {
    expect(parsePRL("1")).toBe(100_000_000n);
    expect(formatGrains(100_000_000n)).toBe("1.0");
  });

  it("parses 8 decimal places (max precision)", () => {
    expect(parsePRL("0.00000001")).toBe(1n);
    expect(formatGrains(1n)).toBe("0.00000001");
  });

  it("rejects more than 8 decimals for PRL", () => {
    expect(() => parsePRL("0.000000001")).toThrow(/E_TOO_MANY_DECIMALS/);
  });

  it("parses arbitrary precision (no float loss)", () => {
    expect(parsePRL("12345.67890123")).toBe(1_234_567_890_123n);
    expect(formatGrains(1_234_567_890_123n)).toBe("12345.67890123");
  });

  it("rejects garbage strings", () => {
    expect(() => parsePRL("abc")).toThrow();
    expect(() => parsePRL("")).toThrow();
    expect(() => parsePRL(".")).toThrow();
  });

  it("handles trim and trailing zero stripping", () => {
    expect(parsePRL("  1.50  ")).toBe(150_000_000n);
    expect(formatGrains(150_000_000n)).toBe("1.5");
  });
});

describe("parseWPRL / formatWei", () => {
  it("uses 18 decimals", () => {
    expect(parseWPRL("1")).toBe(10n ** 18n);
    expect(formatWei(10n ** 18n)).toBe("1.0");
  });

  it("rejects more than 18 decimals", () => {
    expect(() => parseWPRL("0." + "0".repeat(18) + "1")).toThrow();
  });
});

describe("parseDecimal sign handling", () => {
  // v0.1.6 hardening: every caller (SendPRL/SendWPRL/Bridge amount fields)
  // is a positive transfer amount. A silently-coerced negative would
  // underflow downstream balance checks, so the boundary now rejects it.
  it("rejects negatives", () => {
    expect(() => parseDecimal("-1.5", 8)).toThrow(/E_INVALID_AMOUNT/);
  });
});

describe("formatUSD", () => {
  it("formats with 2 decimal places", () => {
    expect(formatUSD(1234.5)).toBe("$1,234.50");
  });
});

describe("shortAddr", () => {
  it("preserves short addresses untouched", () => {
    expect(shortAddr("0x1234")).toBe("0x1234");
  });

  it("truncates long addresses", () => {
    const long = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";
    const out = shortAddr(long, 12, 8);
    expect(out).toBe("prl1p5f450a5…dsmw4yvs");
  });
});
