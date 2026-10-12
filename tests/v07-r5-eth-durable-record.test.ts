// R5 M1 — the pre-submission ETH send record survives a browser-process
// crash; L-a — record keys are matched case-insensitively and a key
// without a valid hash segment fails closed.
//
// M1 before: the record saved before eth_sendRawTransaction lived only in
// localStorage, which Chromium commits to disk lazily: a crash right after
// submission could lose it, and the relaunched wallet signed a second
// payment. Now the send path also writes it to IndexedDB in a read-write
// transaction opened with durability "strict" and awaits the commit before
// submitting (a failed write refuses the send), and every reader takes the
// union of both stores.
//
// Model: tabs = module instances (vi.resetModules) sharing one
// localStorage, one navigator.locks and one IndexedDB (tests/helpers/
// fake-idb). "The browser crashed and lost localStorage's last writes" =
// a fresh, empty localStorage + fresh locks with the same IndexedDB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { fakeLocks, memoryStorage, type MemoryStorage } from "./helpers/broadcast-env";
import { fakeIndexedDB, type FakeIdb } from "./helpers/fake-idb";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC);
const ME = account.address;
const TO = "0x000000000000000000000000000000000000dEaD" as const;
// One localStorage key per record: `${V3}<network>:<address>:<hash>`.
const V3 = "pearl-wallet-eth-unknown-v3:";
const g = globalThis as unknown as Record<string, unknown>;

interface RpcReq { id?: number; method: string; params?: unknown[] }
const json = (id: number | undefined, body: Record<string, unknown>) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, ...body }), { status: 200, headers: { "content-type": "application/json" } });
const ok = (id: number | undefined, result: unknown) => json(id, { result });
const rpcErr = (id: number | undefined, code: number, message: string) => json(id, { error: { code, message } });
const z64 = "0x" + "0".repeat(64);
const block = {
  number: "0x100", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), baseFeePerGas: "0x3b9aca00",
  gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x6500000", transactions: [], difficulty: "0x0", extraData: "0x",
  logsBloom: "0x" + "0".repeat(512), miner: "0x" + "0".repeat(40), mixHash: z64, nonce: "0x0000000000000000",
  receiptsRoot: z64, sha3Uncles: z64, size: "0x1", stateRoot: z64, totalDifficulty: "0x0", transactionsRoot: z64, uncles: [],
};

/** Mock node: accepts every raw tx it is sent (recording it), pending nonce
 *  = 5 + accepted; `sendAnswer` decides what the send call returns. */
function node() {
  const n = {
    accepted: new Map<string, number>(), // hash -> nonce
    sendAnswer: (req: RpcReq, hash: Hex): Response | Promise<Response> => ok(req.id, hash),
    lookupFound: false,
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
        case "eth_getTransactionByHash": {
          const h = req.params?.[0] as string;
          return ok(req.id, n.lookupFound && n.accepted.has(h) ? rpcTx(h as Hex, n.accepted.get(h)!) : null);
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
function rpcTx(hash: Hex, nonce: number) {
  return {
    hash, from: ME.toLowerCase(), to: TO.toLowerCase(), nonce: "0x" + nonce.toString(16), value: "0x1", gas: "0x5208",
    maxFeePerGas: "0x6fc23ac00", maxPriorityFeePerGas: "0x77359400", input: "0x", type: "0x2", chainId: "0x1", accessList: [],
    blockHash: null, blockNumber: null, transactionIndex: null, v: "0x0", yParity: "0x0", r: "0x" + "1".repeat(64), s: "0x" + "2".repeat(64),
  };
}

let ls: MemoryStorage;
async function openTab() {
  vi.resetModules();
  const ethTx = await import("../src/services/eth-tx");
  const store = await import("../src/state/eth-unknown");
  const lock = await import("../src/services/broadcast-lock");
  const wc = await import("../src/crypto/worker-client");
  const { useUI } = await import("../src/state/ui-store");
  useUI.setState({ ethRpcOverride: undefined } as never);
  ethTx.ETH_BROADCAST_PROBE.intervalMs = 0;
  ethTx.ETH_BROADCAST_PROBE.timeoutMs = 500;
  ethTx.ETH_BROADCAST_PROBE.deadlineMs = 2_000;
  // The worker, standing in: signs the composed request with the public key.
  const sign = vi.spyOn(wc.cryptoWorker, "call").mockImplementation((async (_m: string, p: { tx: import("../src/crypto/worker").EthTxRequest }) => {
    const t = p.tx;
    const raw = await account.signTransaction({
      chainId: t.chainId, type: "eip1559", nonce: t.nonce, to: t.to, value: BigInt(t.value), data: t.data,
      gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
    });
    return { raw };
  }) as never);
  return { ethTx, store, lock, sign };
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
const stored = () =>
  [...ls.data].filter(([k]) => k.startsWith(`${V3}mainnet:${ME.toLowerCase()}:`)).map(([, v]) => JSON.parse(v)).sort((a, b) => a.ts - b.ts);
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

const DB = "pearl-wallet-eth-sends";
const STORE = "records";
let idb: FakeIdb;
const durableAll = () => [...idb.entries(DB, STORE)];
const durable = () =>
  durableAll().filter(([k]) => k.startsWith(`${V3}mainnet:${ME.toLowerCase()}:`)).map(([, v]) => JSON.parse(v as string)).sort((a, b) => a.ts - b.ts);
const putDurable = (k: string, v: unknown) => {
  if (!idb.data.has(DB)) idb.data.set(DB, new Map([[STORE, new Map()]]));
  idb.data.get(DB)!.get(STORE)!.set(k, typeof v === "string" ? v : JSON.stringify(v));
};
const keyOf = (hash: string, addr = ME.toLowerCase(), net = "mainnet") => `${V3}${net}:${addr}:${hash}`;
/** The browser process died: localStorage lost its last (uncommitted)
 *  writes, every tab's locks are gone; IndexedDB's committed state stays. */
function crash(keepLocalStorage = false) {
  if (!keepLocalStorage) {
    ls = memoryStorage();
    vi.stubGlobal("localStorage", ls);
  }
  vi.stubGlobal("navigator", { locks: fakeLocks() });
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

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

const sendA = (t: Tab) => t.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() });

describe("M1 — the record is committed to IndexedDB (durability strict) before submission", () => {
  it("when eth_sendRawTransaction reaches the node, the IndexedDB row already exists (committed, strict); a confirmed send clears both stores", async () => {
    const n = node();
    const A = await openTab();
    let atSend: { durable: unknown[]; local: unknown[]; strictCommitted: boolean } | null = null;
    n.sendAnswer = (req, hash) => {
      atSend = {
        durable: durable(),
        local: stored(),
        strictCommitted: idb.txLog.some((t) => t.mode === "readwrite" && t.committed && (t.options as { durability?: string })?.durability === "strict"),
      };
      return ok(req.id, hash);
    };
    const r = await sendA(A);
    expect(atSend).not.toBeNull();
    expect(atSend!.durable).toEqual([expect.objectContaining({ hash: r.txHash, inflight: true, owner: A.lock.thisTabId, what: "ETH transfer" })]);
    expect(atSend!.local).toEqual([expect.objectContaining({ hash: r.txHash, inflight: true })]);
    expect(atSend!.strictCommitted).toBe(true);
    // Every read-write transaction asked for strict durability.
    expect(idb.txLog.filter((t) => t.mode === "readwrite").every((t) => (t.options as { durability?: string })?.durability === "strict")).toBe(true);
    expect(durable()).toEqual([]);
    expect(stored()).toEqual([]);
  });
});

describe("M1 — localStorage lost in a crash, the IndexedDB row still blocks", () => {
  it("mid-submission crash: a fresh module instance refuses on all four paths (nothing signed), shows the record, and unblocks only after a lookup or an acknowledgement", async () => {
    const n = node();
    n.sendAnswer = () => new Promise<Response>(() => {}); // the node has it; the answer never comes
    const A = await openTab();
    void sendA(A).catch(() => undefined);
    await until(() => n.accepted.size === 1);
    const hashA = [...n.accepted.keys()][0] as `0x${string}`;
    expect(durable()).toEqual([expect.objectContaining({ hash: hashA, inflight: true })]);
    crash(); // localStorage's record is gone
    expect(stored()).toEqual([]);
    const C = await openTab();
    const n2 = node();
    n2.accepted = n.accepted;
    for (const [name, call] of fourPaths(C)) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
      expect((err as { hash: string }).hash, name).toBe(hashA);
    }
    expect(C.sign).not.toHaveBeenCalled();
    expect(n2.accepted.size).toBe(1);
    // The UI view (the page hook reads currentEthUnknown): the fresh page
    // loaded the IndexedDB copy on its own.
    const D = await openTab();
    await tick(20);
    const shown = D.store.currentEthUnknown("mainnet", ME);
    expect(shown).toMatchObject({ hash: hashA, inflight: true });
    expect(await D.store.ethInflightSenderActive(shown!)).toBe(false); // sender gone: status unknown
    expect(() => D.store.assertNoUnresolvedEthBroadcast("mainnet", ME)).toThrow(D.store.EthUnresolvedBroadcastError);
    // Mount-time lookup, not found: still blocks.
    await C.ethTx.probeEthUnknownRecords("mainnet", ME);
    expect(C.store.unresolvedEthUnknown("mainnet", ME)).toHaveLength(1);
    // "I checked; it was not sent": both stores cleared, the next send proceeds.
    expect(await C.store.acknowledgeEthUnknownChecked("mainnet", ME, hashA)).toBe(true);
    expect(durable()).toEqual([]);
    expect(stored()).toEqual([]);
    const r = (await fourPaths(C)[0][1]()) as { composed: { nonce: number } };
    expect(r.composed.nonce).toBe(6);
  });

  it("an IndexedDB row with no localStorage copy at all is enough: a fresh tab's lookup that finds it marks it sent in IndexedDB", async () => {
    const n = node();
    const A = await openTab();
    void A;
    const H = `0x${"ab".repeat(32)}`;
    n.accepted.set(H, 5);
    putDurable(keyOf(H), { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "burn", ts: 1, inflight: true, owner: "tab-dead" });
    const C = await openTab();
    await expect(sendA(C)).rejects.toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
    n.lookupFound = true;
    await C.ethTx.probeEthUnknownRecords("mainnet", ME);
    expect(durable()).toEqual([expect.objectContaining({ hash: H, sent: true })]);
    expect(C.store.unresolvedEthUnknown("mainnet", ME)).toEqual([]);
    await expect(sendA(C)).resolves.toMatchObject({ txHash: expect.any(String) });
  });
});

describe("M1 — an IndexedDB copy that cannot be written (or read) refuses the send; nothing is submitted", () => {
  it("write fails: BroadcastRefusedError('storage'), nothing reaches the node, the localStorage record is taken back", async () => {
    const n = node();
    const A = await openTab();
    idb.failWrites = true;
    const err = await sendA(A).catch((e) => e);
    expect(err).toBeInstanceOf(A.lock.BroadcastRefusedError);
    expect((err as { reason: string }).reason).toBe("storage");
    expect(String((err as Error).message)).toMatch(/E_ETH_BROADCAST_RECORD/);
    expect(n.accepted.size).toBe(0);
    expect(stored()).toEqual([]);
    expect(durable()).toEqual([]);
    expect(A.store.unresolvedEthUnknown("mainnet", ME)).toEqual([]);
    // IndexedDB works again: the address is not blocked.
    idb.failWrites = false;
    await expect(sendA(A)).resolves.toMatchObject({ txHash: expect.any(String) });
    expect(n.accepted.size).toBe(1);
  });

  it("the commit does not complete in time: refused, nothing submitted", async () => {
    const n = node();
    const A = await openTab();
    const journal = await import("../src/state/eth-send-journal");
    journal.ETH_SEND_JOURNAL_TIMEOUT.ms = 50;
    idb.beforeCommit = () => new Promise(() => {}); // the commit never lands
    const err = await sendA(A).catch((e) => e);
    expect(err).toBeInstanceOf(A.lock.BroadcastRefusedError);
    expect((err as { reason: string }).reason).toBe("storage");
    expect(n.accepted.size).toBe(0);
    expect(stored()).toEqual([]);
  });

  it.each(["failReads", "failOpen"] as const)("%s: refused before anything is signed", async (how) => {
    const n = node();
    // Set before the page loads (R6: was set after openTab). failOpen only
    // affects open(), and the page's load-time read opens the connection on
    // a timer; once eth-tx also imported the wallet store the module loads
    // took longer than that timer, so the connection was already open and
    // the flag tested nothing. An IndexedDB that cannot be opened fails for
    // the whole page.
    idb[how] = true;
    const A = await openTab();
    for (const [name, call] of fourPaths(A)) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(A.lock.BroadcastRefusedError);
      expect((err as { reason: string }).reason, name).toBe("storage");
    }
    expect(A.sign).not.toHaveBeenCalled();
    expect(n.accepted.size).toBe(0);
  });
});

describe("M1 — every resolution path applies to both stores", () => {
  it("definitive rejection: both cleared; ambiguous: both hold the plain (status-unknown) record", async () => {
    const n = node();
    const A = await openTab();
    n.sendAnswer = (req) => rpcErr(req.id, -32000, "insufficient funds for gas * price + value");
    await expect(sendA(A)).rejects.toThrow(/insufficient funds/);
    expect(stored()).toEqual([]);
    expect(durable()).toEqual([]);
    n.sendAnswer = (req) => rpcErr(req.id, -32000, "already known");
    const err = (await sendA(A).catch((e) => e)) as { hash: string };
    expect(err).toBeInstanceOf(A.ethTx.EthBroadcastStatusUnknownError);
    for (const recs of [stored(), durable()]) {
      expect(recs).toEqual([expect.objectContaining({ hash: err.hash, what: "ETH transfer" })]);
      expect(recs[0].inflight).toBeUndefined();
      expect(recs[0].owner).toBeUndefined();
    }
    // A crash losing localStorage now still blocks.
    crash();
    const C = await openTab();
    await expect(sendA(C)).rejects.toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
  });

  it("acknowledgement clears both; a lookup that finds it marks both sent; dismissing clears both", async () => {
    const n = node();
    const A = await openTab();
    n.sendAnswer = (req) => rpcErr(req.id, -32000, "already known");
    const e1 = (await sendA(A).catch((e) => e)) as { hash: `0x${string}` };
    const B = await openTab();
    expect(await B.store.acknowledgeEthUnknownChecked("mainnet", ME, e1.hash)).toBe(true);
    expect(stored()).toEqual([]);
    expect(durable()).toEqual([]);
    // Another ambiguous send; a lookup finds it.
    const e2 = (await sendA(A).catch((e) => e)) as { hash: `0x${string}` };
    n.lookupFound = true;
    await B.ethTx.probeEthUnknownRecords("mainnet", ME);
    expect(stored()).toEqual([expect.objectContaining({ hash: e2.hash, sent: true })]);
    expect(durable()).toEqual([expect.objectContaining({ hash: e2.hash, sent: true })]);
    expect(B.store.unresolvedEthUnknown("mainnet", ME)).toEqual([]);
    expect(await B.store.clearEthUnknown("mainnet", ME, e2.hash)).toBe(true);
    expect(stored()).toEqual([]);
    expect(durable()).toEqual([]);
  });

  it("the stores disagree: unresolved in either one blocks (localStorage 'sent', IndexedDB status-unknown)", async () => {
    node();
    const H = `0x${"cd".repeat(32)}`;
    ls.setItem(keyOf(H), JSON.stringify({ network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: 1, sent: true }));
    putDurable(keyOf(H), { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: 1 });
    const C = await openTab();
    await expect(sendA(C)).rejects.toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
    expect(C.store.currentEthUnknown("mainnet", ME)).toMatchObject({ hash: H });
    expect(C.store.currentEthUnknown("mainnet", ME)?.sent).toBeUndefined();
    // And the other way round.
    ls.setItem(keyOf(H), JSON.stringify({ network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: 1 }));
    putDurable(keyOf(H), { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: 1, sent: true });
    await expect(sendA(C)).rejects.toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
  });

  it("an acknowledgement whose IndexedDB delete fails reports false and keeps blocking", async () => {
    node();
    const H = `0x${"ef".repeat(32)}`;
    ls.setItem(keyOf(H), JSON.stringify({ network: "mainnet", from: ME.toLowerCase(), hash: H, what: "burn", ts: 1 }));
    putDurable(keyOf(H), { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "burn", ts: 1 });
    const C = await openTab();
    await C.store.refreshDurableEthUnknown();
    idb.failWrites = true;
    expect(await C.store.acknowledgeEthUnknownChecked("mainnet", ME, H)).toBe(false);
    expect(stored()).toEqual([]);
    expect(durable()).toHaveLength(1);
    await expect(sendA(C)).rejects.toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
    idb.failWrites = false;
    expect(await C.store.acknowledgeEthUnknownChecked("mainnet", ME, H)).toBe(true);
    expect(durable()).toEqual([]);
  });
});

describe("M1 — wipe / consented overwrite clear the IndexedDB copy by the localStorage rules", () => {
  it("plain, sent and unreadable entries go from both stores; an in-flight record whose sender holds the lock stays in both; once it is gone a later wipe removes it", async () => {
    const n = node();
    n.sendAnswer = () => new Promise<Response>(() => {});
    const A = await openTab();
    void sendA(A).catch(() => undefined);
    await until(() => n.accepted.size === 1);
    const hashA = [...n.accepted.keys()][0] as `0x${string}`;
    const P = `0x${"11".repeat(32)}`;
    const S = `0x${"22".repeat(32)}`;
    putDurable(keyOf(P), { network: "mainnet", from: ME.toLowerCase(), hash: P, what: "approval", ts: 1 });
    putDurable(keyOf(S), { network: "mainnet", from: ME.toLowerCase(), hash: S, what: "burn", ts: 2, sent: true });
    putDurable(`${V3}mainnet:${ME.toLowerCase()}`, "{not json");
    putDurable("junk", "x");
    const B = await openTab();
    await B.store.clearAllEthUnknown(); // what wipe and replace-wallet run
    expect(durableAll().map(([k]) => k)).toEqual([keyOf(hashA)]);
    expect(stored().map((r: { hash: string }) => r.hash)).toEqual([hashA]);
    // A dies; with its lock gone, a later wipe removes it from both.
    crash(true);
    const C = await openTab();
    await C.store.clearAllEthUnknown();
    expect(durableAll()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it("an in-flight record only IndexedDB still holds (localStorage lost), sender gone: wiped", async () => {
    node();
    const H = `0x${"33".repeat(32)}`;
    putDurable(keyOf(H), { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: 1, inflight: true, owner: "tab-dead" });
    const C = await openTab();
    await C.store.clearAllEthUnknown();
    expect(durableAll()).toEqual([]);
  });

  it("an entry changed between the snapshot and the sender check is not removed", async () => {
    node();
    const H = `0x${"44".repeat(32)}`;
    const v1 = { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: 1, inflight: true, owner: "tab-x" };
    putDurable(keyOf(H), v1);
    const C = await openTab();
    const locks = (globalThis.navigator as unknown as { locks: { request: (...a: unknown[]) => Promise<unknown> } }).locks;
    const realRequest = locks.request.bind(locks);
    // While the wipe probes the sender, the entry is rewritten (a new state).
    vi.spyOn(locks, "request").mockImplementation(async (...a: unknown[]) => {
      putDurable(keyOf(H), { ...v1, ts: 2 });
      return realRequest(...a);
    });
    await C.store.clearAllEthUnknown();
    expect(durable()).toEqual([expect.objectContaining({ hash: H, ts: 2 })]);
  });
});

describe("L-a — keys are matched case-insensitively; a missing or bad hash segment fails closed", () => {
  it("a record under a mixed-case address (or network) key blocks that address, in localStorage and in the IndexedDB copy", async () => {
    node();
    const H = `0x${"55".repeat(32)}`;
    ls.setItem(`${V3}mainnet:${ME}:${H}`, JSON.stringify({ network: "mainnet", from: ME, hash: H, what: "ETH transfer", ts: 1 }));
    const C = await openTab();
    expect(C.store.unresolvedEthUnknown("mainnet", ME).map((r) => r.hash)).toEqual([H]); // pre-fix: [] (exact lowercase prefix)
    await expect(sendA(C)).rejects.toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
    expect(await C.store.acknowledgeEthUnknownChecked("mainnet", ME, H)).toBe(true);
    expect(ls.data.size).toBe(0);
    const H2 = `0x${"66".repeat(32)}`;
    putDurable(`${V3}MAINNET:${ME.toUpperCase().replace("0X", "0x")}:${H2.toUpperCase().replace("0X", "0x")}`, {
      network: "mainnet", from: ME, hash: H2, what: "burn", ts: 1,
    });
    await expect(sendA(C)).rejects.toMatchObject({ hash: H2 });
  });

  it.each([
    ["no hash segment", `${V3}mainnet:${"0x9858effd232b4033e47d90003d41ec34ecaeda94"}`],
    ["empty hash segment", `${V3}mainnet:${"0x9858effd232b4033e47d90003d41ec34ecaeda94"}:`],
    ["bad hash segment", `${V3}mainnet:${"0x9858EfFD232B4033E47d90003D41EC34EcaEda94"}:0xnothex`],
  ])("%s: an unreadable record that blocks until acknowledged", async (_name, key) => {
    node();
    ls.setItem(key, JSON.stringify({ network: "mainnet", from: ME, hash: `0x${"77".repeat(32)}`, what: "ETH transfer", ts: 1 }));
    const C = await openTab();
    const [r] = C.store.unresolvedEthUnknown("mainnet", ME);
    expect(r).toMatchObject({ what: C.store.ETH_UNKNOWN_UNREADABLE, hash: C.store.ETH_UNKNOWN_ZERO_HASH });
    expect(C.store.isUnreadableEthUnknown(r!)).toBe(true);
    await expect(sendA(C)).rejects.toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
    expect(await C.store.acknowledgeEthUnknownChecked("mainnet", ME, C.store.ETH_UNKNOWN_ZERO_HASH)).toBe(true);
    expect(ls.data.has(key)).toBe(false);
    expect(C.store.unresolvedEthUnknown("mainnet", ME)).toEqual([]);
  });

  it("another address's key is not matched (no prefix confusion)", async () => {
    node();
    const H = `0x${"88".repeat(32)}`;
    ls.setItem(`${V3}mainnet:${ME.toLowerCase()}00:${H}`, "{}"); // names no valid address
    ls.setItem(`${V3}sepolia:${ME.toLowerCase()}:${H}`, JSON.stringify({ network: "sepolia", from: ME, hash: H, what: "x", ts: 1 }));
    const C = await openTab();
    expect(C.store.unresolvedEthUnknown("mainnet", ME)).toEqual([]);
  });
});
