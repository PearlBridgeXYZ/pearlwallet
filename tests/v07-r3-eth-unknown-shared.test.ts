// R3 FZ1 (GPT-6 R2-A1, Sol PW-R2-02, Sonnet S2) — the ETH "may already be
// sent" block is origin-wide, enforced by the signing service, resolved by
// a lookup on mount, and removed by wipe.
//
// Before (8054da3): the record lived in sessionStorage, so another tab (or
// the browser reopened) had no block and could sign a second payment with
// the next nonce; sendNative / sendWprl / approve / burn did not consult
// it at all (only the pages did); nothing ever looked the hash up again;
// and wipe left it behind.
//
// Two tabs = two module instances (vi.resetModules) that share one
// localStorage double; its writes dispatch 'storage' events to the other
// instances' listeners (as a browser does). Each tab gets its OWN
// sessionStorage, as browsers do, so the pre-fix store is genuinely
// tab-local here. ETH RPC goes through the real viem transport with only
// fetch stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC);
const ME = account.address;
const OTHER = "0x0000000000000000000000000000000000000002" as const;
const H1 = `0x${"11".repeat(32)}` as const;
const KEY_V2 = "pearl-wallet-eth-unknown-v2";
// One localStorage key per record (L1: a shared key rewritten whole lost
// other tabs' records).
const V3 = "pearl-wallet-eth-unknown-v3:";
type RawRec = { network: string; from: string; hash: string; what: string; ts: number; sent?: true };
const putRaw = (s: { setItem(k: string, v: string): void }, r: RawRec) =>
  s.setItem(`${V3}${r.network}:${r.from.toLowerCase()}:${r.hash.toLowerCase()}`, JSON.stringify(r));
const rawFor = (s: { map: Map<string, string> }, network: string, from: string): RawRec[] =>
  [...s.map].filter(([k]) => k.startsWith(`${V3}${network}:${from.toLowerCase()}:`)).map(([, v]) => JSON.parse(v) as RawRec).sort((a, b) => a.ts - b.ts);
const hasV3 = (s: { map: Map<string, string> }) => [...s.map.keys()].some((k) => k.startsWith(V3));

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; key(i: number): string | null; readonly length: number; clear(): void };
function kv(onWrite?: (k: string) => void): KV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, String(v)); onWrite?.(k); },
    removeItem: (k) => { map.delete(k); onWrite?.(k); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
  };
}

// 'storage' event bus standing in for window.addEventListener.
let storageListeners: Array<(e: { key: string | null }) => void> = [];
let shared: ReturnType<typeof kv>;
const g = globalThis as unknown as Record<string, unknown>;

type EthUnknownMod = typeof import("../src/state/eth-unknown");
interface Tab { m: EthUnknownMod; session: ReturnType<typeof kv> }

async function openTab(): Promise<Tab> {
  vi.resetModules();
  const session = kv();
  g.sessionStorage = session;
  const m = await import("../src/state/eth-unknown");
  return { m, session };
}
/** Runs `fn` "in" tab t (its own sessionStorage is the current one). */
function inTab<T>(t: Tab, fn: () => T): T {
  g.sessionStorage = t.session;
  return fn();
}

beforeEach(() => {
  storageListeners = [];
  g.addEventListener = (type: string, fn: (e: { key: string | null }) => void) => {
    if (type === "storage") storageListeners.push(fn);
  };
  shared = kv((k) => {
    for (const l of [...storageListeners]) l({ key: k });
  });
  g.localStorage = shared;
});
afterEach(() => {
  delete g.addEventListener;
  delete g.localStorage;
  delete g.sessionStorage;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FZ1 — the block is shared by every tab and survives a closed browser", () => {
  it("a record made in tab A blocks tab B (opened before or after) and B's view updates live", async () => {
    const A = await openTab();
    const B = await openTab();
    const seenB = vi.fn();
    const off = B.m.subscribeEthUnknown(seenB);
    inTab(A, () => A.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H1, what: "ETH transfer" }));
    expect(inTab(B, () => B.m.currentEthUnknown("mainnet", ME))?.hash).toBe(H1);
    expect(inTab(B, () => B.m.unresolvedEthUnknown("mainnet", ME.toLowerCase()))).toHaveLength(1);
    expect(seenB).toHaveBeenCalled(); // storage event → B re-reads
    expect(() => inTab(B, () => B.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).toThrow(`E_ETH_UNRESOLVED_BROADCAST: ${H1}`);
    // A tab opened later (or the browser reopened: a fresh session) too.
    const C = await openTab();
    expect(inTab(C, () => C.m.currentEthUnknown("mainnet", ME))?.hash).toBe(H1);
    // Other address / network: not blocked.
    expect(inTab(C, () => C.m.currentEthUnknown("mainnet", OTHER))).toBeNull();
    expect(inTab(C, () => C.m.currentEthUnknown("sepolia", ME))).toBeNull();
    expect(hasV3(shared)).toBe(true);
    // Acknowledged in B → gone in A, live.
    const seenA = vi.fn();
    A.m.subscribeEthUnknown(seenA);
    inTab(B, () => B.m.clearEthUnknown("mainnet", ME, H1));
    expect(seenA).toHaveBeenCalled();
    expect(inTab(A, () => A.m.currentEthUnknown("mainnet", ME))).toBeNull();
    off();
  });

  it("blocked storage: an in-memory copy still blocks in this tab", async () => {
    g.localStorage = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); }, removeItem: () => {} };
    const A = await openTab();
    A.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H1, what: "burn" });
    expect(() => A.m.assertNoUnresolvedEthBroadcast("mainnet", ME)).toThrow(A.m.EthUnresolvedBroadcastError);
  });
});

// ── Service layer ───────────────────────────────────────────────────────

interface RpcReq { id?: number; method: string; params?: unknown[] }
const ok = (id: number | undefined, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, result }), { status: 200, headers: { "content-type": "application/json" } });
let methods: string[] = [];
function installFetch(handler: (req: RpcReq) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const req: RpcReq = Array.isArray(body) ? body[0] : body;
    methods.push(req.method);
    return handler(req);
  }));
}
async function signedRaw(nonce = 0): Promise<Hex> {
  return await account.signTransaction({
    chainId: 1, type: "eip1559", nonce, to: "0x000000000000000000000000000000000000dEaD", value: 1n,
    gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
  });
}
function rpcTx(hash: Hex) {
  return {
    hash, from: ME.toLowerCase(), to: "0x000000000000000000000000000000000000dead", nonce: "0x0", value: "0x1", gas: "0x5208",
    maxFeePerGas: "0x6fc23ac00", maxPriorityFeePerGas: "0x77359400", input: "0x", type: "0x2", chainId: "0x1", accessList: [],
    blockHash: null, blockNumber: null, transactionIndex: null, v: "0x0", yParity: "0x0", r: "0x" + "1".repeat(64), s: "0x" + "2".repeat(64),
  };
}
const frozen = () => ({ gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, composedAt: Date.now() });

async function services() {
  vi.resetModules();
  g.sessionStorage = kv();
  const ethTx = await import("../src/services/eth-tx");
  const store = await import("../src/state/eth-unknown");
  const wc = await import("../src/crypto/worker-client");
  const { useUI } = await import("../src/state/ui-store");
  useUI.setState({ ethRpcOverride: undefined } as never);
  ethTx.ETH_BROADCAST_PROBE.intervalMs = 0;
  const sign = vi.spyOn(wc.cryptoWorker, "call");
  return { ethTx, store, sign };
}

describe("FZ1 — the signing service refuses while a record is unresolved", () => {
  beforeEach(() => {
    methods = [];
  });

  it("sendNative / sendWprl / approve / burn: E_ETH_UNRESOLVED_BROADCAST naming the hash; no nonce read, nothing signed", async () => {
    const { ethTx, store, sign } = await services();
    installFetch((req) => ok(req.id, req.method === "eth_estimateGas" ? "0x5208" : req.method === "eth_getBlockByNumber" ? null : "0x0"));
    // Recorded by ANOTHER tab: present only in shared localStorage.
    putRaw(shared, { network: "mainnet", from: ME.toLowerCase(), hash: H1, what: "ETH transfer", ts: 1 });
    const ceiling = { maxFeePerGas: 10n ** 18n, maxCostWei: 10n ** 30n };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["sendNative", () => ethTx.sendNative({ network: "mainnet", from: ME, to: OTHER, value: 1n, tier: "normal", frozen: frozen() })],
      ["sendWprl", () => ethTx.sendWprl({ network: "mainnet", from: ME, to: OTHER, amount: 1n, tier: "normal", frozen: frozen() })],
      ["approve", () => ethTx.approveWprlForBridge({ network: "mainnet", from: ME, tier: "normal", ceiling, amount: 1n })],
      ["burn", () => ethTx.requestBurn({ network: "mainnet", from: ME, tier: "normal", ceiling, amount: 1n, pearlAddress: "prl1pme" })],
    ];
    for (const [name, call] of calls) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(store.EthUnresolvedBroadcastError);
      expect((err as Error).message, name).toBe(`E_ETH_UNRESOLVED_BROADCAST: ${H1}`);
      expect((err as { hash: string }).hash).toBe(H1);
    }
    expect(methods).not.toContain("eth_getTransactionCount");
    expect(methods).not.toContain("eth_sendRawTransaction");
    expect(sign).not.toHaveBeenCalled();
  });

  it("a record that appears while the nonce is being read (another tab) still stops the signature", async () => {
    const { ethTx, store, sign } = await services();
    installFetch((req) => {
      if (req.method === "eth_getTransactionCount") {
        putRaw(shared, { network: "mainnet", from: ME.toLowerCase(), hash: H1, what: "burn", ts: 1 });
        return ok(req.id, "0x5");
      }
      return ok(req.id, null);
    });
    const err = await ethTx.sendNative({ network: "mainnet", from: ME, to: OTHER, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
    expect(err).toBeInstanceOf(store.EthUnresolvedBroadcastError);
    expect(sign).not.toHaveBeenCalled();
  });

  it("another address is not blocked; a status-unknown outcome is recorded by the service itself (no page involved)", async () => {
    const { ethTx, store, sign } = await services();
    const raw = await signedRaw(5);
    const local = keccak256(raw);
    sign.mockResolvedValue({ raw } as never);
    putRaw(shared, { network: "mainnet", from: OTHER, hash: H1, what: "ETH transfer", ts: 1 });
    installFetch((req) => {
      if (req.method === "eth_getTransactionCount") return ok(req.id, "0x5");
      if (req.method === "eth_sendRawTransaction") return new Response("Service Unavailable", { status: 503 });
      return ok(req.id, null); // lookups: not found
    });
    const err = await ethTx.sendNative({ network: "mainnet", from: ME, to: OTHER, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
    expect(err).toBeInstanceOf(ethTx.EthBroadcastStatusUnknownError);
    expect(sign).toHaveBeenCalledTimes(1);
    // Recorded in shared storage: every tab now refuses a second payment.
    expect(store.unresolvedEthUnknown("mainnet", ME).map((r) => r.hash)).toEqual([local]);
    expect(rawFor(shared, "mainnet", ME)[0]).toMatchObject({ hash: local, what: "ETH transfer" });
    const again = await ethTx.sendNative({ network: "mainnet", from: ME, to: OTHER, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
    expect(again).toBeInstanceOf(store.EthUnresolvedBroadcastError);
    expect(sign).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe("FZ1 — on mount each unresolved hash is looked up once", () => {
  beforeEach(() => {
    methods = [];
  });

  it("found on the network → marked sent, no longer blocks (in every tab); not found → still blocks", async () => {
    const { ethTx, store } = await services();
    const H2 = `0x${"22".repeat(32)}` as const;
    store.recordEthUnknown({ network: "mainnet", from: ME, hash: H1, what: "ETH transfer" });
    store.recordEthUnknown({ network: "mainnet", from: ME, hash: H2, what: "burn" });
    installFetch((req) => {
      if (req.method === "eth_getTransactionByHash") return ok(req.id, req.params?.[0] === H1 ? rpcTx(H1) : null);
      return ok(req.id, null);
    });
    await ethTx.probeEthUnknownRecords("mainnet", ME);
    const recs = store.unresolvedEthUnknown("mainnet", ME);
    expect(recs.map((r) => r.hash)).toEqual([H2]);
    // The H1 record is kept as "sent" (shown, not blocking) until dismissed.
    const raw = rawFor(shared, "mainnet", ME);
    expect(raw.find((r: { hash: string }) => r.hash === H1)).toMatchObject({ sent: true });
    expect(store.currentEthUnknown("mainnet", ME)?.hash).toBe(H2); // unresolved shown first
    // H2 found later → nothing blocks; the "sent" notice remains.
    installFetch((req) => ok(req.id, req.method === "eth_getTransactionByHash" ? rpcTx(req.params?.[0] as Hex) : null));
    await ethTx.probeEthUnknownRecords("mainnet", ME);
    expect(store.unresolvedEthUnknown("mainnet", ME)).toEqual([]);
    expect(() => store.assertNoUnresolvedEthBroadcast("mainnet", ME)).not.toThrow();
    expect(store.currentEthUnknown("mainnet", ME)?.sent).toBe(true);
    const { ethUnknownBlocksSend } = await import("../src/ui/components/EthBroadcastUnknown");
    expect(ethUnknownBlocksSend({ hash: H1, what: "ETH transfer", acknowledged: false, sent: true })).toBe(false);
    expect(ethUnknownBlocksSend({ hash: H1, what: "ETH transfer", acknowledged: false })).toBe(true);
  });

  it("the hook probes on mount (the pages share useEthUnknown)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/ui/components/EthBroadcastUnknown.tsx", "utf8");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*void probeEthUnknownRecords\(network, from\);\s*\}, \[network, from\]\);/);
  });
});

describe("FZ1 / Sonnet S2 — wipe removes the record", () => {
  it("wipeKeystore scrubs every record key (and the former v2 key); the store's wipe also clears the in-memory copy and the v1 session key", async () => {
    vi.resetModules();
    const session = kv();
    g.sessionStorage = session;
    session.setItem("pearl-wallet-eth-unknown-v1", "{}");
    const store = await import("../src/state/eth-unknown");
    store.recordEthUnknown({ network: "mainnet", from: ME, hash: H1, what: "ETH transfer" });
    store.recordEthUnknown({ network: "sepolia", from: OTHER, hash: H1, what: "burn" });
    shared.setItem(KEY_V2, "{}");
    expect(hasV3(shared)).toBe(true);
    const { db, wipeKeystore } = await import("../src/storage/db");
    vi.spyOn(db, "transaction").mockImplementation((async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)()) as never);
    for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
      const tbl = db[t] as unknown as Record<string, unknown>;
      vi.spyOn(tbl as never, (t === "keystore" ? "delete" : "clear") as never).mockResolvedValue(undefined as never);
    }
    await expect(wipeKeystore()).resolves.toBe("wiped");
    expect(hasV3(shared)).toBe(false);
    expect(shared.map.has(KEY_V2)).toBe(false); // the former single key goes too
    // wipeKeystore's clear (the only one: R6 N1 removed the wallet store's
    // second call, which this test pinned) also removed the v1 session key
    // and the in-memory copy.
    expect(session.map.has("pearl-wallet-eth-unknown-v1")).toBe(false);
    expect(store.currentEthUnknown("mainnet", ME)).toBeNull();
    const ws = await import("node:fs").then((fs) => fs.readFileSync("src/state/wallet-store.ts", "utf8"));
    const wipe = ws.slice(ws.indexOf("  async wipe(password,"), ws.indexOf("  async exportMnemonic("));
    expect(wipe).toContain("result = await wipeKeystore(blob, expectedVaultIds);");
    expect(wipe).not.toMatch(/clearAllEthUnknown\(/);
  });
});
