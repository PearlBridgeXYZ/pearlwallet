// Paste-into-mnemonic-grid normalization.
//
// People paste seed phrases from a dozen different sources:
//
//   "1. apple 2. banana 3. cherry ..."
//   "1) apple\n2) banana\n3) cherry"
//   "1: apple\n2: banana"
//   "(1) apple (2) banana"
//   "1 apple 2 banana 3 cherry"
//   "apple\nbanana\ncherry"
//   "apple banana cherry"
//   "  APPLE   Banana\tcherry\r\n"
//
// This module is a pure tokenizer: it accepts any of the above shapes
// and returns a clean lowercased word array. The wallet UI binds it to
// the onPaste handler on every cell so a user can paste anywhere and
// the grid fills itself.
//
// Out of scope: BIP-39 validation (that's the crypto worker's job — we
// just normalize the shape; the worker still rejects words that aren't
// in the wordlist). This means a paste containing a typo lands in the
// grid, the user can see and fix it, and "Restore" surfaces the real
// error message.

/**
 * Parse arbitrary pasted text into mnemonic word tokens.
 *
 * Strategy:
 *  1. Split on any whitespace run (\s+) — covers spaces, tabs, newlines,
 *     CRLF, ideographic space, etc.
 *  2. For each token, strip a leading index prefix matching common
 *     numbering shapes: "1.", "1)", "1:", "1-", "(1)", or bare "1".
 *     The strip happens on the START only — internal punctuation in a
 *     word (which BIP-39 wordlists don't have anyway) is preserved so
 *     a buggy paste can be surfaced as a validation error instead of
 *     silently massaged.
 *  3. Lowercase and drop tokens that are empty after stripping.
 *  4. Tokens that are PURE digits after the strip (e.g. someone pasted
 *     "1\napple\n2\nbanana" — two-pass numbering on separate lines)
 *     are dropped. BIP-39 wordlists contain no all-digit words, so a
 *     bare number is unambiguously a position label, not a word.
 *
 * Returns the cleaned array. Empty input → empty array.
 */
export function parseMnemonicPaste(raw: string): string[] {
  if (!raw) return [];
  // Split on any unicode whitespace.
  const rough = raw.split(/\s+/);
  const out: string[] = [];
  for (const tok of rough) {
    if (!tok) continue;
    const stripped = stripLeadingIndex(tok).toLowerCase();
    if (!stripped) continue;
    // Drop bare-number tokens: position labels on separate lines.
    if (/^\d+$/.test(stripped)) continue;
    out.push(stripped);
  }
  return out;
}

/**
 * Strip a leading index prefix from a token. Recognized shapes:
 *   "1." / "12."           → ""
 *   "1)" / "12)"           → ""
 *   "1:" / "12:"           → ""
 *   "1-" / "12-"           → ""
 *   "(1)" / "(12)"         → ""
 *   "1word" / "12word"     → "word"   (no separator — common on phones)
 *   "1.word" / "12)word"   → "word"   (no space after the punctuation)
 *
 * A bare "1" with no following character is preserved (returned as-is)
 * — parseMnemonicPaste filters all-digit tokens out separately so we
 * don't lose information at THIS layer.
 *
 * Multi-digit prefixes are capped at 2 digits — BIP-39 supports up to
 * 24 words, so a 3+ digit run isn't an index, it's garbage and we
 * leave it intact for the validator to flag.
 */
function stripLeadingIndex(tok: string): string {
  // "(N)" or "(N)word" — N is 1-2 digits, then closing paren
  const paren = /^\((\d{1,2})\)(?!\d)(.*)$/.exec(tok);
  if (paren) return paren[2]!.replace(/^[.\):\-\s]+/, "");
  // "N.word" / "N)word" / "N:word" / "N-word" / "Nword"
  // Negative lookahead on \d to keep 3+ digit runs intact — those aren't
  // indices, they're garbage we want the BIP-39 validator to flag.
  const lead = /^(\d{1,2})(?!\d)([.\):\-]?)(.*)$/.exec(tok);
  if (lead) {
    const [, , , rest] = lead;
    // If there's nothing after the digits+separator, return empty so
    // the caller drops the token (it was a bare position label).
    if (!rest) return "";
    return rest;
  }
  return tok;
}

/**
 * Apply a parsed-paste array to the existing grid, returning the new
 * grid and the new length the UI should snap to.
 *
 * Rules:
 *  - Pasting EXACTLY 12 or 24 words → snap length to that count and
 *    replace the whole grid. Pasted at cell #5? Doesn't matter — the
 *    user clearly meant "here is the whole thing."
 *  - Pasting any other count → fill starting at `startIndex`, do NOT
 *    change the grid length. Truncates if the paste runs off the end.
 *  - Pasting 1 token → just set the current cell (caller can ignore
 *    the paste handler and let the browser's default `onChange` fire).
 *
 * The returned `length` is one of 12 | 24; callers using a smaller
 * grid will need to grow it via the existing setLen() shape.
 */
export interface ApplyPasteResult {
  words: string[];
  length: 12 | 24;
  /** True if the paste replaced the whole grid (12 or 24 word case). */
  bulkApplied: boolean;
}

export function applyMnemonicPaste(
  pasted: string[],
  current: string[],
  currentLength: 12 | 24,
  startIndex: number,
): ApplyPasteResult {
  if (pasted.length === 12 || pasted.length === 24) {
    const len = pasted.length as 12 | 24;
    const words = new Array<string>(len).fill("");
    for (let i = 0; i < len; i++) words[i] = pasted[i] ?? "";
    return { words, length: len, bulkApplied: true };
  }
  // Partial paste — fill from startIndex without changing the grid size.
  const words = current.slice();
  // Make sure the array matches the declared length (defensive — a
  // caller mutation could leave it off-by-one).
  while (words.length < currentLength) words.push("");
  if (words.length > currentLength) words.length = currentLength;
  for (let i = 0; i < pasted.length; i++) {
    const slot = startIndex + i;
    if (slot >= currentLength) break;
    words[slot] = pasted[i] ?? "";
  }
  return { words, length: currentLength, bulkApplied: false };
}
