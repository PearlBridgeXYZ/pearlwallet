// v0.7 B3 — pending-spend list: persistence in localStorage, expiry,
// tolerance of corrupted storage, and removal on "wipe everything".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingSpends,
  excludePendingSpends,
  pendingOutpoints,
  recordPendingSpends,
  PENDING_SPENDS_STORAGE_KEY,
  PENDING_SPEND_TTL_MS,
} from "../src/services/pending-spends";

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

const T = (n: number) => ({ txid: n.toString(16).padStart(64, "0"), vout: n % 2 });

describe("pending spends", () => {
  beforeEach(() => {
    installLocalStoragePolyfill();
  });
  afterEach(() => {
    clearPendingSpends();
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    vi.restoreAllMocks();
  });

  it("persists to localStorage and survives a reload of the module state", () => {
    recordPendingSpends("ab".repeat(32), [T(1), T(2)], 1_000);
    const raw = localStorage.getItem(PENDING_SPENDS_STORAGE_KEY);
    expect(raw).toContain(T(1).txid);
    expect(pendingOutpoints(1_000).size).toBe(2);
    // Same outpoint again is not duplicated.
    recordPendingSpends("cd".repeat(32), [T(1)], 2_000);
    expect(pendingOutpoints(2_000).size).toBe(2);
  });

  it("expires entries after the TTL", () => {
    recordPendingSpends(null, [T(3)], 0);
    expect(pendingOutpoints(PENDING_SPEND_TTL_MS - 1).size).toBe(1);
    expect(pendingOutpoints(PENDING_SPEND_TTL_MS).size).toBe(0);
  });

  it("matches outpoints case-insensitively and splits coins", () => {
    const u = { txid: "AB".repeat(32), vout: 0, v: 1 };
    recordPendingSpends(null, [{ txid: "ab".repeat(32), vout: 0 }], 0);
    const { spendable, pending } = excludePendingSpends([u, { ...u, vout: 1 }], 0);
    expect(pending).toEqual([u]);
    expect(spendable).toHaveLength(1);
  });

  it("ignores corrupted storage instead of throwing", () => {
    localStorage.setItem(PENDING_SPENDS_STORAGE_KEY, "{not json");
    expect(pendingOutpoints().size).toBe(0);
    localStorage.setItem(PENDING_SPENDS_STORAGE_KEY, JSON.stringify([{ outpoint: "x", spentBy: 1, recordedAt: "y" }]));
    expect(pendingOutpoints().size).toBe(0);
    recordPendingSpends(null, [T(4)]);
    expect(pendingOutpoints().size).toBe(1);
  });

  it("wipeKeystore removes the list", async () => {
    recordPendingSpends(null, [T(5)]);
    const { db, wipeKeystore } = await import("../src/storage/db");
    for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
      const tbl = db[t] as unknown as { clear?: () => Promise<void>; delete?: () => Promise<void> };
      if (tbl.clear) vi.spyOn(tbl, "clear").mockResolvedValue(undefined as never);
      if (tbl.delete) vi.spyOn(tbl, "delete").mockResolvedValue(undefined as never);
    }
    await wipeKeystore();
    expect(localStorage.getItem(PENDING_SPENDS_STORAGE_KEY)).toBeNull();
  });
});
