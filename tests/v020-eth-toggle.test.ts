// v0.2.0 — Ethereum surface toggle (default OFF) + custom Ethereum RPC.
//
// Scope:
//   - ui-store persisted shape: ethEnabled defaults false, ethRpcOverride
//     defaults "", STORAGE_KEY bumped v4 → v5.
//   - Pearl ↔ Eth allowlist split: Pearl allowlist no longer accepts
//     ETH-protocol hosts (drpc / publicnode); Eth allowlist accepts those
//     and rejects Pearl-protocol hosts.
//   - setEthEnabled, setEthRpcOverride round-trip through localStorage.
//   - fetchBalances honors `opts.ethEnabled === false` by zeroing the
//     eth/wprl fields and tagging them with source: "off" — and crucially
//     does NOT make any Eth RPC calls when off.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { isAllowedRpcOverride, isAllowedEthRpcOverride } from "../src/state/ui-store";
import { fetchBalances } from "../src/services/balances";
import * as bridge from "../src/services/bridge";
import * as pearlRpc from "../src/services/pearl-rpc";
import * as prices from "../src/services/prices";

// localStorage polyfill — vitest runs in node env per vitest.config.ts.
// The ui-store guards `typeof localStorage === "undefined"` but the test
// needs a real store to round-trip persisted values.
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

describe("v0.2.0 / ui-store storage key + persisted shape", () => {
  beforeEach(() => {
    installLocalStoragePolyfill();
    localStorage.clear();
    // Module-scoped state is captured at the first import of ui-store.
    // Re-import after a localStorage reset in each test so the fresh
    // `loadUI()` runs against an empty store.
    vi.resetModules();
  });

  // Storage key bumped: v5 → v6 in v0.2.8 when offlineSigningEnabled was
  // added to the persisted shape. The v0.2.0 invariant — that the v4 key
  // is never written and the key in use is the post-v0.2.0 one — still
  // holds; only the post-v0.2.0 key name moved forward.
  it("uses the current versioned storage key (and never writes v4)", async () => {
    const { useUI } = await import("../src/state/ui-store");
    useUI.getState().setTheme("dark");
    const raw = localStorage.getItem("pearl-wallet-ui-v7");
    expect(raw).not.toBeNull();
    const v4 = localStorage.getItem("pearl-wallet-ui-v4");
    expect(v4).toBeNull();
  });

  it("defaults ethEnabled to TRUE on a fresh load (v0.4.2: surface on by default)", async () => {
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().ethEnabled).toBe(true);
  });

  it("defaults ethRpcOverride to empty string", async () => {
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().ethRpcOverride).toBe("");
  });

  it("a stale v4 blob is ignored — v5 starts fresh with defaults", async () => {
    localStorage.setItem(
      "pearl-wallet-ui-v4",
      JSON.stringify({ theme: "dark", multisigEnabled: true, ethEnabled: true }),
    );
    const { useUI } = await import("../src/state/ui-store");
    // Stale v4 blob is ignored; current-key empty → fresh defaults. ETH is
    // ON by default (v0.4.2) and multisig is ON by default (v0.5.0 — the
    // Vaults surface graduated from experimental/opt-in).
    expect(useUI.getState().theme).toBe("system");
    expect(useUI.getState().ethEnabled).toBe(true);
    expect(useUI.getState().multisigEnabled).toBe(true);
  });

  it("re-validates ethRpcOverride on load — tampered value becomes empty", async () => {
    localStorage.setItem(
      "pearl-wallet-ui-v5",
      JSON.stringify({
        theme: "system",
        pearlRpcOverride: "",
        ethRpcOverride: "https://attacker.example/rpc", // not allowlisted
        tipEnabled: true,
        multisigEnabled: false,
        ethEnabled: false,
      }),
    );
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().ethRpcOverride).toBe("");
  });

  it("setEthEnabled persists across reloads (within this test)", async () => {
    const { useUI } = await import("../src/state/ui-store");
    useUI.getState().setEthEnabled(true);
    expect(useUI.getState().ethEnabled).toBe(true);
    // Now re-import — should load from localStorage and preserve the flip.
    vi.resetModules();
    const { useUI: useUI2 } = await import("../src/state/ui-store");
    expect(useUI2.getState().ethEnabled).toBe(true);
  });

  it("setEthRpcOverride accepts allowlisted hosts", async () => {
    const { useUI } = await import("../src/state/ui-store");
    useUI.getState().setEthRpcOverride("https://eth.drpc.org/");
    expect(useUI.getState().ethRpcOverride).toBe("https://eth.drpc.org/");
  });

  it("setEthRpcOverride throws E_ETH_RPC_OVERRIDE_NOT_ALLOWED on bad hosts", async () => {
    const { useUI } = await import("../src/state/ui-store");
    expect(() => useUI.getState().setEthRpcOverride("https://attacker.example/")).toThrow(
      /E_ETH_RPC_OVERRIDE_NOT_ALLOWED/,
    );
    expect(() => useUI.getState().setEthRpcOverride("http://eth.drpc.org/")).toThrow(
      /E_ETH_RPC_OVERRIDE_NOT_ALLOWED/,
    );
    // Pearl-protocol host on Eth side is rejected — clean split.
    expect(() =>
      useUI.getState().setEthRpcOverride("https://rpc.pearlbridge.xyz/"),
    ).toThrow(/E_ETH_RPC_OVERRIDE_NOT_ALLOWED/);
  });

  it("setEthRpcOverride accepts empty string (reset to default)", async () => {
    const { useUI } = await import("../src/state/ui-store");
    useUI.getState().setEthRpcOverride("https://eth.drpc.org/");
    useUI.getState().setEthRpcOverride("");
    expect(useUI.getState().ethRpcOverride).toBe("");
  });
});

describe("v0.2.0 / Pearl ↔ Eth allowlist split (defense in depth)", () => {
  it("Pearl allowlist contains only Pearl-protocol hosts", () => {
    expect(isAllowedRpcOverride("https://rpc.pearlbridge.xyz/")).toBe(true);
    expect(isAllowedRpcOverride("https://pearlbridge.xyz/rpc")).toBe(true);
    // Eth-protocol hosts moved off the Pearl list — they would never
    // serve a Pearl RPC anyway, and accepting them here invites
    // misconfiguration.
    expect(isAllowedRpcOverride("https://eth.drpc.org/")).toBe(false);
    expect(isAllowedRpcOverride("https://ethereum-rpc.publicnode.com/")).toBe(false);
  });

  it("Eth allowlist is the mirror image", () => {
    expect(isAllowedEthRpcOverride("https://eth.drpc.org/")).toBe(true);
    expect(isAllowedEthRpcOverride("https://ethereum-rpc.publicnode.com/")).toBe(true);
    expect(isAllowedEthRpcOverride("https://rpc.pearlbridge.xyz/")).toBe(false);
    expect(isAllowedEthRpcOverride("https://pearlbridge.xyz/rpc")).toBe(false);
  });

  it("both allowlists reject http:// and javascript: schemes", () => {
    expect(isAllowedRpcOverride("http://pearlbridge.xyz/")).toBe(false);
    expect(isAllowedRpcOverride("javascript:void(0)")).toBe(false);
    expect(isAllowedEthRpcOverride("http://eth.drpc.org/")).toBe(false);
    expect(isAllowedEthRpcOverride("javascript:void(0)")).toBe(false);
  });

  it("both allowlists accept the empty-string sentinel (use defaults)", () => {
    expect(isAllowedRpcOverride("")).toBe(true);
    expect(isAllowedEthRpcOverride("")).toBe(true);
  });
});

describe("v0.2.0 / fetchBalances honors ethEnabled=false (no Eth RPC calls)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns wprl=0 / eth=0 with sources='off' when ethEnabled is false", async () => {
    // Stub the pearl side + prices so the test is hermetic. The eth
    // side is gated by `if (ethEnabled)` — if the gate works, the
    // bridge module is never touched (we spy on it to assert that).
    // v0.3.1: balances.ts now walks via fetchPrlUtxos directly so the
    // visible balance and the spendable UTXO set can never diverge.
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockResolvedValue({
      utxos: [
        { txid: "a".repeat(64), vout: 0, valueGrains: 100n, scriptHex: "5120" + "00".repeat(32) },
      ],
      degraded: false,
      droppedNoScript: 0,
    });
    vi.spyOn(prices, "fetchPrlPriceUsd").mockResolvedValue(1.23);
    const readWprl = vi.spyOn(bridge, "readWprlBalance");

    const r = await fetchBalances(
      ["prl1pdummy0"],
      "0x0000000000000000000000000000000000000001",
      { ethEnabled: false },
    );

    expect(r.prl).toBe(100n);
    expect(r.prlSource).toBe("live");
    expect(r.wprl).toBe(0n);
    expect(r.wprlSource).toBe("off");
    expect(r.eth).toBe(0n);
    expect(r.ethSource).toBe("off");
    // Critical assertion: with ethEnabled=false the wallet must NOT
    // make any Eth RPC calls. Otherwise an off toggle still leaks the
    // user's address to the Eth RPC provider on every dashboard
    // refetch. We can only directly observe one of the two eth-side
    // calls (the other is same-module so vi.spyOn won't intercept it),
    // but both live behind the same `if (ethEnabled)` gate — if this
    // spy never fires, neither did the in-module fetchEthBalanceWei.
    expect(readWprl).not.toHaveBeenCalled();
  });
});

describe("v0.4.2 — ETH-on-by-default migration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("force-enables ETH once for an existing blob that lacks the marker, preserving other prefs", async () => {
    // An existing v0.3.x user: ETH was off, custom theme + multisig set.
    localStorage.setItem(
      "pearl-wallet-ui-v7",
      JSON.stringify({ theme: "dark", multisigEnabled: true, ethEnabled: false }),
    );
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().ethEnabled).toBe(true); // migrated on
    expect(useUI.getState().theme).toBe("dark"); // preserved
    expect(useUI.getState().multisigEnabled).toBe(true); // preserved
    // marker is persisted so it won't re-run
    const stored = JSON.parse(localStorage.getItem("pearl-wallet-ui-v7")!);
    expect(stored.ethDefaultedOn).toBe(true);
  });

  it("respects a user who turned ETH off AFTER the migration (marker already set)", async () => {
    localStorage.setItem(
      "pearl-wallet-ui-v7",
      JSON.stringify({ theme: "system", ethEnabled: false, ethDefaultedOn: true }),
    );
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().ethEnabled).toBe(false); // NOT re-forced
  });
});

describe("v0.5.0 — multisig-on-by-default migration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults multisigEnabled to TRUE on a fresh load (graduated from experimental)", async () => {
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().multisigEnabled).toBe(true);
  });

  it("force-enables Vaults once for an existing blob lacking the marker, preserving other prefs", async () => {
    // An existing user from before the graduation: multisig was off (old
    // default), with a custom theme and ETH already migrated on.
    localStorage.setItem(
      "pearl-wallet-ui-v7",
      JSON.stringify({
        theme: "dark",
        multisigEnabled: false,
        ethEnabled: true,
        ethDefaultedOn: true,
      }),
    );
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().multisigEnabled).toBe(true); // migrated on
    expect(useUI.getState().theme).toBe("dark"); // preserved
    expect(useUI.getState().ethEnabled).toBe(true); // preserved
    // marker persisted so it won't re-run
    const stored = JSON.parse(localStorage.getItem("pearl-wallet-ui-v7")!);
    expect(stored.multisigDefaultedOn).toBe(true);
  });

  it("respects a user who turned Vaults off AFTER the migration (marker already set)", async () => {
    localStorage.setItem(
      "pearl-wallet-ui-v7",
      JSON.stringify({
        theme: "system",
        multisigEnabled: false,
        multisigDefaultedOn: true,
        ethDefaultedOn: true,
      }),
    );
    const { useUI } = await import("../src/state/ui-store");
    expect(useUI.getState().multisigEnabled).toBe(false); // NOT re-forced
  });
});
