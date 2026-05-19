import { create } from "zustand";
import { cryptoWorker } from "../crypto/worker-client";
import { db, loadKeystore, saveKeystore, wipeKeystore, } from "../storage/db";
export const useWallet = create((set, get) => ({
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
                addresses: { pearl: rec.publicData.pearlAddress, eth: rec.publicData.ethAddress },
                pearlNetwork: rec.publicData.pearlNetwork,
                ethNetwork: rec.publicData.ethNetwork,
            });
        }
        else {
            set({ status: "no-wallet" });
        }
    },
    async createWallet(strength, password) {
        const { pearlNetwork, ethNetwork } = get();
        const out = await cryptoWorker.call("createWallet", { strength, password, network: pearlNetwork });
        const rec = {
            id: "primary",
            version: 1,
            blob: out.blob,
            publicData: {
                pearlAddress: out.addresses.pearl,
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
        const out = await cryptoWorker.call("restoreWallet", { mnemonic, password, network: pearlNetwork });
        const rec = {
            id: "primary",
            version: 1,
            blob: out.blob,
            publicData: {
                pearlAddress: out.addresses.pearl,
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
        if (!blob)
            throw new Error("E_NO_WALLET");
        const out = await cryptoWorker.call("unlock", {
            blob,
            password,
            network: pearlNetwork,
        });
        set({ status: "unlocked", addresses: out.addresses, lastActivity: Date.now() });
        return { addresses: out.addresses };
    },
    async lock() {
        await cryptoWorker.call("lock", {}).catch(() => undefined);
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
        if (!blob)
            throw new Error("E_NO_WALLET");
        const out = await cryptoWorker.call("exportMnemonic", { password, blob });
        return out.mnemonic;
    },
    async changePassword(oldPw, newPw) {
        const { blob } = get();
        if (!blob)
            throw new Error("E_NO_WALLET");
        const out = await cryptoWorker.call("changePassword", { oldPassword: oldPw, newPassword: newPw, blob });
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
    async setPearlNetwork(net) {
        set({ pearlNetwork: net });
        const rec = await loadKeystore();
        if (rec) {
            rec.publicData.pearlNetwork = net;
            await db.keystore.put(rec);
        }
    },
    setEthNetwork(net) {
        set({ ethNetwork: net });
    },
}));
