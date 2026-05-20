// Dexie schema for the encrypted keystore + caches.
// All sensitive data here is ciphertext (mnemonic encrypted with PBKDF2 + AES-GCM).

import Dexie, { type Table } from "dexie";
import type { PearlNetwork } from "../chains/pearl/network";
import type { EthNetwork } from "../chains/ethereum/network";

export interface KeystoreBlobJSON {
  version: 1;
  kdf: "PBKDF2-SHA256";
  kdfIterations: number;
  kdfSalt: string;
  cipher: "AES-256-GCM";
  iv: string;
  aad: string;
  ciphertext: string;
}

export interface KeystoreRecord {
  id: "primary"; // single keystore per browser in v1
  version: 1;
  blob: KeystoreBlobJSON;
  publicData: {
    // Primary (index 0) — kept as a flat field so v0.1.2 records still load.
    pearlAddress: string;
    // External receive pool. Optional for forward-compat with v0.1.2 records
    // saved before multi-address support; missing → re-derived on next unlock.
    pearlAddressPool?: string[];
    ethAddress: string;
    pearlNetwork: PearlNetwork;
    ethNetwork: EthNetwork;
    createdAt: number;
  };
}

export interface AddressBookEntry {
  id?: number;
  label: string;
  address: string;
  chain: "pearl" | "eth";
  createdAt: number;
}

export interface TxCacheEntry {
  id?: number;
  txHash: string;
  chain: "pearl" | "eth";
  direction: "send" | "receive" | "bridge";
  amount: string; // string-encoded to avoid bigint serialization issues
  counterparty: string;
  ts: number;
  status: "pending" | "confirmed" | "failed";
  meta?: Record<string, unknown>;
}

export class PearlWalletDB extends Dexie {
  keystore!: Table<KeystoreRecord, "primary">;
  addressBook!: Table<AddressBookEntry, number>;
  txCache!: Table<TxCacheEntry, number>;

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

export async function loadKeystore(): Promise<KeystoreRecord | undefined> {
  return db.keystore.get("primary");
}

export async function saveKeystore(record: KeystoreRecord): Promise<void> {
  await db.keystore.put(record);
}

export async function wipeKeystore(): Promise<void> {
  await db.keystore.delete("primary");
  await db.addressBook.clear();
  await db.txCache.clear();
}
