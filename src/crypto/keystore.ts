// AES-256-GCM keystore with PBKDF2-HMAC-SHA256 KDF (600k iterations).
// Conforms to docs/06-CRYPTO.md storage record schema.

export const KDF_ITERATIONS = 600_000;
export const KDF_SALT_BYTES = 16;
export const AES_IV_BYTES = 12;
export const SUPPORTED_BLOB_VERSION = 1 as const;

// AAD binds the ciphertext to the version, KDF identity, iteration
// count, and cipher. A keystore exported from this build will not
// decrypt against a future v2 blob that swaps cipher or iterations —
// the GCM auth check fails before we even attempt password-derived
// decryption. Pre-v0.1.7 AAD was a static "pearl-web-wallet-v1"
// label that carried zero context binding; v0.1.7 stored AAD as a
// JSON.stringify({...}) which relied on V8 insertion-order key
// ordering; v0.1.8 (this) switches to a fixed pipe-delimited string
// so the bytes are stable across runtimes (Bun/Deno/older Safari).
// The blob itself stores its own AAD bytes, so already-encrypted
// records continue to decrypt — we only need the byte sequence to
// be deterministic for new encrypts.
export function computeAAD(
  version: number,
  kdf: string,
  kdfIterations: number,
  cipher: string,
): Uint8Array {
  return new TextEncoder().encode(
    `pearl-wallet/aad|v=${version}|kdf=${kdf}|iter=${kdfIterations}|cipher=${cipher}`,
  );
}

/** Default AAD for fresh-encrypt of the current supported blob version. */
export const AAD = computeAAD(SUPPORTED_BLOB_VERSION, "PBKDF2-SHA256", KDF_ITERATIONS, "AES-256-GCM");

export interface EncryptedBlob {
  version: 1;
  kdf: "PBKDF2-SHA256";
  kdfIterations: number;
  kdfSalt: Uint8Array;
  cipher: "AES-256-GCM";
  iv: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}

function requireCrypto(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error("WebCrypto unavailable — refusing to operate");
  }
  return crypto.subtle;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = requireCrypto();
  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPlaintext(plaintext: Uint8Array, password: string): Promise<EncryptedBlob> {
  const subtle = requireCrypto();
  const kdfSalt = crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const key = await deriveKey(password, kdfSalt, KDF_ITERATIONS);
  const ciphertextBuf = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    kdfIterations: KDF_ITERATIONS,
    kdfSalt,
    cipher: "AES-256-GCM",
    iv,
    aad: AAD,
    ciphertext: new Uint8Array(ciphertextBuf),
  };
}

export async function decryptBlob(blob: EncryptedBlob, password: string): Promise<Uint8Array> {
  // Reject future blob formats explicitly. Without this guard, a v2 blob
  // with mismatched KDF params would surface as a generic "wrong password"
  // and the user could spend hours retrying — when the real issue is they
  // need a newer client. This is cheap and unambiguous.
  if (blob.version !== SUPPORTED_BLOB_VERSION) {
    throw new Error("E_UNSUPPORTED_BLOB_VERSION");
  }
  if (blob.kdf !== "PBKDF2-SHA256" || blob.cipher !== "AES-256-GCM") {
    throw new Error("E_UNSUPPORTED_BLOB_VERSION");
  }
  const subtle = requireCrypto();
  const key = await deriveKey(password, blob.kdfSalt, blob.kdfIterations);
  try {
    const plaintextBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: blob.iv as BufferSource, additionalData: blob.aad as BufferSource },
      key,
      blob.ciphertext as BufferSource,
    );
    return new Uint8Array(plaintextBuf);
  } catch {
    // Generic error — never leak which step failed.
    throw new Error("E_PASSWORD_WRONG");
  }
}
