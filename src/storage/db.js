// Dexie schema for the encrypted keystore + caches.
// All sensitive data here is ciphertext (mnemonic encrypted with PBKDF2 + AES-GCM).
import Dexie from "dexie";
export class PearlWalletDB extends Dexie {
    keystore;
    addressBook;
    txCache;
    constructor() {
        super("pearl-web-wallet");
        this.version(1).stores({
            keystore: "id",
            addressBook: "++id, address, chain",
            txCache: "++id, txHash, chain, ts",
        });
    }
}
export const db = new PearlWalletDB();
export async function loadKeystore() {
    return db.keystore.get("primary");
}
export async function saveKeystore(record) {
    await db.keystore.put(record);
}
export async function wipeKeystore() {
    await db.keystore.delete("primary");
    await db.addressBook.clear();
    await db.txCache.clear();
}
