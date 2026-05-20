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

// v0.2.0 multisig storage. A vault is the set of (sortedPubkeys, threshold,
// total) plus the participant's own slot (which pubkey is mine, at which
// derivation path). We persist the sorted pubkey set rather than just the
// address so an audit / re-derivation never depends on the cosigner descriptors
// being re-imported. The Pearl address is derivable from the pubkey set + the
// threshold but cached here so a vault list renders without recomputing.
export interface VaultRecord {
  id: string; // uuid
  version: 1;
  label: string;
  threshold: number;
  total: number;
  // 32-byte x-only pubkeys as lowercase hex, **already BIP-67-sorted**.
  // Storing the sorted form keeps the on-disk shape canonical — a future
  // cosigner-reorder import won't produce a "different" vault.
  sortedPubkeysHex: string[];
  // The participant's own pubkey (must appear in sortedPubkeysHex) and the
  // BIP-32 path they derived it from. Without this, signing later would have
  // to brute-force all multisig vault-account / index pairs to find the right
  // child key.
  myPubkeyHex: string;
  myOriginPath: string;
  /** The multisig "account" index inside `m/86'/808276'/100'/{account}'/{i}`. */
  myVaultAccount: number;
  /** The "index" inside the same path. */
  myKeyIndex: number;
  pearlAddress: string;
  network: "mainnet";
  createdAt: number;
}

// A drafting / partially-signed / ready / broadcast tx for a multisig vault.
// Carries the PSBT (base64) and the set of pubkeys that have signed so far so
// the UI can show "2 of 3 signed" without re-parsing the PSBT to count
// witnesses. txid is only populated after a successful broadcast.
export interface VaultPendingTxRecord {
  id: string; // uuid
  vaultId: string;
  psbtBase64: string;
  // Lowercase hex x-only pubkeys that have a sig in the PSBT for input 0.
  // (All inputs share the same signer set under our compose path, so input 0
  // is representative.) Used for UI progress + threshold-met checks.
  signersHex: string[];
  createdAt: number;
  updatedAt: number;
  status: "drafting" | "ready" | "broadcast" | "failed";
  txid?: string;
  // Pretty preview the wizard captured at compose time so detail page can
  // render destination/amount/fee without re-parsing the PSBT.
  preview: {
    destination: string;
    amountGrains: string; // bigint as string
    feeGrains: string;
    changeGrains: string;
    inputCount: number;
  };
}

export class PearlWalletDB extends Dexie {
  keystore!: Table<KeystoreRecord, "primary">;
  addressBook!: Table<AddressBookEntry, number>;
  txCache!: Table<TxCacheEntry, number>;
  vaults!: Table<VaultRecord, string>;
  vaultPendingTxs!: Table<VaultPendingTxRecord, string>;

  constructor() {
    super("pearl-web-wallet");
    this.version(1).stores({
      keystore: "id",
      addressBook: "++id, address, chain",
      txCache: "++id, txHash, chain, ts",
    });
    // v2: add multisig tables. No data migration — both tables are new
    // additions; pre-v2 users simply gain empty stores.
    this.version(2).stores({
      keystore: "id",
      addressBook: "++id, address, chain",
      txCache: "++id, txHash, chain, ts",
      vaults: "id, pearlAddress, createdAt",
      vaultPendingTxs: "id, vaultId, status, createdAt",
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

// localStorage keys this wallet persists. Kept here (next to wipeKeystore)
// rather than in ui-store so a "wipe everything from this browser"
// command stays the single source of truth — if a future feature stashes
// state under a new key, adding it here keeps wipe complete.
const LOCAL_STORAGE_KEYS: readonly string[] = [
  // Every shipped storage-key generation, oldest → newest. We keep prior
  // keys in the wipe so a user whose browser still holds a v3/v4 blob from
  // an older release also gets it scrubbed. The current shape lives under
  // `pearl-wallet-ui-v5` (v0.2.0 — see ui-store STORAGE_KEY).
  "pearl-wallet-ui-v3",
  "pearl-wallet-ui-v4",
  "pearl-wallet-ui-v5",
];

export async function wipeKeystore(): Promise<void> {
  // try/finally: a Dexie failure (quota exhaustion, corrupted IDB, locked
  // store) must NOT prevent the localStorage scrub. Otherwise a "wipe"
  // can leave the user's prior RPC override behind on the device.
  try {
    await db.keystore.delete("primary");
    await db.addressBook.clear();
    await db.txCache.clear();
    // Multisig vaults + pending txs hold no key material (the cosigner
    // pubkey set is public and the PSBT carries only signatures), but they
    // do reveal vault membership + counterparties. A user issuing "wipe"
    // expects to leave the device clean.
    await db.vaults.clear();
    await db.vaultPendingTxs.clear();
  } finally {
    if (typeof localStorage !== "undefined") {
      for (const k of LOCAL_STORAGE_KEYS) {
        try {
          localStorage.removeItem(k);
        } catch {
          // localStorage can be partitioned/quota-exhausted; swallow.
        }
      }
    }
  }
}
