// v0.7 R1 FX2 (Grok G4, Sonnet F2/F3/F10/F13) — actions from a stale tab on
// a wallet another tab replaced.
//
// The keystore row is "primary" for every wallet, so a tab that loaded
// wallet W and missed (or has not yet handled) the other tab's broadcast
// still holds W's blob while the row is now wallet Y. Before the fix:
//   - unlock with W's password wrote W's address lists into Y's record
//     (the guard compared the on-disk record with itself);
//   - wipe with W's password deleted Y;
//   - create / restore over an existing wallet told no peer tab;
//   - a forced lock (blob-updated) kept the former addresses in the store.
//
// The in-memory table mirrors the real writers in storage/db.ts (each one
// IndexedDB transaction, compared against the record as it is when the
// write commits).

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { KeystoreBlobJSON, KeystoreRecord } from "../src/storage/db";

const mem: { rec: KeystoreRecord | undefined } = { rec: undefined };
const same = (a: KeystoreBlobJSON, b: KeystoreBlobJSON) => JSON.stringify(a) === JSON.stringify(b);
vi.mock("../src/storage/db", () => ({
  loadKeystore: async () => (mem.rec ? structuredClone(mem.rec) : undefined),
  saveKeystore: async (r: KeystoreRecord) => {
    mem.rec = structuredClone(r);
  },
  // Mirrors the real add-if-absent transaction (FY2).
  addKeystoreIfAbsent: async (r: KeystoreRecord) => {
    if (mem.rec) return false;
    mem.rec = structuredClone(r);
    return true;
  },
  updateKeystoreAddresses: async (
    lists: { pearlAddress: string; pearlAddressPool: string[]; pearlChangePool: string[] },
    expectedPrimary?: string,
    expectedBlob?: KeystoreBlobJSON,
  ) => {
    if (!mem.rec) return false;
    if (expectedPrimary !== undefined && mem.rec.publicData.pearlAddress !== expectedPrimary) return false;
    if (expectedBlob !== undefined && !same(mem.rec.blob, expectedBlob)) return false;
    mem.rec = structuredClone({ ...mem.rec, publicData: { ...mem.rec.publicData, ...lists } });
    return true;
  },
  replaceKeystoreBlob: async () => "changed",
  wipeKeystore: async (expectedBlob?: KeystoreBlobJSON) => {
    if (expectedBlob !== undefined && mem.rec && !same(mem.rec.blob, expectedBlob)) return "changed";
    mem.rec = undefined;
    return "wiped";
  },
}));

import { useWallet, __resetWalletStoreForTests, __broadcastChannelNameForTests } from "../src/state/wallet-store";
import * as workerClient from "../src/crypto/worker-client";

const blob = (c: string): KeystoreBlobJSON => ({
  version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: c,
});
const W_BLOB = blob("wallet-W");
const Y_BLOB = blob("wallet-Y");
const wPool = Array.from({ length: 20 }, (_, i) => `w-external-${i}`);
const wChange = Array.from({ length: 20 }, (_, i) => `w-internal-${i}`);
const yPool = Array.from({ length: 20 }, (_, i) => `y-external-${i}`);
const W_ADDRS = { pearl: wPool[0]!, pearlPool: wPool, pearlChange: wChange, eth: "0x1111111111111111111111111111111111111111" };

function walletY(): KeystoreRecord {
  return {
    id: "primary",
    version: 1,
    blob: { ...Y_BLOB },
    publicData: {
      pearlAddress: yPool[0]!,
      pearlAddressPool: [...yPool],
      pearlChangePool: [],
      ethAddress: "0x2222222222222222222222222222222222222222",
      pearlNetwork: "mainnet",
      ethNetwork: "mainnet",
      createdAt: 2,
    },
  };
}

let reset: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  mem.rec = walletY();
  reset = vi.spyOn(workerClient.cryptoWorker, "reset").mockImplementation(() => undefined);
  vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async (cmd: string) => {
    if (cmd === "unlock") return { addresses: W_ADDRS };
    if (cmd === "exportMnemonic") return { mnemonic: "m" };
    if (cmd === "lock") return { ok: true };
    if (cmd === "createWallet") return { mnemonic: "m", blob: { ...W_BLOB }, addresses: W_ADDRS };
    if (cmd === "restoreWallet") return { mnemonic: "m", blob: { ...W_BLOB }, addresses: W_ADDRS };
    throw new Error(`unexpected ${cmd}`);
  }) as never);
});
afterEach(() => __resetWalletStoreForTests());

describe("FX2 — a stale tab never acts on the wallet another tab stored", () => {
  it("(b) stale unlock does not rewrite the other wallet's address lists and throws E_WALLET_CHANGED", async () => {
    // This tab still holds W's blob (locked); the row is now Y.
    useWallet.setState({ status: "locked", addresses: null, blob: { ...W_BLOB } });
    await expect(useWallet.getState().unlock("W's password")).rejects.toThrow("E_WALLET_CHANGED");
    expect(mem.rec).toEqual(walletY()); // Y untouched: no W addresses in it
    expect(reset).toHaveBeenCalled();
    const s = useWallet.getState();
    expect(s.status).toBe("locked");
    expect(s.addresses).toBeNull();
    expect(s.blob).toEqual(Y_BLOB); // adopted the stored record
  });

  it("(b) unlock of the stored wallet still upgrades its address lists", async () => {
    mem.rec = { ...walletY(), blob: { ...W_BLOB }, publicData: { ...walletY().publicData, pearlAddress: wPool[0]!, pearlAddressPool: wPool.slice(0, 5), pearlChangePool: undefined } };
    useWallet.setState({ status: "locked", addresses: null, blob: { ...W_BLOB } });
    await useWallet.getState().unlock("pw");
    expect(useWallet.getState().status).toBe("unlocked");
    expect(mem.rec!.publicData.pearlAddressPool).toEqual(wPool);
    expect(mem.rec!.publicData.pearlChangePool).toEqual(wChange);
  });

  it("(c) stale wipe does not delete the other wallet; it refuses and locks onto it", async () => {
    useWallet.setState({ status: "unlocked", addresses: W_ADDRS, blob: { ...W_BLOB } });
    const peer = new BroadcastChannel(__broadcastChannelNameForTests());
    const seen: unknown[] = [];
    peer.onmessage = (ev) => seen.push(ev.data);
    await expect(useWallet.getState().wipe("W's password")).rejects.toThrow("E_WALLET_CHANGED");
    expect(mem.rec).toEqual(walletY());
    const s = useWallet.getState();
    expect(s.status).toBe("locked");
    expect(s.addresses).toBeNull();
    expect(s.blob).toEqual(Y_BLOB);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]); // no "wiped" sent for a wipe that didn't happen
    peer.close();
  });

  it("(c) a wipe of the stored wallet still wipes", async () => {
    mem.rec = { ...walletY(), blob: { ...W_BLOB } };
    useWallet.setState({ status: "unlocked", addresses: W_ADDRS, blob: { ...W_BLOB } });
    await useWallet.getState().wipe("pw");
    expect(mem.rec).toBeUndefined();
    expect(useWallet.getState().status).toBe("no-wallet");
  });

  it.each(["createWallet", "restoreWallet"] as const)("(a) %s over an existing wallet notifies peer tabs, which lock onto it", async (op) => {
    useWallet.setState({ status: "unlocked", addresses: null, blob: { ...Y_BLOB } });
    const peer = new BroadcastChannel(__broadcastChannelNameForTests());
    const seen: { type: string }[] = [];
    peer.onmessage = (ev) => seen.push(ev.data);
    if (op === "createWallet") await useWallet.getState().createWallet(128, "pw", { allowOverwrite: true });
    else await useWallet.getState().restoreWallet("m", "pw", { allowOverwrite: true });
    await vi.waitFor(() => expect(seen.map((m) => m.type)).toEqual(["blob-updated"]));
    peer.close();
  });

  it("(a) creating the first wallet (nothing replaced) sends nothing", async () => {
    mem.rec = undefined;
    useWallet.setState({ status: "no-wallet", addresses: null, blob: null });
    const peer = new BroadcastChannel(__broadcastChannelNameForTests());
    const seen: unknown[] = [];
    peer.onmessage = (ev) => seen.push(ev.data);
    await useWallet.getState().createWallet(128, "pw");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]);
    peer.close();
  });

  it("(d) the blob-updated forced lock clears the in-memory addresses like lock() does", async () => {
    __resetWalletStoreForTests();
    await useWallet.getState().init();
    useWallet.setState({ status: "unlocked", addresses: W_ADDRS, blob: { ...W_BLOB } });
    const gen = useWallet.getState().pearlAddressGeneration;
    const peer = new BroadcastChannel(__broadcastChannelNameForTests());
    peer.postMessage({ type: "blob-updated", sender: "another-tab" });
    await vi.waitFor(() => expect(useWallet.getState().status).toBe("locked"));
    expect(useWallet.getState().addresses).toBeNull();
    expect(useWallet.getState().blob).toEqual(Y_BLOB);
    expect(useWallet.getState().pearlAddressGeneration).toBeGreaterThan(gen);
    peer.close();
  });
});
