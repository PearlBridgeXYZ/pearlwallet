import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
export function generateMnemonic(strength = 128) {
    return bip39.generateMnemonic(wordlist, strength);
}
export function validateMnemonic(phrase) {
    return bip39.validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}
export function mnemonicWords(phrase) {
    return phrase.trim().toLowerCase().split(/\s+/);
}
export async function mnemonicToSeed(phrase, passphrase = "") {
    return bip39.mnemonicToSeed(phrase.trim().toLowerCase(), passphrase);
}
export function wordlistAll() {
    return wordlist;
}
