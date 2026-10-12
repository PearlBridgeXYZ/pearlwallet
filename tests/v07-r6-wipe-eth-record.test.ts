// R6 N1 (GPT-6 R3-A1 = GPT-5.6 R3-M1) — a wipe never removes an Ethereum
// send record that is still the only block against paying twice.
//
// Before: wallet-store.wipe() ran clearAllEthUnknown() a second time after
// wipeKeystore() had already run it. Tab A's send was in flight, so the
// first clear kept its record; A's send then ended status-unknown (the
// record rewritten as a plain one) and the second clear removed it from
// localStorage and from the IndexedDB copy. After restoring the same
// wallet, every send path signed again: a second payment. The in-flight
// removal in localStorage was also unconditional (the IndexedDB one
// compared the entry first), and a clear delayed past the keystore commit
// removed a record saved by a wallet restored meanwhile.
//
// Now wipeKeystore's clear is the only one, the localStorage removal of an
// in-flight record is compare-and-remove like IndexedDB's, and records saved
// after the wipe started are kept.
//
// Tabs = module instances (vi.resetModules) sharing localStorage,
// navigator.locks and IndexedDB (tests/helpers/fake-idb). The wallet's
// Dexie tables are stubbed (wipeKeystore's transaction "commits" at once);
// signing uses the public "abandon … about" key; the node is a fetch mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { fakeLocks, memoryStorage, type MemoryStorage } from "./helpers/broadcast-env";
import { fakeIndexedDB, type FakeIdb } from "./helpers/fake-idb";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC);
const ME = account.address;
const TO = "0x000000000000000000000000000000000000dEaD" as const;
const V3 = "pearl-wallet-eth-unknown-v3:";
const g = globalThis as unknown as Record<string, unknown>;

interface RpcReq { id?: number; method: string; params?: unknown[] }
const json = (id: number | undefined, body: Record<string, unknown>) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, ...body }), { status: 200, headers: { "content-type": "application/json" } });
const ok = (id: number | undefined, result: unknown) => json(id, { result });
const z64 = "0x" + "0".repeat(64);
const block = {
  number: "0x100", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), baseFeePerGas: "0x3b9aca00",
  gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x6500000", transactions: [], difficulty: "0x0", extraData: "0x",
  logsBloom: "0x" + "0".repeat(512), miner: "0x" + "0".repeat(40), mixHash: z64, nonce: "0x0000000000000000",
  receiptsRoot: z64, sha3Uncles: z64, size: "0x1", stateRoot: z64, totalDifficulty: "0x0", transactionsRoot: z64, uncles: [],
};
function node() {
  const n = {
    accepted: new Map<string, number>(),
    sendAnswer: (req: RpcReq, hash: Hex): Response | Promise<Response> => ok(req.id, hash),
    handle: async (req: RpcReq): Promise<Response> => {
      switch (req.method) {
        case "eth_chainId": return ok(req.id, "0x1");
        case "eth_getTransactionCount": return ok(req.id, "0x" + (5 + n.accepted.size).toString(16));
        case "eth_estimateGas": return ok(req.id, "0x5208");
        case "eth_getBlockByNumber": return ok(req.id, block);
        case "eth_sendRawTransaction": {
          const raw = req.params?.[0] as Hex;
          const hash = keccak256(raw);
          if (!n.accepted.has(hash)) n.accepted.set(hash, parseTransaction(raw).nonce ?? -1);
          return n.sendAnswer(req, hash);
        }
        default: return ok(req.id, null);
      }
    },
  };
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return n.handle(Array.isArray(body) ? body[0] : body);
  }));
  return n;
}

const BLOB = { version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: "w" };

let ls: MemoryStorage;
let idb: FakeIdb;
async function openTab() {
  vi.resetModules();
  const dbm = await import("../src/storage/db");
  // The wallet's own tables: the wipe transaction runs its body and commits.
  vi.spyOn(dbm.db, "transaction").mockImplementation((async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)()) as never);
  vi.spyOn(dbm.db.keystore, "get").mockResolvedValue(undefined as never);
  for (const name of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
    vi.spyOn(dbm.db[name] as never, (name === "keystore" ? "delete" : "clear") as never).mockResolvedValue(undefined as never);
  }
  const ethTx = await import("../src/services/eth-tx");
  const store = await import("../src/state/eth-unknown");
  const wc = await import("../src/crypto/worker-client");
  const ws = await import("../src/state/wallet-store");
  const bm = await import("../src/state/balance-memory");
  const { useUI } = await import("../src/state/ui-store");
  useUI.setState({ ethRpcOverride: undefined } as never);
  ethTx.ETH_BROADCAST_PROBE.intervalMs = 0;
  ethTx.ETH_BROADCAST_PROBE.timeoutMs = 500;
  ethTx.ETH_BROADCAST_PROBE.deadlineMs = 2_000;
  vi.spyOn(wc.cryptoWorker, "reset").mockImplementation(() => undefined);
  const sign = vi.fn(async (p: { tx: import("../src/crypto/worker").EthTxRequest }) => {
    const t = p.tx;
    const raw = await account.signTransaction({
      chainId: t.chainId, type: "eip1559", nonce: t.nonce, to: t.to, value: BigInt(t.value), data: t.data,
      gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
    });
    return { raw };
  });
  vi.spyOn(wc.cryptoWorker, "call").mockImplementation((async (m: string, p: never) => {
    if (m === "exportMnemonic") return { mnemonic: MNEMONIC };
    if (m === "lock") return {};
    if (m === "signEthTx") return sign(p);
    throw new Error(`unexpected ${m}`);
  }) as never);
  return { ethTx, store, ws, bm, sign, dbm };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

const frozen = () => ({ gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, composedAt: Date.now() });
const ceiling = { maxFeePerGas: 10n ** 18n, maxCostWei: 10n ** 30n };
function fourPaths(t: Tab): Array<[string, () => Promise<unknown>]> {
  return [
    ["sendNative", () => t.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() })],
    ["sendWprl", () => t.ethTx.sendWprl({ network: "mainnet", from: ME, to: TO, amount: 1n, tier: "normal", frozen: { ...frozen(), gas: 65_000n } })],
    ["approve", () => t.ethTx.approveWprlForBridge({ network: "mainnet", from: ME, tier: "normal", ceiling, amount: 1n })],
    ["burn", () => t.ethTx.requestBurn({ network: "mainnet", from: ME, tier: "normal", ceiling, amount: 1n, pearlAddress: "prl1pme" })],
  ];
}
const mine = (k: string) => k.startsWith(`${V3}mainnet:${ME.toLowerCase()}:`);
const stored = () => [...ls.data].filter(([k]) => mine(k)).map(([, v]) => JSON.parse(v));
const durable = () => [...idb.entries("pearl-wallet-eth-sends", "records")].filter(([k]) => mine(k)).map(([, v]) => JSON.parse(v as string));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
/** Tab A's send: signed, recorded in flight in both stores, submitted; the
 *  node never answers (A keeps the address lock). */
async function inflightA() {
  const n = node();
  n.sendAnswer = () => new Promise<Response>(() => {});
  const A = await openTab();
  void A.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() }).catch(() => {});
  await until(() => n.accepted.size === 1 && durable().length === 1);
  return { n, A, hashA: [...n.accepted.keys()][0] as `0x${string}` };
}

beforeEach(() => {
  ls = memoryStorage();
  idb = fakeIndexedDB();
  vi.stubGlobal("localStorage", ls);
  vi.stubGlobal("navigator", { locks: fakeLocks() });
  vi.stubGlobal("indexedDB", idb.factory);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete g.addEventListener;
});

describe("N1 — wipe keeps an in-flight record that turns status-unknown during the wipe", () => {
  it("B's wipe keeps A's in-flight record; A ends status-unknown before the wipe returns; the record stays in both stores and blocks all four paths after restore", async () => {
    const { n, A, hashA } = await inflightA();
    const B = await openTab();
    B.ws.useWallet.setState({ status: "unlocked", blob: BLOB as never, addresses: null });
    // wipeKeystore has returned (its clear kept A's in-flight record) and
    // wipe() now clears this tab's balance memory: at that moment A's send
    // ends with an unknown outcome — the production call the send path makes
    // (it rewrites the record as a plain status-unknown one, both stores).
    let ended: Promise<void> | null = null;
    B.bm.onBalanceMemoryClear(() => {
      if (ended) return;
      expect(stored()).toEqual([expect.objectContaining({ hash: hashA, inflight: true })]);
      ended = A.store.recordEthUnknown({ network: "mainnet", from: ME, hash: hashA, what: "ETH transfer" });
    });
    await B.ws.useWallet.getState().wipe("pw");
    expect(ended).not.toBeNull();
    await ended;
    expect(B.ws.useWallet.getState().status).toBe("no-wallet");
    // Still there in both stores, now status-unknown.
    expect(stored()).toEqual([expect.objectContaining({ hash: hashA })]);
    expect(stored()[0].inflight).toBeUndefined();
    expect(durable()).toEqual([expect.objectContaining({ hash: hashA })]);
    expect(durable()[0].inflight).toBeUndefined();
    // A's tab is gone; the same wallet is restored in a fresh tab: every
    // signing path refuses before signing, naming A's hash.
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    const C = await openTab();
    for (const [name, call] of fourPaths(C)) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
      expect((err as { hash: string }).hash, name).toBe(hashA);
    }
    expect(C.sign).not.toHaveBeenCalled();
    expect(n.accepted.size).toBe(1);
  });

  it("localStorage: an in-flight entry rewritten between the snapshot and the sender check is not removed (compare-and-remove)", async () => {
    node();
    const H = `0x${"44".repeat(32)}` as const;
    const key = `${V3}mainnet:${ME.toLowerCase()}:${H}`;
    const v1 = { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: 1, inflight: true, owner: "tab-x" };
    ls.setItem(key, JSON.stringify(v1));
    const C = await openTab();
    const locks = (globalThis.navigator as unknown as { locks: { request: (...a: unknown[]) => Promise<unknown> } }).locks;
    const realRequest = locks.request.bind(locks);
    // While the clear probes the (gone) sender, the sender's tab records the
    // outcome: the in-flight entry becomes a plain status-unknown one.
    vi.spyOn(locks, "request").mockImplementation(async (...a: unknown[]) => {
      const { inflight: _i, owner: _o, ...plain } = v1;
      ls.setItem(key, JSON.stringify(plain));
      return realRequest(...a);
    });
    await C.store.clearAllEthUnknown();
    expect(stored()).toEqual([expect.objectContaining({ hash: H, ts: 1 })]);
    expect(stored()[0].inflight).toBeUndefined();
  });

  it("a wipe whose clear runs after another tab restored and sent keeps that newer send's record (both stores)", async () => {
    node();
    const B = await openTab();
    const H = `0x${"55".repeat(32)}` as const;
    const OLD = `0x${"66".repeat(32)}` as const;
    await B.store.recordEthUnknown({ network: "mainnet", from: ME, hash: OLD, what: "ETH transfer", ts: Date.now() - 60_000 });
    // The keystore transaction commits; before the wipe's clear runs, a
    // wallet restored in another tab sends and ends status-unknown.
    const R = await openTab();
    vi.spyOn(B.dbm.db, "transaction").mockImplementation((async (...args: unknown[]) => {
      const out = await (args[args.length - 1] as () => Promise<unknown>)();
      await new Promise((r) => setTimeout(r, 5));
      await R.store.recordEthUnknown({ network: "mainnet", from: ME, hash: H, what: "ETH transfer" });
      return out;
    }) as never);
    expect(await B.dbm.wipeKeystore()).toBe("wiped");
    expect(stored().map((r) => r.hash)).toEqual([H]);
    expect(durable().map((r) => r.hash)).toEqual([H]);
  });
});
