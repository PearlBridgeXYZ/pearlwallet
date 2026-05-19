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
