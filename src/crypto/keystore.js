// AES-256-GCM keystore with PBKDF2-HMAC-SHA256 KDF (600k iterations).
// Conforms to docs/06-CRYPTO.md storage record schema.
export const KDF_ITERATIONS = 600_000;
export const KDF_SALT_BYTES = 16;
export const AES_IV_BYTES = 12;
export const AAD = new TextEncoder().encode("pearl-web-wallet-v1");
function requireCrypto() {
    if (typeof crypto === "undefined" || !crypto.subtle || !crypto.getRandomValues) {
        throw new Error("WebCrypto unavailable — refusing to operate");
    }
    return crypto.subtle;
}
async function deriveKey(password, salt, iterations) {
    const subtle = requireCrypto();
    const baseKey = await subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    return subtle.deriveKey({
        name: "PBKDF2",
        salt: salt,
        iterations,
        hash: "SHA-256",
    }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptPlaintext(plaintext, password) {
    const subtle = requireCrypto();
    const kdfSalt = crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
    const key = await deriveKey(password, kdfSalt, KDF_ITERATIONS);
    const ciphertextBuf = await subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: AAD }, key, plaintext);
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
export async function decryptBlob(blob, password) {
    const subtle = requireCrypto();
    const key = await deriveKey(password, blob.kdfSalt, blob.kdfIterations);
    try {
        const plaintextBuf = await subtle.decrypt({ name: "AES-GCM", iv: blob.iv, additionalData: blob.aad }, key, blob.ciphertext);
        return new Uint8Array(plaintextBuf);
    }
    catch {
        // Generic error — never leak which step failed.
        throw new Error("E_PASSWORD_WRONG");
    }
}
