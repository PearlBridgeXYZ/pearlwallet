import { create } from "zustand";
import type { PearlNetwork } from "../chains/pearl/network";
import type { EthNetwork } from "../chains/ethereum/network";
import { cryptoWorker } from "../crypto/worker-client";
import {
  db,
  loadKeystore,
  saveKeystore,
  wipeKeystore,
  type KeystoreRecord,
  type KeystoreBlobJSON,
} from "../storage/db";

// Idle window before the wallet auto-locks. Exported so the TopBar
// countdown and the App-level interval check stay in lockstep — if one
// side hardcodes a different value the user sees "1:23 until lock"
// while the wallet is already locked, which is exactly the v0.1.0
// Low-#2 audit finding this constant addresses.
export const AUTO_LOCK_MS = 5 * 60 * 1000;

export type WalletStatus = "no-wallet" | "locked" | "unlocked";

interface Addresses {
  // Primary Pearl receive address (index 0).
  pearl: string;
  // Full external receive pool — RECEIVE_GAP_LIMIT entries, index 0..N-1.
  // Funds discovered at any of these is "ours" because the seed derives them
  // all. UTXO scans aggregate balances across this pool.
  pearlPool: string[];
  eth: string;
}

interface WalletState {
  status: WalletStatus;
  addresses: Addresses | null;
  pearlNetwork: PearlNetwork;
  ethNetwork: EthNetwork;
  blob: KeystoreBlobJSON | null;
  lastActivity: number;

  init(): Promise<void>;
  createWallet(
    strength: 128 | 256,
    password: string,
    opts?: { allowOverwrite?: boolean },
  ): Promise<{ mnemonic: string; addresses: Addresses }>;
  restoreWallet(
    mnemonic: string,
    password: string,
    opts?: { allowOverwrite?: boolean },
  ): Promise<{ addresses: Addresses }>;
  unlock(password: string): Promise<{ addresses: Addresses }>;
  lock(): Promise<void>;
  // Wipe requires the password so an attacker with brief physical access
  // can't nuke the on-device keystore (and the user's only copy of the
  // mnemonic-encrypted-at-rest) by clicking through Settings. Caller MUST
  // pass the current password; we verify by attempting to decrypt the blob.
  wipe(password: string): Promise<void>;
  exportMnemonic(password: string): Promise<string>;
  changePassword(oldPw: string, newPw: string): Promise<void>;
  touch(): void;
  setEthNetwork(net: EthNetwork): void;
}

// Cross-tab notification when the keystore blob is rewritten (currently:
// changePassword). Other tabs reload the on-disk record so a subsequent
// changePassword-from-Tab-B doesn't race-overwrite Tab-A's new password.
const KEYSTORE_BROADCAST_CHANNEL = "pearl-wallet-keystore";
type KeystoreEvent = { type: "blob-updated" } | { type: "wiped" };
function broadcastKeystoreEvent(ev: KeystoreEvent): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(KEYSTORE_BROADCAST_CHANNEL);
    ch.postMessage(ev);
    ch.close();
  } catch {
    // BroadcastChannel unsupported (older Safari) — silent fallback.
  }
}

export const useWallet = create<WalletState>((set, get) => ({
  status: "no-wallet",
  addresses: null,
  pearlNetwork: "mainnet",
  ethNetwork: "mainnet",
  blob: null,
  lastActivity: Date.now(),

  async init() {
    const rec = await loadKeystore();
    if (rec) {
      set({
        status: "locked",
        blob: rec.blob,
        addresses: {
          pearl: rec.publicData.pearlAddress,
          pearlPool: rec.publicData.pearlAddressPool ?? [rec.publicData.pearlAddress],
          eth: rec.publicData.ethAddress,
        },
        pearlNetwork: "mainnet",
        ethNetwork: rec.publicData.ethNetwork,
      });
    } else {
      set({ status: "no-wallet" });
    }
    // Multi-tab keystore sync. Wired at init() instead of module-scope so
    // a test environment without BroadcastChannel doesn't blow up at
    // import time.
    if (typeof BroadcastChannel !== "undefined") {
      try {
        const ch = new BroadcastChannel(KEYSTORE_BROADCAST_CHANNEL);
        ch.onmessage = async (ev: MessageEvent<KeystoreEvent>) => {
          if (ev.data.type === "blob-updated") {
            const fresh = await loadKeystore();
            if (fresh) {
              // Lock this tab on a foreign password change — the in-memory
              // session was derived from the OLD password; using it against
              // the new blob would fail anyway, and the cleanest UX is to
              // require an unlock with the new password.
              cryptoWorker.reset();
              set({ status: "locked", blob: fresh.blob });
            }
          } else if (ev.data.type === "wiped") {
            cryptoWorker.reset();
            set({ status: "no-wallet", addresses: null, blob: null });
          }
        };
      } catch {
        // BroadcastChannel unsupported — single-tab mode is still safe.
      }
    }
  },

  async createWallet(strength, password, opts) {
    // Existing-wallet guard — prevents the v0.1.5 fund-loss footgun where
    // clicking "Create a new wallet" from Splash silently overwrites the
    // existing encrypted keystore. Caller must explicitly opt-in by passing
    // allowOverwrite (the UI requires "wipe my wallet" confirmation).
    const existing = await loadKeystore();
    if (existing && !opts?.allowOverwrite) {
      throw new Error("E_WALLET_EXISTS");
    }
    const { pearlNetwork, ethNetwork } = get();
    const out = await cryptoWorker.call<"createWallet", {
      mnemonic: string;
      blob: KeystoreBlobJSON;
      addresses: Addresses;
    }>("createWallet", { strength, password, network: pearlNetwork });

    const rec: KeystoreRecord = {
      id: "primary",
      version: 1,
      blob: out.blob,
      publicData: {
        pearlAddress: out.addresses.pearl,
        pearlAddressPool: out.addresses.pearlPool,
        ethAddress: out.addresses.eth,
        pearlNetwork,
        ethNetwork,
        createdAt: Date.now(),
      },
    };
    await saveKeystore(rec);
    set({
      status: "unlocked",
      addresses: out.addresses,
      blob: out.blob,
      lastActivity: Date.now(),
    });
    return { mnemonic: out.mnemonic, addresses: out.addresses };
  },

  async restoreWallet(mnemonic, password, opts) {
    const existing = await loadKeystore();
    if (existing && !opts?.allowOverwrite) {
      throw new Error("E_WALLET_EXISTS");
    }
    const { pearlNetwork, ethNetwork } = get();
    const out = await cryptoWorker.call<"restoreWallet", {
      mnemonic: string;
      blob: KeystoreBlobJSON;
      addresses: Addresses;
    }>("restoreWallet", { mnemonic, password, network: pearlNetwork });

    const rec: KeystoreRecord = {
      id: "primary",
      version: 1,
      blob: out.blob,
      publicData: {
        pearlAddress: out.addresses.pearl,
        pearlAddressPool: out.addresses.pearlPool,
        ethAddress: out.addresses.eth,
        pearlNetwork,
        ethNetwork,
        createdAt: Date.now(),
      },
    };
    await saveKeystore(rec);
    set({
      status: "unlocked",
      addresses: out.addresses,
      blob: out.blob,
      lastActivity: Date.now(),
    });
    return { addresses: out.addresses };
  },

  async unlock(password) {
    const { blob, pearlNetwork } = get();
    if (!blob) throw new Error("E_NO_WALLET");
    const out = await cryptoWorker.call<"unlock", { addresses: Addresses }>("unlock", {
      blob,
      password,
      network: pearlNetwork,
    });
    // Persist the freshly-derived pool back to the keystore so a record
    // saved by an older build (without pearlAddressPool) gets upgraded
    // without requiring a wipe-and-restore.
    const rec = await loadKeystore();
    if (rec) {
      const needsUpdate =
        !Array.isArray(rec.publicData.pearlAddressPool) ||
        rec.publicData.pearlAddressPool.length !== out.addresses.pearlPool.length ||
        rec.publicData.pearlAddressPool.some((a, i) => a !== out.addresses.pearlPool[i]);
      if (needsUpdate) {
        rec.publicData.pearlAddressPool = out.addresses.pearlPool;
        rec.publicData.pearlAddress = out.addresses.pearl;
        await saveKeystore(rec);
      }
    }
    set({ status: "unlocked", addresses: out.addresses, lastActivity: Date.now() });
    return { addresses: out.addresses };
  },

  async lock() {
    await cryptoWorker.call<"lock">("lock", {}).catch(() => undefined);
    cryptoWorker.reset();
    set({ status: "locked" });
  },

  async wipe(password) {
    const { blob } = get();
    if (blob) {
      // Password-gate the wipe by attempting to decrypt the blob. A wrong
      // password throws E_PASSWORD_WRONG and we keep the keystore intact.
      // If we have no blob (status=no-wallet), nothing to gate.
      await cryptoWorker.call<"exportMnemonic", { mnemonic: string }>(
        "exportMnemonic",
        { password, blob },
      );
    }
    cryptoWorker.reset();
    await wipeKeystore();
    broadcastKeystoreEvent({ type: "wiped" });
    set({ status: "no-wallet", addresses: null, blob: null });
  },

  async exportMnemonic(password) {
    const { blob } = get();
    if (!blob) throw new Error("E_NO_WALLET");
    const out = await cryptoWorker.call<"exportMnemonic", { mnemonic: string }>(
      "exportMnemonic",
      { password, blob },
    );
    return out.mnemonic;
  },

  async changePassword(oldPw, newPw) {
    const { blob } = get();
    if (!blob) throw new Error("E_NO_WALLET");
    const out = await cryptoWorker.call<"changePassword", { blob: KeystoreBlobJSON }>(
      "changePassword",
      { oldPassword: oldPw, newPassword: newPw, blob },
    );
    const rec = await loadKeystore();
    if (rec) {
      rec.blob = out.blob;
      await db.keystore.put(rec);
    }
    set({ blob: out.blob });
    // Multi-tab safety: another open tab loaded the old blob into its
    // closure at init() time. Tell it the on-disk record changed so it
    // refreshes — otherwise that tab's next operation reads stale
    // ciphertext and either fails with E_PASSWORD_WRONG (confusing) or
    // races a saveKeystore that resurrects the old password.
    broadcastKeystoreEvent({ type: "blob-updated" });
  },

  touch() {
    set({ lastActivity: Date.now() });
  },

  setEthNetwork(net) {
    set({ ethNetwork: net });
  },
}));
