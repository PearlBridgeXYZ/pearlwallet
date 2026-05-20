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
  // Long enough → entropy from length carries it; class mix not required.
  if (password.length >= PASSPHRASE_MIN_LENGTH) {
    return { ok: true };
  }
  // Shorter passwords (10–15 chars) still need two classes — the floor
  // hasn't moved, only the passphrase escape hatch is new.
  if (classes < 2) {
    return { ok: false, reason: `Use at least two of lowercase / uppercase / digit / symbol, or make it ${PASSPHRASE_MIN_LENGTH}+ characters.` };
  }
  return { ok: true };
}
