import { isAddress } from "viem";
import { isValidPearlAddress } from "../chains/pearl/address";
import { pearlParams } from "../chains/pearl/network";
export function validPearl(addr, net) {
    return isValidPearlAddress(addr.trim(), pearlParams(net));
}
export function validEth(addr) {
    try {
        return isAddress(addr.trim());
    }
    catch {
        return false;
    }
}
/** Lightweight strength heuristic. (zxcvbn deferred to keep bundle small in v1 scaffold.) */
export function passwordStrength(password) {
    const len = password.length;
    let score = 0;
    if (len >= 8)
        score++;
    if (len >= 12)
        score++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password))
        score++;
    if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password))
        score++;
    const labels = ["too short", "weak", "ok", "strong", "very strong"];
    return { score: Math.min(score, 4), label: labels[Math.min(score, 4)] };
}
