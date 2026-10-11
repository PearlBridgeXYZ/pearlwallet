// Keystore-blob comparison, kept free of Dexie so the wallet store can use
// it next to a mocked storage layer (tests mock ../storage/db wholesale).

import type { KeystoreBlobJSON } from "./db";

/** True when two keystore blobs are the same ciphertext under the same
 *  key-derivation parameters (every field compared). */
export function sameKeystoreBlob(a: KeystoreBlobJSON, b: KeystoreBlobJSON): boolean {
  return (
    a.version === b.version &&
    a.kdf === b.kdf &&
    a.kdfIterations === b.kdfIterations &&
    a.kdfSalt === b.kdfSalt &&
    a.cipher === b.cipher &&
    a.iv === b.iv &&
    a.aad === b.aad &&
    a.ciphertext === b.ciphertext
  );
}
