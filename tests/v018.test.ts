// v0.1.8: tests for the audit-cycle fix batch.
//
// Each describe block corresponds to one finding from
// AUDIT-v0.1.7-{opus1,opus2,minimax1,minimax2}.md. Tests intentionally
// pin behavior at the surface level — module boundaries, not deep
// internals — so future refactors can move code without breaking tests.

import { describe, it, expect, beforeEach } from "vitest";
import {
  fetchPrlBalanceGrains,
  MAX_UTXO_WALK_PAGES,
  MAX_RPC_PAGE_LENGTH,
} from "../src/services/pearl-rpc";
import { computeAAD, AAD, KDF_ITERATIONS, SUPPORTED_BLOB_VERSION } from "../src/crypto/keystore";
import { encryptPlaintext, decryptBlob } from "../src/crypto/keystore";
import { passwordAcceptable, PASSPHRASE_MIN_LENGTH } from "../src/lib/validate";
import { isAllowedRpcOverride, useUI } from "../src/state/ui-store";
import { normalizeRelayerMintSig } from "../src/services/bridge";
import { wipeKeystore } from "../src/storage/db";
import {
  __broadcastChannelNameForTests,
  __broadcastSenderIdForTests,
  __resetWalletStoreForTests,
} from "../src/state/wallet-store";

import { vi } from "vitest";

const ADDR = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("v0.1.8 / pearl-rpc — partial result instead of throw (opus1 M-3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("MAX_RPC_PAGE_LENGTH is reasonable (defends against flood pages)", () => {
    expect(MAX_RPC_PAGE_LENGTH).toBeGreaterThanOrEqual(100);
    expect(MAX_RPC_PAGE_LENGTH).toBeLessThanOrEqual(5000);
  });

  it("returns degraded:true with the partial sum when the sentry tarpits at MAX_UTXO_WALK_PAGES", async () => {
    const PAGE = 100;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      const txs = Array.from({ length: PAGE }, (_, i) => ({
        txid: `${calls.toString(16).padStart(4, "0")}${i.toString(16).padStart(60, "0")}`,
        vin: [],
        vout: [{ value: 0.00000001, n: 0, scriptPubKey: { address: ADDR, hex: "5120" + "00".repeat(32) } }],
      }));
      return jsonResp({ result: txs, error: null });
    }));
    const r = await fetchPrlBalanceGrains(ADDR);
    expect(r.degraded).toBe(true);
    expect(r.grains).toBeGreaterThan(0n);
    expect(calls).toBeLessThanOrEqual(MAX_UTXO_WALK_PAGES + 1);
  });

  it("returns degraded:true if a single page exceeds MAX_RPC_PAGE_LENGTH", async () => {
    const flood = MAX_RPC_PAGE_LENGTH + 100;
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResp({
        result: Array.from({ length: flood }, (_, i) => ({
          txid: `f${i.toString(16).padStart(63, "0")}`,
          vin: [],
          vout: [{ value: 0.00000001, n: 0, scriptPubKey: { address: ADDR, hex: "5120" + "00".repeat(32) } }],
        })),
        error: null,
      }),
    ));
    const r = await fetchPrlBalanceGrains(ADDR);
    expect(r.degraded).toBe(true);
    // We only processed MAX_RPC_PAGE_LENGTH entries — total = cap * 1 grain.
    expect(r.grains).toBe(BigInt(MAX_RPC_PAGE_LENGTH));
  });

  it("happy path returns degraded:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({
      result: [{
        txid: "a".repeat(64),
        vin: [],
        vout: [{ value: 1.0, n: 0, scriptPubKey: { address: ADDR, hex: "5120" + "00".repeat(32) } }],
      }],
      error: null,
    })));
    const r = await fetchPrlBalanceGrains(ADDR);
    expect(r.grains).toBe(100_000_000n);
    expect(r.degraded).toBe(false);
  });
});

describe("v0.1.8 / bridge.coerceUint — strict canonical decimal (opus1 M-1 + minimax M-3)", () => {
  function rawWire(overrides: Record<string, unknown> = {}): unknown {
    return {
      payload: {
        recipient: "0x07696DcaB55E62cfef953666b29Fe1970518cB00",
        sdiHash: "0x" + "ab".repeat(32),
        amount: "1000",
        nonce: "5",
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        ...overrides,
      },
      signature: "0x" + "11".repeat(65),
    };
  }

  it("accepts canonical decimal strings", () => {
    const out = normalizeRelayerMintSig(rawWire());
    expect(out.payload.amount).toBe(1000n);
  });

  it("accepts bigint values directly", () => {
    const out = normalizeRelayerMintSig(rawWire({ amount: 42n }));
    expect(out.payload.amount).toBe(42n);
  });

  it("rejects JSON number (precision risk above 2^53)", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: 12345 }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects hex strings", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "0x10" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "0X10" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects leading zeros", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "007" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects whitespace / signed forms", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: " 100 " }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "+5" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects exponent / fraction notation", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "1e10" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "1.0" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects negative bigint", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: -5n }))).toThrow("E_SIGNATURE_MALFORMED");
  });
});

describe("v0.1.8 / keystore — canonical AAD bytes (minimax M-2)", () => {
  it("AAD is a stable byte sequence with a fixed delimiter (no JSON.stringify dependency)", () => {
    const bytes = computeAAD(SUPPORTED_BLOB_VERSION, "PBKDF2-SHA256", KDF_ITERATIONS, "AES-256-GCM");
    const str = new TextDecoder().decode(bytes);
    expect(str).toContain("pearl-wallet/aad");
    expect(str).toContain(`v=${SUPPORTED_BLOB_VERSION}`);
    expect(str).toContain(`iter=${KDF_ITERATIONS}`);
    // Pipe-delimited — proves we're not relying on object key ordering.
    expect(str.includes("|")).toBe(true);
  });

  it("decryptBlob still works with the new AAD format (encrypt/decrypt round-trip)", async () => {
    const plain = new TextEncoder().encode(JSON.stringify({ mnemonic: "abandon ".repeat(11) + "about" }));
    const blob = await encryptPlaintext(plain, "test-password-12!");
    const back = await decryptBlob(blob, "test-password-12!");
    expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(plain));
  });

  it("AAD constant matches a freshly-computed AAD for current params", () => {
    const fresh = computeAAD(SUPPORTED_BLOB_VERSION, "PBKDF2-SHA256", KDF_ITERATIONS, "AES-256-GCM");
    expect(Array.from(fresh)).toEqual(Array.from(AAD));
  });
});

describe("v0.1.8 / passwordAcceptable — long passphrase escape hatch (opus2 cross-Low)", () => {
  it("PASSPHRASE_MIN_LENGTH is the documented threshold", () => {
    expect(PASSPHRASE_MIN_LENGTH).toBeGreaterThanOrEqual(16);
  });

  it("accepts a 16-char lowercase passphrase", () => {
    expect(passwordAcceptable("correcthorsebattery").ok).toBe(true); // 19 chars all-lower
  });

  it("rejects a 16-char digit-only string (v0.1.9 hardening of v0.1.8 escape hatch)", () => {
    // The original v0.1.8 escape hatch accepted any 16+ chars regardless
    // of variety. v0.1.8 audit (Opus1 M-1, Minimax1 M-1) flagged that an
    // all-digit 16-char string has ~53 bits of work factor against 600k
    // PBKDF2 iterations — brute-forceable on a single GPU in hours.
    // v0.1.9 adds a degenerate-entropy guard.
    expect(passwordAcceptable("1234567890123456").ok).toBe(false);
  });

  it("rejects a 15-char mono-class string (under the passphrase threshold)", () => {
    const out = passwordAcceptable("aaaaaaaaaaaaaaa");
    expect(out.ok).toBe(false);
  });

  it("rejects a 10-char mono-class string", () => {
    expect(passwordAcceptable("0123456789").ok).toBe(false);
  });

  it("still enforces MIN_PASSWORD_LENGTH at the low end", () => {
    expect(passwordAcceptable("Aa1!").ok).toBe(false); // too short even with 4 classes
  });
});

describe("v0.1.8 / RPC override allowlist (minimax L)", () => {
  it("isAllowedRpcOverride accepts empty (use default)", () => {
    expect(isAllowedRpcOverride("")).toBe(true);
  });

  it("isAllowedRpcOverride accepts the canonical sentry host", () => {
    expect(isAllowedRpcOverride("https://rpc.pearlwallet.xyz/")).toBe(true);
    expect(isAllowedRpcOverride("https://rpc.pearlwallet.xyz/v2/sub-path")).toBe(true);
  });

  it("isAllowedRpcOverride rejects http (must be https)", () => {
    expect(isAllowedRpcOverride("http://rpc.pearlwallet.xyz/")).toBe(false);
  });

  it("isAllowedRpcOverride rejects an off-allowlist host", () => {
    expect(isAllowedRpcOverride("https://evil.example/rpc")).toBe(false);
  });

  it("isAllowedRpcOverride rejects malformed URLs", () => {
    expect(isAllowedRpcOverride("not-a-url")).toBe(false);
    expect(isAllowedRpcOverride("javascript:alert(1)")).toBe(false);
  });

  it("setPearlRpcOverride throws on a non-allowlisted host", () => {
    expect(() => useUI.getState().setPearlRpcOverride("https://evil.example")).toThrow("E_RPC_OVERRIDE_NOT_ALLOWED");
    // State should NOT have been mutated.
    expect(useUI.getState().pearlRpcOverride).toBe("");
  });

  it("setPearlRpcOverride accepts an allowlisted host", () => {
    useUI.getState().setPearlRpcOverride("https://rpc.pearlwallet.xyz/v2");
    expect(useUI.getState().pearlRpcOverride).toBe("https://rpc.pearlwallet.xyz/v2");
    useUI.getState().setPearlRpcOverride("");
  });
});

describe("v0.1.8 / wipeKeystore clears localStorage (opus2 L)", () => {
  it("removes the pearl-wallet-ui-v3 key from localStorage", async () => {
    // Test environment lacks both IndexedDB and localStorage. We stub
    // localStorage with a minimal map, and accept that the Dexie calls
    // inside wipeKeystore will throw — what we care about is that the
    // localStorage cleanup happens BEFORE the function returns
    // successfully OR is wrapped to survive the Dexie failure.
    const store = new Map<string, string>();
    const fakeLocalStorage = {
      getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
      setItem(k: string, v: string) { store.set(k, v); },
      removeItem(k: string) { store.delete(k); },
      clear() { store.clear(); },
      key(i: number) { return Array.from(store.keys())[i] ?? null; },
      get length() { return store.size; },
    };
    vi.stubGlobal("localStorage", fakeLocalStorage);
    fakeLocalStorage.setItem("pearl-wallet-ui-v3", JSON.stringify({ theme: "dark" }));
    expect(fakeLocalStorage.getItem("pearl-wallet-ui-v3")).not.toBeNull();
    // Dexie throws in node-only test env; that's fine — we only care
    // that the localStorage cleanup is reachable from the same surface.
    await wipeKeystore().catch(() => undefined);
    // If Dexie threw before reaching localStorage, this test would fail
    // and indicate the localStorage cleanup needs to be split out or
    // ordered before the Dexie calls.
    expect(fakeLocalStorage.getItem("pearl-wallet-ui-v3")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("v0.1.8 / BroadcastChannel self-fire fix (opus2 H3)", () => {
  it("module exports a stable per-tab sender id and a channel name", () => {
    const id1 = __broadcastSenderIdForTests();
    const id2 = __broadcastSenderIdForTests();
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(8);
    expect(id1).toBe(id2); // stable across calls in this tab
    expect(__broadcastChannelNameForTests()).toBe("pearl-wallet-keystore");
  });

  it("__resetWalletStoreForTests is idempotent", () => {
    __resetWalletStoreForTests();
    expect(() => __resetWalletStoreForTests()).not.toThrow();
  });
});

describe("v0.1.8 / no-mnemonic-in-session resident memory (opus2 H4)", () => {
  it("WorkerSession type does NOT carry mnemonic (compile-time + source-level check)", async () => {
    // The worker module is loaded as a side-effect (via dynamic import)
    // so we can read its TS source to verify the type field is gone.
    // This is a guardrail against an accidental regression that
    // re-introduces `mnemonic: string` to WorkerSession.
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("src/crypto/worker.ts", "utf8"),
    );
    // The `interface WorkerSession { ... }` block must not include
    // a `mnemonic:` field.
    const match = src.match(/interface WorkerSession \{([\s\S]*?)\}/);
    expect(match).toBeTruthy();
    const body = match![1]!;
    expect(body.includes("mnemonic")).toBe(false);
  });

  it("createWallet/restoreWallet/unlock all call wipeSession() before reassigning", async () => {
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("src/crypto/worker.ts", "utf8"),
    );
    // Each of the three handler cases must call wipeSession() at the
    // top, before computing the new session.
    for (const name of ["createWallet", "restoreWallet", "unlock"]) {
      const re = new RegExp(`case "${name}":[^]*?wipeSession\\(\\)`, "m");
      expect(src).toMatch(re);
    }
  });
});

describe("v0.1.8 / vite sourcemap disabled (consensus High)", () => {
  it("vite.config.ts sets sourcemap to false", async () => {
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("vite.config.ts", "utf8"),
    );
    expect(src).toMatch(/sourcemap:\s*false/);
    // Sanity: no stray vite.config.js duplicate.
    const fsmod = await import("node:fs/promises");
    let jsExists = true;
    try { await fsmod.stat("vite.config.js"); } catch { jsExists = false; }
    expect(jsExists).toBe(false);
  });
});

describe("v0.1.8 / iframe-bust (v0.1.9 moved out-of-line for CSP)", () => {
  it("index.html references the external iframe-bust script before main", async () => {
    // v0.1.8 audit Opus2 H-1 / Minimax2 H-1: the prior inline script was
    // killed by the wallet's own `script-src 'self'` CSP on non-CF
    // deploys. The bust is now in public/iframe-bust.js — same logic,
    // CSP-clean.
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("index.html", "utf8"),
    );
    expect(src).toMatch(/<script src="\/iframe-bust\.js"><\/script>/);
    // The order matters — bust BEFORE the main module so the framed
    // page can't render React first.
    const bustIdx = src.indexOf('src="/iframe-bust.js"');
    const mainIdx = src.indexOf("/src/main.tsx");
    expect(bustIdx).toBeGreaterThan(0);
    expect(mainIdx).toBeGreaterThan(bustIdx);
  });

  it("public/iframe-bust.js contains the top-frame check", async () => {
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("public/iframe-bust.js", "utf8"),
    );
    expect(src).toMatch(/window\.top\s*!==\s*window\.self/);
  });
});

describe("v0.1.8 / CSP headers — COOP/COEP for worker isolation", () => {
  it("public/_headers sets Cross-Origin-Opener-Policy and Embedder-Policy", async () => {
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("public/_headers", "utf8"),
    );
    expect(src).toMatch(/Cross-Origin-Opener-Policy:\s*same-origin/);
    expect(src).toMatch(/Cross-Origin-Embedder-Policy:\s*require-corp/);
  });
});
