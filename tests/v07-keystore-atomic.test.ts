// Final review, round 3 — S1: address-list writes never rewrite the
// encrypted blob, and a password change never rewrites the address lists.
// Before the fix, extend / reset / the unlock migration read the whole
// record, changed its address lists and put it back in a second
// transaction: a password change another tab committed in between was
// silently reverted (the old blob written back, the new password refused).
//
// The in-memory table below behaves like the real writers in storage/db.ts
// (one IndexedDB transaction each): they read the record when the write
// commits. A gate holds a write open so another tab's write lands first.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { KeystoreRecord } from "../src/storage/db";

const mem: { rec: KeystoreRecord | undefined; gate: Promise<void> | null; started: (() => void) | null } = {
  rec: undefined,
  gate: null,
  started: null,
};
vi.mock("../src/storage/db", () => ({
  loadKeystore: async () => (mem.rec ? structuredClone(mem.rec) : undefined),
  saveKeystore: async (r: KeystoreRecord) => {
    mem.rec = structuredClone(r);
  },
  updateKeystoreAddresses: async (
    lists: { pearlAddress: string; pearlAddressPool: string[]; pearlChangePool: string[] },
    expectedPrimary?: string,
  ) => {
    mem.started?.();
    if (mem.gate) await mem.gate;
    if (!mem.rec) return false;
    if (expectedPrimary !== undefined && mem.rec.publicData.pearlAddress !== expectedPrimary) return false;
    mem.rec = structuredClone({ ...mem.rec, publicData: { ...mem.rec.publicData, ...lists } });
    return true;
  },
  replaceKeystoreBlob: async (blob: KeystoreRecord["blob"]) => {
    mem.started?.();
    if (mem.gate) await mem.gate;
    if (!mem.rec) return false;
    mem.rec = structuredClone({ ...mem.rec, blob });
    return true;
  },
  wipeKeystore: async () => {
    mem.rec = undefined;
  },
}));

import { useWallet } from "../src/state/wallet-store";
import * as workerClient from "../src/crypto/worker-client";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const blob = (c: string) =>
  ({ version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: c }) as const;
const OLD_BLOB = blob("encrypted-with-old-password");
const NEW_BLOB = blob("encrypted-with-new-password");
const ETH = "0x1111111111111111111111111111111111111111";
const ext = Array.from({ length: 20 }, (_, i) => `external-${i}`);
const int = Array.from({ length: 20 }, (_, i) => `internal-${i}`);

function seed(pool = ext, change = int) {
  mem.rec = {
    id: "primary",
    version: 1,
    blob: { ...OLD_BLOB },
    publicData: {
      pearlAddress: ext[0]!,
      pearlAddressPool: [...pool],
      pearlChangePool: [...change],
      ethAddress: ETH,
      pearlNetwork: "mainnet",
      ethNetwork: "mainnet",
      createdAt: 1,
    },
  };
  useWallet.setState({
    status: "unlocked",
    blob: { ...OLD_BLOB },
    addresses: { pearl: ext[0]!, pearlPool: [...pool], pearlChange: [...change], eth: ETH },
  });
}

/** Holds the next keystore write open; `otherTab` runs while it waits. */
async function racing<T>(op: () => Promise<T>, otherTab: () => void): Promise<T> {
  const gate = deferred();
  const started = deferred();
  mem.gate = gate.promise;
  mem.started = started.resolve;
  const p = op();
  await started.promise;
  otherTab();
  gate.resolve();
  try {
    return await p;
  } finally {
    mem.gate = null;
    mem.started = null;
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  mem.gate = null;
  mem.started = null;
});

describe("S1 — address-list writes keep another tab's password change", () => {
  it("extendPearlAddresses (discovery) never writes back the old blob", async () => {
    seed();
    const ok = await racing(
      () => useWallet.getState().extendPearlAddresses({ external: [...ext, "external-20"], internal: int }),
      () => (mem.rec = { ...mem.rec!, blob: { ...NEW_BLOB } }), // tab B's changePassword commits
    );
    expect(ok).toBe(true);
    expect(mem.rec!.blob).toEqual(NEW_BLOB);
    expect(mem.rec!.publicData.pearlAddressPool).toHaveLength(21);
  });

  it("resetPearlAddresses never writes back the old blob", async () => {
    const long = [...ext, ...Array.from({ length: 10 }, (_, i) => `external-${20 + i}`)];
    seed(long);
    const ok = await racing(
      () => useWallet.getState().resetPearlAddresses(),
      () => (mem.rec = { ...mem.rec!, blob: { ...NEW_BLOB } }),
    );
    expect(ok).toBe(true);
    expect(mem.rec!.blob).toEqual(NEW_BLOB);
    expect(mem.rec!.publicData.pearlAddressPool).toHaveLength(20);
  });

  it("the unlock migration never writes back the old blob", async () => {
    // A record from before v0.7: no change pool, so unlock upgrades it.
    seed();
    delete mem.rec!.publicData.pearlChangePool;
    useWallet.setState({ status: "locked", addresses: null });
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({
      addresses: { pearl: ext[0], pearlPool: ext, pearlChange: int, eth: ETH },
    } as never);
    await racing(
      () => useWallet.getState().unlock("old password"),
      () => (mem.rec = { ...mem.rec!, blob: { ...NEW_BLOB } }),
    );
    expect(mem.rec!.blob).toEqual(NEW_BLOB);
    expect(mem.rec!.publicData.pearlChangePool).toEqual(int);
  });

  it("changePassword replaces only the blob: address lists another tab extended meanwhile are kept", async () => {
    seed();
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ blob: { ...NEW_BLOB } } as never);
    const longer = [...ext, "external-20", "external-21"];
    await racing(
      () => useWallet.getState().changePassword("old", "new"),
      () => (mem.rec = { ...mem.rec!, publicData: { ...mem.rec!.publicData, pearlAddressPool: longer } }),
    );
    expect(mem.rec!.blob).toEqual(NEW_BLOB);
    expect(mem.rec!.publicData.pearlAddressPool).toEqual(longer);
    expect(useWallet.getState().blob).toEqual(NEW_BLOB);
  });

  it("changePassword after a wipe in another tab still reports E_WALLET_WIPED", async () => {
    seed();
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ blob: { ...NEW_BLOB } } as never);
    await expect(
      racing(
        () => useWallet.getState().changePassword("old", "new"),
        () => (mem.rec = undefined),
      ),
    ).rejects.toThrow("E_WALLET_WIPED");
    expect(mem.rec).toBeUndefined();
  });

  it("the real writers are one transaction each, and the store has no whole-record read-modify-write left", () => {
    const db = readFileSync("src/storage/db.ts", "utf8");
    expect(db).toMatch(/return db\.transaction\("rw", db\.keystore, async \(\) => \{\n\s+const rec = await db\.keystore\.get\("primary"\);/);
    expect(db).toMatch(/db\.keystore\.update\("primary", \{ blob \}\)/);
    const store = readFileSync("src/state/wallet-store.ts", "utf8");
    // saveKeystore remains only for create / restore (a whole new record).
    expect(store.match(/await saveKeystore\(/g)).toHaveLength(2);
    expect(store).not.toMatch(/db\.keystore\.put/);
    expect(store).not.toMatch(/rec\.publicData\.pearl\w+ = /);
  });
});
