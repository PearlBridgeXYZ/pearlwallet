// Dexie schema for the encrypted keystore + caches.
// All sensitive data here is ciphertext (mnemonic encrypted with PBKDF2 + AES-GCM).

import Dexie, { type Table } from "dexie";
import type { PearlNetwork } from "../chains/pearl/network";
import type { EthNetwork } from "../chains/ethereum/network";
import { sameKeystoreBlob } from "./keystore-blob";

export { sameKeystoreBlob };

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
    // v0.7: internal/change branch (m/86'/808276'/0'/1/i), ordered by
    // index. Optional + non-indexed: records saved before v0.7 lack it and
    // get it on the next unlock (no Dexie version bump, no data loss).
    // Both pools may grow past 20 as address discovery finds used
    // addresses; unlock re-derives exactly the persisted counts.
    pearlChangePool?: string[];
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
  /**
   * How this vault entered the wallet. "manual" = the create/join wizard;
   * "cosign-proposal" = auto-imported from a relay cosign request after the
   * config was recovered from the PSBT and bound to this address, and local
   * signer membership was proven. Optional/non-indexed — pre-existing
   * records (and the wizard path) simply omit it; no schema migration.
   */
  importedFrom?: "manual" | "cosign-proposal";
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

/**
 * v0.4.0 native bridging — one row per in-flight or settled crossing.
 * Holds NOTHING sensitive (txids + amounts only); the relay is the
 * canonical lifecycle source, this is the wallet's resume pointer so a
 * page reload doesn't orphan an in-progress wrap/unwrap.
 */
export interface BridgeCrossingRecord {
  /** wrap: pearl txid. unwrap: eth requestBurn tx hash. */
  id: string;
  direction: "wrap" | "unwrap";
  amountGrains: string;
  netGrains: string;
  createdAt: number;
  /** wallet-side coarse phase; relay state string mirrored in `relayState`. */
  phase: "confirming" | "relay" | "review" | "done" | "refunded" | "failed";
  relayState: string | null;
  confirmations: number;
  /** wrap: WPRL mint tx once relay reports it. unwrap: pearl payout txid. */
  settledRef: string | null;
  /** unwrap only: the approve tx hash when one was needed. */
  approveTxHash: string | null;
  updatedAt: number;
}

/** TOFU pin for a bridge deposit address (audit N3) — dedicated table so
 *  it never pollutes the user-facing address book. Keyed by lowercased
 *  eth address. */
export interface BridgeDepositPin {
  ethAddress: string;
  pearlAddress: string;
  pinnedAt: number;
}

export class PearlWalletDB extends Dexie {
  keystore!: Table<KeystoreRecord, "primary">;
  addressBook!: Table<AddressBookEntry, number>;
  txCache!: Table<TxCacheEntry, number>;
  vaults!: Table<VaultRecord, string>;
  vaultPendingTxs!: Table<VaultPendingTxRecord, string>;
  bridgeCrossings!: Table<BridgeCrossingRecord, string>;
  bridgeDepositPins!: Table<BridgeDepositPin, string>;

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
    // v3: native bridge crossings (v0.4.0). New table only — additive.
    this.version(3).stores({
      keystore: "id",
      addressBook: "++id, address, chain",
      txCache: "++id, txHash, chain, ts",
      vaults: "id, pearlAddress, createdAt",
      vaultPendingTxs: "id, vaultId, status, createdAt",
      bridgeCrossings: "id, direction, phase, createdAt",
    });
    // v4: dedicated deposit-address TOFU pin table (audit N3). New table
    // only — additive; keyed by eth address so put() is idempotent.
    this.version(4).stores({
      keystore: "id",
      addressBook: "++id, address, chain",
      txCache: "++id, txHash, chain, ts",
      vaults: "id, pearlAddress, createdAt",
      vaultPendingTxs: "id, vaultId, status, createdAt",
      bridgeCrossings: "id, direction, phase, createdAt",
      bridgeDepositPins: "ethAddress",
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

/**
 * Stores a new wallet record only if none exists: the existence check and
 * the insert share one read-write transaction, so two tabs that both saw an
 * empty keystore and then create / restore cannot both succeed — the second
 * write is refused (false) and the first wallet's record is left untouched.
 * Used by create / restore without overwrite consent; the explicit
 * overwrite path keeps using saveKeystore.
 */
export async function addKeystoreIfAbsent(record: KeystoreRecord): Promise<boolean> {
  return db.transaction("rw", db.keystore, async () => {
    const rec = await db.keystore.get("primary");
    if (rec) return false;
    await db.keystore.add(record);
    return true;
  });
}

/** `next` when it is at least as long as `stored`, or when the two
 *  diverge; `stored` when it extends `next` (same prefix, longer). */
function longerOfPrefixCompatible(stored: readonly string[] | undefined, next: readonly string[]): string[] {
  if (Array.isArray(stored) && stored.length > next.length && next.every((a, i) => stored[i] === a)) {
    return [...stored];
  }
  return [...next];
}

/**
 * Rewrites only the public Pearl address lists of the stored record. The
 * read and the write share one read-write transaction, so a password change
 * committed by another tab is never replaced by an older blob (a separate
 * get + put would write back whatever blob the get saw). With
 * `expectedPrimary`, refuses (false) when the stored record belongs to a
 * different wallet; with `expectedBlob`, refuses (false) unless the stored
 * record still holds that exact ciphertext (unlock binds its write to the
 * blob the worker decrypted). False when no record exists.
 *
 * `mode` "grow" (unlock, discovery) never shortens a stored list: when the
 * stored list already extends the written one (another tab discovered and
 * saved more addresses meanwhile) the stored list is kept. Only "replace"
 * (resetPearlAddresses, the explicit shrink) may shorten.
 */
export async function updateKeystoreAddresses(
  lists: { pearlAddress: string; pearlAddressPool: string[]; pearlChangePool: string[] },
  expectedPrimary?: string,
  expectedBlob?: KeystoreBlobJSON,
  mode: "grow" | "replace" = "grow",
): Promise<boolean> {
  return db.transaction("rw", db.keystore, async () => {
    const rec = await db.keystore.get("primary");
    if (!rec) return false;
    if (expectedPrimary !== undefined && rec.publicData.pearlAddress !== expectedPrimary) return false;
    if (expectedBlob !== undefined && !sameKeystoreBlob(rec.blob, expectedBlob)) return false;
    const grow = mode === "grow";
    await db.keystore.put({
      ...rec,
      publicData: {
        ...rec.publicData,
        pearlAddress: lists.pearlAddress,
        pearlAddressPool: grow
          ? longerOfPrefixCompatible(rec.publicData.pearlAddressPool, lists.pearlAddressPool)
          : [...lists.pearlAddressPool],
        pearlChangePool: grow
          ? longerOfPrefixCompatible(rec.publicData.pearlChangePool, lists.pearlChangePool)
          : [...lists.pearlChangePool],
      },
    });
    return true;
  });
}

export type ReplaceBlobResult = "replaced" | "wiped" | "changed";

/**
 * Replaces only the encrypted blob (a password change) as a compare-and-
 * update: the read, the check and the write share one read-write
 * transaction. The write happens only while the stored record still belongs
 * to `expected.primary` AND still holds `expected.blob`, the ciphertext the
 * password change started from. Otherwise another tab wiped the wallet
 * ("wiped"), restored or created a different one, or changed the password
 * first ("changed"), and the row is left untouched — re-encrypting the old
 * secret over it would pair one wallet's addresses with another's key.
 * The public address lists another tab may have just extended are kept.
 */
export async function replaceKeystoreBlob(
  blob: KeystoreBlobJSON,
  expected: { primary: string; blob: KeystoreBlobJSON },
): Promise<ReplaceBlobResult> {
  return db.transaction("rw", db.keystore, async () => {
    const rec = await db.keystore.get("primary");
    if (!rec) return "wiped";
    if (rec.publicData.pearlAddress !== expected.primary) return "changed";
    if (!sameKeystoreBlob(rec.blob, expected.blob)) return "changed";
    await db.keystore.put({ ...rec, blob });
    return "replaced";
  });
}

// localStorage keys this wallet persists. Kept here (next to wipeKeystore)
// rather than in ui-store so a "wipe everything from this browser"
// command stays the single source of truth — if a future feature stashes
// state under a new key, adding it here keeps wipe complete.
// Every shipped UI storage-key generation, oldest → newest. Kept explicit
// for clarity, but the wipe ALSO regex-scrubs any `pearl-wallet-ui-vN` so a
// future STORAGE_KEY bump can never silently desync this list again (audit
// C2 — the wipe previously stopped at v5 while the live key was v6, leaving
// the entire prefs blob — RPC overrides included — behind after a "wipe").
const LOCAL_STORAGE_KEYS: readonly string[] = [
  "pearl-wallet-ui-v3",
  "pearl-wallet-ui-v4",
  "pearl-wallet-ui-v5",
  "pearl-wallet-ui-v6", // current (v0.2.8 — see ui-store STORAGE_KEY)
  // Broadcast records (services/pending-spends.ts) — public chain data,
  // but it reveals which coins this wallet holds and whom it paid.
  "pearl-wallet-broadcasts-v1",
  // The same data in the key layout of earlier pre-release builds.
  "pearl-wallet-pending-spends-v1",
  "pearl-wallet-pending-releases-v1",
  "pearl-wallet-pending-intents-v1",
  "pearl-wallet-pending-attempts-v1",
  // NOT listed: WALLET_TABS_STORAGE_KEY ("pearl-wallet-tabs-v1"). It is
  // not wallet data but the list of LIVE tabs that the no-Web-Locks
  // single-tab broadcast guard (services/broadcast-lock.ts) relies on;
  // removing it on wipe would let a second open tab broadcast while
  // another is still running (and would unlist this tab too). A tab
  // unlists itself on unload; one that died listed is cleared by the
  // user's "no other tab is open" confirmation (claimOnlyTab).
];
const UI_STORAGE_KEY_RE = /^pearl-wallet-ui-v\d+$/;

export type WipeResult = "wiped" | "changed";

/**
 * Wipes the wallet from this browser. With `expectedBlob` (the ciphertext
 * whose password was just verified) the keystore delete is a compare-and-
 * delete in one read-write transaction: when the stored record holds a
 * different blob (another tab restored / created a wallet or changed the
 * password meanwhile) nothing at all is wiped and the result is "changed".
 * A row already gone (another tab's wipe) still wipes the rest.
 */
export async function wipeKeystore(expectedBlob?: KeystoreBlobJSON): Promise<WipeResult> {
  // Nothing is wiped (no localStorage scrub either) on a refused compare.
  let refused = false;
  // try/finally: a Dexie failure (quota exhaustion, corrupted IDB, locked
  // store) must NOT prevent the localStorage scrub. Otherwise a "wipe"
  // can leave the user's prior RPC override behind on the device.
  try {
    if (expectedBlob !== undefined) {
      const deleted = await db.transaction("rw", db.keystore, async () => {
        const rec = await db.keystore.get("primary");
        if (rec && !sameKeystoreBlob(rec.blob, expectedBlob)) return false;
        await db.keystore.delete("primary");
        return true;
      });
      if (!deleted) {
        refused = true;
        return "changed";
      }
    } else {
      await db.keystore.delete("primary");
    }
    await db.addressBook.clear();
    await db.txCache.clear();
    // Multisig vaults + pending txs hold no key material (the cosigner
    // pubkey set is public and the PSBT carries only signatures), but they
    // do reveal vault membership + counterparties. A user issuing "wipe"
    // expects to leave the device clean.
    await db.vaults.clear();
    await db.vaultPendingTxs.clear();
    // Bridge state reveals bridging history; the deposit-address pin would
    // otherwise be silently inherited by a wallet re-imported in the same
    // browser (audit round-2 item 1). Both must go on a clean wipe.
    await db.bridgeCrossings.clear();
    await db.bridgeDepositPins.clear();
  } finally {
    if (!refused && typeof localStorage !== "undefined") {
      // Explicit list first (covers the documented keys), then a regex sweep
      // of any pearl-wallet-ui-vN currently present — future-proof against a
      // STORAGE_KEY bump that forgets to update the list (audit C2).
      const keys = new Set<string>(LOCAL_STORAGE_KEYS);
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && UI_STORAGE_KEY_RE.test(k)) keys.add(k);
        }
      } catch {
        // length/key access can throw under partitioning; fall back to list.
      }
      for (const k of keys) {
        try {
          localStorage.removeItem(k);
        } catch {
          // localStorage can be partitioned/quota-exhausted; swallow.
        }
      }
    }
  }
  return "wiped";
}
