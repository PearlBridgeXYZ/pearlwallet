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
  ): Promise<{ mnemonic: string; addresses: Addresses }>;
  restoreWallet(
    mnemonic: string,
    password: string,
  ): Promise<{ addresses: Addresses }>;
  unlock(password: string): Promise<{ addresses: Addresses }>;
  lock(): Promise<void>;
  wipe(): Promise<void>;
  exportMnemonic(password: string): Promise<string>;
  changePassword(oldPw: string, newPw: string): Promise<void>;
  touch(): void;
  setEthNetwork(net: EthNetwork): void;
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
  },

  async createWallet(strength, password) {
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

  async restoreWallet(mnemonic, password) {
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

  async wipe() {
    cryptoWorker.reset();
    await wipeKeystore();
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
  },

  touch() {
    set({ lastActivity: Date.now() });
  },

  setEthNetwork(net) {
    set({ ethNetwork: net });
  },
}));
