import { isAddress } from "viem";
import { isValidPearlAddress } from "../chains/pearl/address";
import { pearlParams, type PearlNetwork } from "../chains/pearl/network";

export function validPearl(addr: string, net: PearlNetwork): boolean {
  return isValidPearlAddress(addr.trim(), pearlParams(net));
}

export function validEth(addr: string): boolean {
  try {
    return isAddress(addr.trim());
  } catch {
    return false;
  }
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

/** Lightweight strength heuristic. (zxcvbn deferred to keep bundle small in v1 scaffold.) */
export function passwordStrength(password: string): PasswordStrength {
  const len = password.length;
  let score = 0;
  if (len >= 8) score++;
  if (len >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  const labels = ["too short", "weak", "ok", "strong", "very strong"];
  return { score: Math.min(score, 4) as PasswordStrength["score"], label: labels[Math.min(score, 4)]! };
}

export const MIN_PASSWORD_LENGTH = 10;

// Above this length we relax the class-mix requirement. A 16-char
// all-lowercase string ("correcthorsebatterystaple") has ~70 bits of
// entropy when drawn from a 7k-word list — substantially stronger
// than "Aa1!aaaa" (8 chars, 4 classes, ~25 bits). The class rule was
// a proxy for entropy that hurt non-Latin-script users (a CJK
// passphrase is "symbol class only" by our regex) and rejected the
// XKCD passphrase pattern. v0.1.7 audit cross-Low.
export const PASSPHRASE_MIN_LENGTH = 16;

/**
 * Single source of truth for "can this password protect a keystore?".
 * Used by both create and changePassword flows so the bar can't drift
 * between them. A password that's only 10 chars but all one type ("aaaaaaaaaa")
 * passes the length gate but fails the kind gate — keystore is the
 * user's last line of defense against a brief device-access attacker
 * and weak passwords let 600k PBKDF2 iterations get brute-forced offline.
 */
export function passwordAcceptable(password: string): { ok: true } | { ok: false; reason: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  // Long enough → entropy from length CAN carry it, but only if the
  // input isn't degenerate. v0.1.8 audit (Opus1 M-1, Minimax1 M-1):
  // "1234567890123456" (16 digits) passed the length gate and skipped
  // the class-mix gate, giving an attacker a ~10^16 (~53 bits) keyspace
  // against 600k PBKDF2 iterations — brute-forceable in hours on a GPU.
  // The escape hatch's purpose is the XKCD-style multi-word passphrase
  // ("correcthorsebatterystaple") which has real per-character entropy;
  // an all-digit or all-same-char string of any length does not.
  if (password.length >= PASSPHRASE_MIN_LENGTH) {
    if (hasDegenerateEntropy(password)) {
      return {
        ok: false,
        reason:
          "Passphrase needs real character variety. Avoid all-digit, all-same-character, or trivial-pattern strings — use multiple words or mix in different character types.",
      };
    }
    return { ok: true };
  }
  // Shorter passwords (10–15 chars) still need two classes — the floor
  // hasn't moved, only the passphrase escape hatch is new.
  if (classes < 2) {
    return { ok: false, reason: `Use at least two of lowercase / uppercase / digit / symbol, or make it ${PASSPHRASE_MIN_LENGTH}+ characters.` };
  }
  return { ok: true };
}

/**
 * Heuristic: a "passphrase" with no real entropy. Conservative — we want
 * to reject the obvious low-entropy patterns (all-digit, all-same-char,
 * monotonic sequences) without ever rejecting a legitimate XKCD-style
 * passphrase or a non-Latin-script passphrase.
 *
 * Returns true when the input looks degenerate. Defense in depth: a user
 * who insists on "1234567890123456" can defeat this by adding a single
 * letter, but the deliberate "pick two words" pattern always passes.
 */
function hasDegenerateEntropy(password: string): boolean {
  // All-digit: 10-char alphabet → ~3.3 bits per char. 16 digits = 53 bits
  // — below the 70-bit floor we want for a passphrase pass.
  if (/^\d+$/.test(password)) return true;
  // All-whitespace, all-same-char, or two-char alphabet over a long
  // string — same dilution argument.
  const uniq = new Set(password).size;
  if (uniq <= 2) return true;
  // Trivial monotonic walks ("abcdefghijklmnop", "0123456789012345",
  // straight keyboard rows). Detect by checking whether every adjacent
  // pair has a charcode delta in {-1, 0, +1}: a uniform walk.
  let monotonic = true;
  for (let i = 1; i < password.length; i++) {
    const d = password.charCodeAt(i) - password.charCodeAt(i - 1);
    if (d !== 1 && d !== 0 && d !== -1) {
      monotonic = false;
      break;
    }
  }
  if (monotonic) return true;
  return false;
}
