// v0.1.7: encrypt/decrypt round-trip + AAD context binding + version
// guard. These cover the keystore changes that closed H6 (silent
// AAD bind) and L2 (no version reject) from the v0.1.6 audit batch.

import { describe, it, expect } from "vitest";
import {
  encryptPlaintext,
  decryptBlob,
  computeAAD,
  AAD,
  SUPPORTED_BLOB_VERSION,
  KDF_ITERATIONS,
  type EncryptedBlob,
} from "../src/crypto/keystore";

const PASSWORD = "correct-horse-battery-staple-2026";
const ALT_PASSWORD = "different-password-9!";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8d(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

describe("encryptPlaintext / decryptBlob — round-trip", () => {
  it("encrypts and decrypts back to the same plaintext", async () => {
    const pt = utf8("hello pearl wallet");
    const blob = await encryptPlaintext(pt, PASSWORD);
    const back = await decryptBlob(blob, PASSWORD);
    expect(utf8d(back)).toBe("hello pearl wallet");
  });

  it("encrypts a large keystore payload (HD seed-like)", async () => {
    const pt = crypto.getRandomValues(new Uint8Array(64));
    const blob = await encryptPlaintext(pt, PASSWORD);
    const back = await decryptBlob(blob, PASSWORD);
    expect(back).toEqual(pt);
  });

  it("produces a blob with the expected metadata fields", async () => {
    const blob = await encryptPlaintext(utf8("x"), PASSWORD);
    expect(blob.version).toBe(SUPPORTED_BLOB_VERSION);
    expect(blob.kdf).toBe("PBKDF2-SHA256");
    expect(blob.cipher).toBe("AES-256-GCM");
    expect(blob.kdfIterations).toBe(KDF_ITERATIONS);
    expect(blob.kdfSalt.byteLength).toBe(16);
    expect(blob.iv.byteLength).toBe(12);
    expect(blob.ciphertext.byteLength).toBeGreaterThan(0);
  });

  it("rejects the wrong password with E_PASSWORD_WRONG", async () => {
    const blob = await encryptPlaintext(utf8("secret"), PASSWORD);
    await expect(decryptBlob(blob, ALT_PASSWORD)).rejects.toThrow("E_PASSWORD_WRONG");
  });

  it("produces distinct ciphertexts for the same plaintext (random salt+iv)", async () => {
    const a = await encryptPlaintext(utf8("same"), PASSWORD);
    const b = await encryptPlaintext(utf8("same"), PASSWORD);
    expect(a.kdfSalt).not.toEqual(b.kdfSalt);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });
});

describe("decryptBlob — version guard (L2)", () => {
  it("rejects an unknown version with E_UNSUPPORTED_BLOB_VERSION", async () => {
    const blob = await encryptPlaintext(utf8("v"), PASSWORD);
    // A future v2 blob would have version: 2 — caller sees a clear
    // error instead of a confusing "wrong password" loop.
    const tampered = { ...blob, version: 2 } as unknown as EncryptedBlob;
    await expect(decryptBlob(tampered, PASSWORD)).rejects.toThrow("E_UNSUPPORTED_BLOB_VERSION");
  });

  it("rejects a blob with a mismatched KDF", async () => {
    const blob = await encryptPlaintext(utf8("v"), PASSWORD);
    const tampered = { ...blob, kdf: "Argon2id" } as unknown as EncryptedBlob;
    await expect(decryptBlob(tampered, PASSWORD)).rejects.toThrow("E_UNSUPPORTED_BLOB_VERSION");
  });

  it("rejects a blob with a mismatched cipher", async () => {
    const blob = await encryptPlaintext(utf8("v"), PASSWORD);
    const tampered = { ...blob, cipher: "ChaCha20-Poly1305" } as unknown as EncryptedBlob;
    await expect(decryptBlob(tampered, PASSWORD)).rejects.toThrow("E_UNSUPPORTED_BLOB_VERSION");
  });
});

describe("computeAAD — context binding (H6)", () => {
  it("produces a stable byte string for given inputs", () => {
    const a = computeAAD(1, "PBKDF2-SHA256", 600_000, "AES-256-GCM");
    const b = computeAAD(1, "PBKDF2-SHA256", 600_000, "AES-256-GCM");
    expect(a).toEqual(b);
  });

  it("differs on any input change — version", () => {
    const a = computeAAD(1, "PBKDF2-SHA256", 600_000, "AES-256-GCM");
    const b = computeAAD(2, "PBKDF2-SHA256", 600_000, "AES-256-GCM");
    expect(a).not.toEqual(b);
  });

  it("differs on any input change — iterations", () => {
    const a = computeAAD(1, "PBKDF2-SHA256", 600_000, "AES-256-GCM");
    const b = computeAAD(1, "PBKDF2-SHA256", 300_000, "AES-256-GCM");
    expect(a).not.toEqual(b);
  });

  it("differs on any input change — kdf", () => {
    const a = computeAAD(1, "PBKDF2-SHA256", 600_000, "AES-256-GCM");
    const b = computeAAD(1, "Argon2id", 600_000, "AES-256-GCM");
    expect(a).not.toEqual(b);
  });

  it("matches the default AAD constant for current build params", () => {
    const rebuilt = computeAAD(SUPPORTED_BLOB_VERSION, "PBKDF2-SHA256", KDF_ITERATIONS, "AES-256-GCM");
    expect(rebuilt).toEqual(AAD);
  });

  it("decrypt fails (E_PASSWORD_WRONG) if AAD on the blob is tampered", async () => {
    // The GCM auth tag binds the AAD into the ciphertext. Any change to
    // blob.aad — including a "valid-looking" AAD for a different version
    // — must fail to decrypt. This is the H6 guarantee.
    const blob = await encryptPlaintext(utf8("aad-bound"), PASSWORD);
    const tampered: EncryptedBlob = {
      ...blob,
      aad: computeAAD(1, "PBKDF2-SHA256", 600_000, "ChaCha20-Poly1305"),
    };
    await expect(decryptBlob(tampered, PASSWORD)).rejects.toThrow("E_PASSWORD_WRONG");
  });
});
