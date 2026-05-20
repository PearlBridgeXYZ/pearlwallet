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
  // Reject mono-class passwords. Two or more of: lowercase, uppercase,
  // digit, symbol. This is a floor, not a ceiling — users are still free
  // to choose a passphrase ("correct horse battery staple") which satisfies
  // both lower and length without forcing them through ridiculous chars.
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  if (classes < 2) {
    return { ok: false, reason: "Password must mix at least two of: lowercase, uppercase, digit, symbol." };
  }
  return { ok: true };
}
