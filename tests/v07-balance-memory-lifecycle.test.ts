// v0.7 — remembered per-address balances, scan progress and scan baselines
// (state/balance-memory.ts) must not outlive the session: the wallet store
// clears them on lock, wipe and wallet switch (create / restore over an
// existing wallet, cross-tab password change or wipe).

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { KeystoreRecord } from "../src/storage/db";

const mem: { rec: KeystoreRecord | undefined } = { rec: undefined };
vi.mock("../src/storage/db", () => ({
  db: { keystore: { put: async (r: KeystoreRecord) => { mem.rec = structuredClone(r); } } },
  loadKeystore: async () => (mem.rec ? structuredClone(mem.rec) : undefined),
  saveKeystore: async (r: KeystoreRecord) => {
    mem.rec = structuredClone(r);
  },
  // Mirrors the real compare-and-replace transaction (FZ3).
  replaceKeystoreIfUnchanged: async (r: KeystoreRecord, observed: KeystoreRecord["blob"] | null) => {
    const same = !!mem.rec && observed !== null && JSON.stringify(mem.rec.blob) === JSON.stringify(observed);
    if (observed === null ? mem.rec !== undefined : !same) return false;
    mem.rec = structuredClone(r);
    return true;
  },
  addKeystoreIfAbsent: async (r: KeystoreRecord) => {
    if (mem.rec) return false;
    mem.rec = structuredClone(r);
    return true;
  },
  updateKeystoreAddresses: async (
    lists: { pearlAddress: string; pearlAddressPool: string[]; pearlChangePool: string[] },
    expectedPrimary?: string,
  ) => {
    if (!mem.rec) return false;
    if (expectedPrimary !== undefined && mem.rec.publicData.pearlAddress !== expectedPrimary) return false;
    mem.rec = structuredClone({ ...mem.rec, publicData: { ...mem.rec.publicData, ...lists } });
    return true;
  },
  replaceKeystoreBlob: async (
    blob: KeystoreRecord["blob"],
    expected: { primary: string; blob: KeystoreRecord["blob"] },
  ) => {
    if (!mem.rec) return "wiped";
    if (mem.rec.publicData.pearlAddress !== expected.primary) return "changed";
    if (JSON.stringify(mem.rec.blob) !== JSON.stringify(expected.blob)) return "changed";
    mem.rec = structuredClone({ ...mem.rec, blob });
    return "replaced";
  },
  wipeKeystore: async () => {
    mem.rec = undefined;
  },
}));

import {
  useWallet,
  __resetWalletStoreForTests,
  __broadcastChannelNameForTests,
} from "../src/state/wallet-store";
import * as workerClient from "../src/crypto/worker-client";
import {
  __balanceMemorySizesForTests as sizes,
  memoryEpoch,
  setProgress,
  setScanBaseline,
} from "../src/state/balance-memory";
import { rememberAddressResult, clearBalanceMemory } from "../src/ui/hooks/useWalletBalances";

const BLOB = {
  version: 1 as const,
  kdf: "PBKDF2-SHA256" as const,
  kdfIterations: 1,
  kdfSalt: "00",
  cipher: "AES-256-GCM" as const,
  iv: "00",
  aad: "00",
  ciphertext: "00",
};
const ADDRS = { pearl: "prl1pA", pearlPool: ["prl1pA", "prl1pB"], pearlChange: ["prl1pC"], eth: "0x01" };

function record(): KeystoreRecord {
  return {
    id: "primary",
    version: 1,
    blob: BLOB,
    publicData: {
      pearlAddress: ADDRS.pearl,
      pearlAddressPool: ADDRS.pearlPool,
      pearlChangePool: ADDRS.pearlChange,
      ethAddress: ADDRS.eth,
      pearlNetwork: "mainnet",
      ethNetwork: "mainnet",
      createdAt: 0,
    },
  } as KeystoreRecord;
}

function seedMemory() {
  rememberAddressResult(
    "prl1pA",
    {
      done: 1,
      total: 3,
      index: 0,
      ref: { address: "prl1pA", branch: 0, index: 0 },
      result: { status: "ok", grains: 5n, degraded: false, utxos: [], used: true },
    },
    1,
  );
  setProgress("prl1pA", { done: 1, total: 3, running: true });
  setScanBaseline("prl1pA", { fullAt: 1, lastUsed: [0, -1], knownUnused: new Set(["prl1pB"]) });
  expect(sizes()).toEqual({ lastGood: 1, progress: 1, baselines: 1 });
}

const EMPTY = { lastGood: 0, progress: 0, baselines: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
  clearBalanceMemory();
  mem.rec = record();
  vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async (cmd: string) => {
    if (cmd === "lock") return { ok: true };
    if (cmd === "exportMnemonic") return { mnemonic: "m" };
    if (cmd === "createWallet") return { mnemonic: "m", blob: BLOB, addresses: ADDRS };
    if (cmd === "restoreWallet") return { mnemonic: "m", blob: BLOB, addresses: ADDRS };
    throw new Error(`unexpected ${cmd}`);
  }) as never);
  vi.spyOn(workerClient.cryptoWorker, "reset").mockImplementation(() => undefined);
  useWallet.setState({ status: "unlocked", addresses: ADDRS, blob: BLOB });
});

describe("balance memory is cleared with the session", () => {
  it("lock() clears it", async () => {
    seedMemory();
    await useWallet.getState().lock();
    expect(useWallet.getState().status).toBe("locked");
    expect(sizes()).toEqual(EMPTY);
  });

  it("wipe() clears it", async () => {
    seedMemory();
    await useWallet.getState().wipe("pw");
    expect(useWallet.getState().status).toBe("no-wallet");
    expect(sizes()).toEqual(EMPTY);
  });

  it("a wrong-password wipe keeps the wallet and the memory", async () => {
    vi.mocked(workerClient.cryptoWorker.call).mockRejectedValueOnce(new Error("E_PASSWORD_WRONG"));
    seedMemory();
    await expect(useWallet.getState().wipe("bad")).rejects.toThrow("E_PASSWORD_WRONG");
    expect(useWallet.getState().status).toBe("unlocked");
    expect(sizes()).toEqual({ lastGood: 1, progress: 1, baselines: 1 });
  });

  it("restoring over an existing wallet (wallet switch) clears it", async () => {
    seedMemory();
    await useWallet.getState().restoreWallet("m", "pw", { allowOverwrite: true, observedBlob: mem.rec?.blob ?? null });
    expect(sizes()).toEqual(EMPTY);
  });

  it("creating a wallet over an existing one (wallet switch) clears it", async () => {
    seedMemory();
    await useWallet.getState().createWallet(128, "pw", { allowOverwrite: true, observedBlob: mem.rec?.blob ?? null });
    expect(sizes()).toEqual(EMPTY);
  });

  it("a wipe in another tab clears it", async () => {
    __resetWalletStoreForTests();
    await useWallet.getState().init();
    useWallet.setState({ status: "unlocked", addresses: ADDRS, blob: BLOB });
    seedMemory();
    mem.rec = undefined; // the other tab's wipe removed the record
    const peer = new BroadcastChannel(__broadcastChannelNameForTests());
    peer.postMessage({ type: "wiped", sender: "another-tab" });
    await vi.waitFor(() => expect(useWallet.getState().status).toBe("no-wallet"));
    expect(sizes()).toEqual(EMPTY);
    peer.close();
    __resetWalletStoreForTests();
  });

  it("a late wipe event after the other tab already restored a wallet locks onto the stored one", async () => {
    __resetWalletStoreForTests();
    await useWallet.getState().init();
    useWallet.setState({ status: "unlocked", addresses: ADDRS, blob: BLOB });
    seedMemory();
    const restored = { ...BLOB, ciphertext: "a-different-wallet-restored-in-the-other-tab" };
    mem.rec = { ...record(), blob: restored };
    const peer = new BroadcastChannel(__broadcastChannelNameForTests());
    peer.postMessage({ type: "wiped", sender: "another-tab" });
    await vi.waitFor(() => expect(useWallet.getState().status).toBe("locked"));
    expect(useWallet.getState().addresses).toBeNull();
    expect(useWallet.getState().blob).toEqual(restored);
    expect(sizes()).toEqual(EMPTY);
    peer.close();
    __resetWalletStoreForTests();
  });

  it("a password change in another tab (forced lock) clears it", async () => {
    __resetWalletStoreForTests();
    await useWallet.getState().init();
    useWallet.setState({ status: "unlocked", addresses: ADDRS, blob: BLOB });
    seedMemory();
    const peer = new BroadcastChannel(__broadcastChannelNameForTests());
    peer.postMessage({ type: "blob-updated", sender: "another-tab" });
    await vi.waitFor(() => expect(useWallet.getState().status).toBe("locked"));
    expect(sizes()).toEqual(EMPTY);
    peer.close();
    __resetWalletStoreForTests();
  });

  it("clearing bumps the epoch so an in-flight scan stops writing", async () => {
    const before = memoryEpoch();
    await useWallet.getState().lock();
    expect(memoryEpoch()).toBeGreaterThan(before);
  });
});
