import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export type MnemonicStrength = 128 | 256;

// Normalize a user-pasted mnemonic for hashing/validation.
// Collapsing internal whitespace runs is what BIP-39 reference
// wallets do — without it a phrase pasted with double-spaces (PDF
// backups, smart-quote autoformatting) trips the wordlist check
// even though every word is valid.
function normalize(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

export function generateMnemonic(strength: MnemonicStrength = 128): string {
  return bip39.generateMnemonic(wordlist, strength);
}

export function validateMnemonic(phrase: string): boolean {
  return bip39.validateMnemonic(normalize(phrase), wordlist);
}

export function mnemonicWords(phrase: string): string[] {
  return normalize(phrase).split(" ");
}

export async function mnemonicToSeed(phrase: string, passphrase = ""): Promise<Uint8Array> {
  return bip39.mnemonicToSeed(normalize(phrase), passphrase);
}

export function wordlistAll(): readonly string[] {
  return wordlist;
}
