// audit C2 — wipeKeystore must scrub the CURRENT ui storage key (and any
// pearl-wallet-ui-vN), not stop at a stale hardcoded list. Regression: the
// list stopped at v5 while the live key was v6, leaving the whole prefs
// blob (RPC overrides included) behind after a "wipe everything".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — vitest runs in the node env (see vitest.config.ts).
function installLocalStoragePolyfill(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  return storage;
}

describe("wipeKeystore localStorage scrub (audit C2)", () => {
  beforeEach(() => {
    installLocalStoragePolyfill();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the current v6 key and any other pearl-wallet-ui-vN", async () => {
    localStorage.setItem("pearl-wallet-ui-v6", JSON.stringify({ ethRpcOverride: "https://evil" }));
    localStorage.setItem("pearl-wallet-ui-v5", "{}");
    localStorage.setItem("pearl-wallet-ui-v9", "{}"); // a hypothetical future key
    localStorage.setItem("unrelated-key", "keepme");

    const { db, wipeKeystore } = await import("../src/storage/db");
    // Stub the table ops so the Dexie path resolves cleanly.
    // FZ2: the IndexedDB part is one transaction; run its body directly.
    vi.spyOn(db, "transaction").mockImplementation((async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)()) as never);
    for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
      const tbl = db[t] as unknown as { clear?: () => Promise<void>; delete?: () => Promise<void> };
      if (tbl.clear) vi.spyOn(tbl, "clear").mockResolvedValue(undefined as never);
      if (tbl.delete) vi.spyOn(tbl, "delete").mockResolvedValue(undefined as never);
    }

    await wipeKeystore();

    expect(localStorage.getItem("pearl-wallet-ui-v6")).toBeNull();
    expect(localStorage.getItem("pearl-wallet-ui-v5")).toBeNull();
    expect(localStorage.getItem("pearl-wallet-ui-v9")).toBeNull(); // regex sweep caught it
    expect(localStorage.getItem("unrelated-key")).toBe("keepme"); // not a ui key, preserved
  });

  // FZ2 (GPT-6 R2-A2) intentionally reverses the old "scrub even if the
  // Dexie wipe throws": the scrub now runs only after the one wipe
  // transaction commits. A failed transaction deleted nothing — the wallet
  // is still stored — so scrubbing would erase its broadcast-safety records
  // (Pearl broadcast records, Ethereum "may already be sent" blocks) while
  // its keys remain. The failure is reported (rejects) instead.
  it("a failed wipe transaction rejects and scrubs nothing (the wallet is still stored)", async () => {
    localStorage.setItem("pearl-wallet-ui-v6", "{}");
    localStorage.setItem("pearl-wallet-broadcasts-v1", "{}");
    const { db, wipeKeystore } = await import("../src/storage/db");
    vi.spyOn(db, "transaction").mockRejectedValue(new Error("IDB locked") as never);

    await expect(wipeKeystore()).rejects.toThrow("IDB locked");
    expect(localStorage.getItem("pearl-wallet-ui-v6")).toBe("{}");
    expect(localStorage.getItem("pearl-wallet-broadcasts-v1")).toBe("{}");
  });

  // R2 FY4 (reverts R1 FX5): the single-tab guard's open-tab list lists
  // LIVE tabs, not wallet data. A wipe must keep it: removing it would let
  // a second open tab on a no-Web-Locks browser broadcast concurrently.
  it("keeps the open-tab list of the no-Web-Locks guard (pearl-wallet-tabs-v1)", async () => {
    const { WALLET_TABS_STORAGE_KEY } = await import("../src/services/broadcast-lock");
    expect(WALLET_TABS_STORAGE_KEY).toBe("pearl-wallet-tabs-v1");
    localStorage.setItem(WALLET_TABS_STORAGE_KEY, JSON.stringify(["stale-tab"]));
    localStorage.setItem("unrelated-key", "keepme");
    const { db, wipeKeystore } = await import("../src/storage/db");
    // FZ2: the IndexedDB part is one transaction; run its body directly.
    vi.spyOn(db, "transaction").mockImplementation((async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)()) as never);
    for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
      const tbl = db[t] as unknown as { clear?: () => Promise<void>; delete?: () => Promise<void> };
      if (tbl.clear) vi.spyOn(tbl, "clear").mockResolvedValue(undefined as never);
      if (tbl.delete) vi.spyOn(tbl, "delete").mockResolvedValue(undefined as never);
    }
    await wipeKeystore();
    expect(localStorage.getItem(WALLET_TABS_STORAGE_KEY)).toBe(JSON.stringify(["stale-tab"]));
    expect(localStorage.getItem("unrelated-key")).toBe("keepme");
  });
});

// v0.7 R1 FX2(c): wipe with the verified blob is a compare-and-delete in one
// read-write transaction; a different stored blob wipes nothing at all.
describe("wipeKeystore compare-and-delete (FX2c)", () => {
  const blob = (c: string) =>
    ({ version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: c }) as const;

  beforeEach(() => {
    installLocalStoragePolyfill();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function stubDb(stored: ReturnType<typeof blob> | undefined) {
    const { db, wipeKeystore, updateKeystoreAddresses } = await import("../src/storage/db");
    const tx = vi.spyOn(db, "transaction").mockImplementation((async (...args: unknown[]) => {
      const fn = args[args.length - 1] as () => Promise<unknown>;
      return fn();
    }) as never);
    vi.spyOn(db.keystore, "get").mockResolvedValue(
      stored ? ({ id: "primary", version: 1, blob: stored, publicData: { pearlAddress: "prl1pY" } } as never) : (undefined as never),
    );
    const del = vi.spyOn(db.keystore, "delete").mockResolvedValue(undefined as never);
    const put = vi.spyOn(db.keystore, "put").mockResolvedValue("primary" as never);
    const clears = (["addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const).map((t) =>
      vi.spyOn(db[t] as unknown as { clear: () => Promise<void> }, "clear").mockResolvedValue(undefined as never),
    );
    return { wipeKeystore, updateKeystoreAddresses, tx, del, put, clears };
  }

  it("a different stored blob: nothing deleted, nothing cleared, localStorage kept, 'changed'", async () => {
    localStorage.setItem("pearl-wallet-ui-v6", "{}");
    const { wipeKeystore, tx, del, clears } = await stubDb(blob("wallet-Y"));
    await expect(wipeKeystore(blob("wallet-W"))).resolves.toBe("changed");
    expect(tx).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    for (const c of clears) expect(c).not.toHaveBeenCalled();
    expect(localStorage.getItem("pearl-wallet-ui-v6")).toBe("{}");
  });

  it("the same stored blob: deleted inside the transaction, the rest wiped, 'wiped'", async () => {
    localStorage.setItem("pearl-wallet-ui-v6", "{}");
    const { wipeKeystore, del, clears } = await stubDb(blob("wallet-W"));
    await expect(wipeKeystore(blob("wallet-W"))).resolves.toBe("wiped");
    expect(del).toHaveBeenCalledWith("primary");
    for (const c of clears) expect(c).toHaveBeenCalled();
    expect(localStorage.getItem("pearl-wallet-ui-v6")).toBeNull();
  });

  it("updateKeystoreAddresses with an expected blob refuses a different stored blob", async () => {
    const { updateKeystoreAddresses, put } = await stubDb(blob("wallet-Y"));
    const lists = { pearlAddress: "prl1pY", pearlAddressPool: ["prl1pW"], pearlChangePool: [] };
    await expect(updateKeystoreAddresses(lists, "prl1pY", blob("wallet-W"))).resolves.toBe(false);
    expect(put).not.toHaveBeenCalled();
    await expect(updateKeystoreAddresses(lists, "prl1pY", blob("wallet-Y"))).resolves.toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
