import { describe, expect, it } from "vitest";
import { applyMnemonicPaste, parseMnemonicPaste } from "../src/lib/mnemonic-paste";

const WORDS_12 = [
  "abandon",
  "ability",
  "able",
  "about",
  "above",
  "absent",
  "absorb",
  "abstract",
  "absurd",
  "abuse",
  "access",
  "accident",
];

const WORDS_24 = [
  ...WORDS_12,
  "account",
  "accuse",
  "achieve",
  "acid",
  "acoustic",
  "acquire",
  "across",
  "act",
  "action",
  "actor",
  "actress",
  "actual",
];

describe("parseMnemonicPaste", () => {
  it("returns empty array on empty input", () => {
    expect(parseMnemonicPaste("")).toEqual([]);
    expect(parseMnemonicPaste("   ")).toEqual([]);
  });

  it("splits on plain spaces", () => {
    expect(parseMnemonicPaste("apple banana cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("splits on newlines and tabs", () => {
    expect(parseMnemonicPaste("apple\nbanana\tcherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("handles CRLF", () => {
    expect(parseMnemonicPaste("apple\r\nbanana\r\ncherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("lowercases everything", () => {
    expect(parseMnemonicPaste("APPLE Banana CHERry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '1.' style prefixes with space", () => {
    expect(parseMnemonicPaste("1. apple 2. banana 3. cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '1)' style prefixes with space", () => {
    expect(parseMnemonicPaste("1) apple 2) banana 3) cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '1:' style prefixes with space", () => {
    expect(parseMnemonicPaste("1: apple 2: banana 3: cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '1-' style prefixes with space", () => {
    expect(parseMnemonicPaste("1- apple 2- banana 3- cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '(1)' parenthesized prefixes", () => {
    expect(parseMnemonicPaste("(1) apple (2) banana (3) cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '1.word' no-space prefixes", () => {
    expect(parseMnemonicPaste("1.apple 2.banana 3.cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '1)word' no-space prefixes", () => {
    expect(parseMnemonicPaste("1)apple 2)banana 3)cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("strips '1word' fused prefixes (no separator)", () => {
    expect(parseMnemonicPaste("1apple 2banana 3cherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("drops bare-digit position labels on separate lines", () => {
    expect(parseMnemonicPaste("1\napple\n2\nbanana\n3\ncherry")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("handles two-digit indices", () => {
    expect(parseMnemonicPaste("11. apple 12. banana")).toEqual([
      "apple",
      "banana",
    ]);
    expect(parseMnemonicPaste("(11) apple (12) banana")).toEqual([
      "apple",
      "banana",
    ]);
    expect(parseMnemonicPaste("11)apple 12)banana")).toEqual([
      "apple",
      "banana",
    ]);
  });

  it("does NOT strip 3+ digit runs (those are garbage, leave for validator)", () => {
    expect(parseMnemonicPaste("123apple 456banana")).toEqual([
      "123apple",
      "456banana",
    ]);
  });

  it("handles a real 12-word numbered paste", () => {
    const raw = WORDS_12.map((w, i) => `${i + 1}. ${w}`).join("\n");
    expect(parseMnemonicPaste(raw)).toEqual(WORDS_12);
  });

  it("handles a real 24-word numbered paste", () => {
    const raw = WORDS_24.map((w, i) => `${i + 1}) ${w}`).join(" ");
    expect(parseMnemonicPaste(raw)).toEqual(WORDS_24);
  });

  it("handles ragged whitespace", () => {
    expect(parseMnemonicPaste("  apple   banana\t\tcherry\n\n")).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("preserves typos as-is for downstream BIP-39 validation", () => {
    expect(parseMnemonicPaste("1. aapple 2. bnana")).toEqual([
      "aapple",
      "bnana",
    ]);
  });
});

describe("applyMnemonicPaste", () => {
  it("snaps to 12 and replaces grid on a 12-word paste", () => {
    const current = Array(24).fill("");
    const result = applyMnemonicPaste(WORDS_12, current, 24, 5);
    expect(result.bulkApplied).toBe(true);
    expect(result.length).toBe(12);
    expect(result.words).toEqual(WORDS_12);
  });

  it("snaps to 24 and replaces grid on a 24-word paste", () => {
    const current = Array(12).fill("");
    const result = applyMnemonicPaste(WORDS_24, current, 12, 0);
    expect(result.bulkApplied).toBe(true);
    expect(result.length).toBe(24);
    expect(result.words).toEqual(WORDS_24);
  });

  it("ignores startIndex on a 12-word bulk paste", () => {
    const current = ["pre1", "pre2", "pre3", ...Array(9).fill("")];
    const result = applyMnemonicPaste(WORDS_12, current, 12, 7);
    expect(result.bulkApplied).toBe(true);
    expect(result.words).toEqual(WORDS_12);
  });

  it("partial paste fills from startIndex without changing length", () => {
    const current = Array(12).fill("");
    const result = applyMnemonicPaste(
      ["apple", "banana", "cherry"],
      current,
      12,
      3,
    );
    expect(result.bulkApplied).toBe(false);
    expect(result.length).toBe(12);
    expect(result.words[3]).toBe("apple");
    expect(result.words[4]).toBe("banana");
    expect(result.words[5]).toBe("cherry");
    expect(result.words[0]).toBe("");
    expect(result.words[6]).toBe("");
  });

  it("partial paste truncates when it runs off the end of the grid", () => {
    const current = Array(12).fill("");
    const result = applyMnemonicPaste(
      ["a", "b", "c", "d", "e"],
      current,
      12,
      10,
    );
    expect(result.bulkApplied).toBe(false);
    expect(result.length).toBe(12);
    expect(result.words[10]).toBe("a");
    expect(result.words[11]).toBe("b");
    expect(result.words.length).toBe(12);
  });

  it("partial paste preserves words before startIndex", () => {
    const current = ["pre1", "pre2", "pre3", ...Array(9).fill("")];
    const result = applyMnemonicPaste(["x", "y"], current, 12, 3);
    expect(result.words[0]).toBe("pre1");
    expect(result.words[1]).toBe("pre2");
    expect(result.words[2]).toBe("pre3");
    expect(result.words[3]).toBe("x");
    expect(result.words[4]).toBe("y");
  });

  it("defensively normalizes an oversized current array", () => {
    const current = Array(20).fill("oops");
    const result = applyMnemonicPaste(["a"], current, 12, 0);
    expect(result.words.length).toBe(12);
  });

  it("defensively normalizes an undersized current array", () => {
    const current = Array(3).fill("oops");
    const result = applyMnemonicPaste(["a"], current, 12, 0);
    expect(result.words.length).toBe(12);
  });
});

describe("parseMnemonicPaste + applyMnemonicPaste integration", () => {
  it("end-to-end: numbered 12-word paste lands in a clean grid", () => {
    const raw = WORDS_12.map((w, i) => `${i + 1}. ${w}`).join("\n");
    const parsed = parseMnemonicPaste(raw);
    const result = applyMnemonicPaste(parsed, Array(12).fill(""), 12, 0);
    expect(result.words).toEqual(WORDS_12);
    expect(result.length).toBe(12);
    expect(result.bulkApplied).toBe(true);
  });

  it("end-to-end: 24-word parenthesized paste snaps length up from 12", () => {
    const raw = WORDS_24.map((w, i) => `(${i + 1}) ${w}`).join(" ");
    const parsed = parseMnemonicPaste(raw);
    const result = applyMnemonicPaste(parsed, Array(12).fill(""), 12, 0);
    expect(result.words).toEqual(WORDS_24);
    expect(result.length).toBe(24);
    expect(result.bulkApplied).toBe(true);
  });

  it("end-to-end: partial paste mid-grid keeps length", () => {
    const parsed = parseMnemonicPaste("apple banana cherry");
    const result = applyMnemonicPaste(parsed, Array(12).fill(""), 12, 6);
    expect(result.length).toBe(12);
    expect(result.bulkApplied).toBe(false);
    expect(result.words[6]).toBe("apple");
    expect(result.words[7]).toBe("banana");
    expect(result.words[8]).toBe("cherry");
  });

  it("end-to-end: 'two-pass numbering' shape is normalized", () => {
    const raw = WORDS_12
      .map((w, i) => `${i + 1}\n${w}`)
      .join("\n");
    const parsed = parseMnemonicPaste(raw);
    expect(parsed).toEqual(WORDS_12);
    const result = applyMnemonicPaste(parsed, Array(12).fill(""), 12, 0);
    expect(result.words).toEqual(WORDS_12);
    expect(result.bulkApplied).toBe(true);
  });
});
