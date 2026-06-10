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

  it("still scrubs localStorage even if the Dexie wipe throws (finally runs)", async () => {
    localStorage.setItem("pearl-wallet-ui-v6", "{}");
    const { db, wipeKeystore } = await import("../src/storage/db");
    vi.spyOn(db.keystore, "delete").mockRejectedValue(new Error("IDB locked"));

    await wipeKeystore().catch(() => {}); // may reject from the Dexie side
    expect(localStorage.getItem("pearl-wallet-ui-v6")).toBeNull();
  });
});
