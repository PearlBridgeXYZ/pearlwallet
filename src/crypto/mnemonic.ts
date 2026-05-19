import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export type MnemonicStrength = 128 | 256;

export function generateMnemonic(strength: MnemonicStrength = 128): string {
  return bip39.generateMnemonic(wordlist, strength);
}

export function validateMnemonic(phrase: string): boolean {
  return bip39.validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}

export function mnemonicWords(phrase: string): string[] {
  return phrase.trim().toLowerCase().split(/\s+/);
}

export async function mnemonicToSeed(phrase: string, passphrase = ""): Promise<Uint8Array> {
  return bip39.mnemonicToSeed(phrase.trim().toLowerCase(), passphrase);
}

export function wordlistAll(): readonly string[] {
  return wordlist;
}
