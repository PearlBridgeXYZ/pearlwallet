// R3 round-2 FZ1 follow-up (reviews of the uncommitted batch: Sol, GPT-6).
//
// Before: the ETH "may already be sent" record was written only after
// broadcastRaw had thrown — after the send's retries/fallback and the
// by-hash probe — and nothing serialised tabs. So for the whole in-flight
// window (up to about a minute) another tab saw no block, read the pending
// nonce N+1 and signed a second payment; and a tab closed (or crashed)
// mid-submission / mid-probe left no record at all, so a fresh tab paid
// again.
//
// Now every ETH send path (sendNative, sendWprl, approve, burn) runs inside
// one cross-tab exclusive lock per network + address, and the signed tx is
// recorded in shared localStorage BEFORE it is submitted; the record goes
// only on a confirmed send or a definitive rejection.
//
// Tabs = separate module instances (vi.resetModules) sharing one
// localStorage and one navigator.locks (both origin-wide in a browser).
// "Closing" a tab = abandoning its pending call and giving the next tab a
// fresh lock manager (the browser releases a dead tab's locks). ETH RPC is
// the real viem transport with only fetch stubbed; signing uses the public
// "abandon … about" key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { fakeLocks, memoryStorage, type MemoryStorage } from "./helpers/broadcast-env";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC);
const ME = account.address;
const TO = "0x000000000000000000000000000000000000dEaD" as const;
const KEY_V2 = "pearl-wallet-eth-unknown-v2";
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
const stored = () => JSON.parse(ls.getItem(KEY_V2) ?? "{}")[`mainnet:${ME.toLowerCase()}`] ?? [];
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

beforeEach(() => {
  ls = memoryStorage();
  vi.stubGlobal("localStorage", ls);
  vi.stubGlobal("navigator", { locks: fakeLocks() });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete g.addEventListener;
});

describe("FZ1 — no second payment while a broadcast from this address is in flight", () => {
  it("during tab A's in-flight broadcast: the record is already shared, and tab B's four paths refuse unsigned", async () => {
    const n = node();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    n.sendAnswer = async (req) => {
      await gate; // the node has the tx; its answer is slow, then ambiguous
      return rpcErr(req.id, -32000, "already known");
    };
    const A = await openTab();
    const pA = A.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
    await until(() => n.accepted.size === 1);
    const hashA = [...n.accepted.keys()][0];
    // Recorded before submission, visible to every tab.
    expect(stored().map((r: { hash: string }) => r.hash)).toEqual([hashA]);

    const B = await openTab();
    // A's send is still running: B refuses "busy" (another tab is sending
    // from this address), not "may already be on the network".
    for (const [name, call] of fourPaths(B)) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(B.lock.BroadcastRefusedError);
      expect((err as { reason: string }).reason, name).toBe("busy");
    }
    expect(B.sign).not.toHaveBeenCalled();

    release();
    const errA = await pA;
    expect(errA).toBeInstanceOf(A.ethTx.EthBroadcastStatusUnknownError);
    expect(stored()).toHaveLength(1); // still blocking, now status-unknown
    expect(stored()[0].inflight).toBeUndefined();
    for (const [name, call] of fourPaths(B)) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(B.store.EthUnresolvedBroadcastError);
      expect((err as { hash: string }).hash, name).toBe(hashA);
    }
    expect(B.sign).not.toHaveBeenCalled();
    expect(n.accepted.size).toBe(1);
  });

  it("a tab already past its check waits on the address lock, then refuses once A ends status-unknown", async () => {
    const n = node();
    let releaseNonce!: () => void;
    const nonceGate = new Promise<void>((r) => (releaseNonce = r));
    let firstNonceRead = true;
    const base = n.handle;
    n.handle = async (req) => {
      if (req.method === "eth_getTransactionCount" && firstNonceRead) {
        firstNonceRead = false;
        await nonceGate; // A holds the lock, nothing recorded yet
      }
      return base(req);
    };
    n.sendAnswer = (req) => rpcErr(req.id, -32000, "already known");
    const A = await openTab();
    const B = await openTab();
    const pA = A.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    // B starts while A holds the lock but before A recorded anything: B's
    // early check passes, so only the lock stands between B and nonce N+1.
    const pB = B.ethTx.sendWprl({ network: "mainnet", from: ME, to: TO, amount: 1n, tier: "normal", frozen: { ...frozen(), gas: 65_000n } }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    expect(B.sign).not.toHaveBeenCalled();
    releaseNonce();
    expect(await pA).toBeInstanceOf(A.ethTx.EthBroadcastStatusUnknownError);
    expect(await pB).toBeInstanceOf(B.store.EthUnresolvedBroadcastError);
    expect(B.sign).not.toHaveBeenCalled();
    expect(n.accepted.size).toBe(1);
  });

  it("another address on the same origin is not held by this address's lock", async () => {
    const A = await openTab();
    expect(A.lock.ethBroadcastLockName("mainnet", ME)).not.toBe(A.lock.ethBroadcastLockName("mainnet", TO));
    expect(A.lock.ethBroadcastLockName("mainnet", ME)).toBe(A.lock.ethBroadcastLockName("mainnet", ME.toLowerCase()));
    expect(A.lock.ethBroadcastLockName("mainnet", ME)).not.toBe(A.lock.ethBroadcastLockName("sepolia", ME));
  });
});

describe("FZ1 — the pre-submission record's lifecycle", () => {
  it("confirmed send: removed; definitive rejection: removed; ambiguous: kept", async () => {
    const n = node();
    const A = await openTab();
    const send = () => A.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() });
    await expect(send()).resolves.toMatchObject({ txHash: expect.any(String) });
    expect(stored()).toEqual([]);
    n.sendAnswer = (req) => rpcErr(req.id, -32000, "insufficient funds for gas * price + value");
    await expect(send()).rejects.toThrow(/insufficient funds/);
    expect(stored()).toEqual([]);
    n.sendAnswer = (req) => rpcErr(req.id, -32000, "already known");
    await expect(send()).rejects.toBeInstanceOf(A.ethTx.EthBroadcastStatusUnknownError);
    expect(stored()).toHaveLength(1);
  });

  it("a record that cannot be saved: refused before anything is submitted", async () => {
    const n = node();
    const A = await openTab();
    ls.failWrites = true;
    const err = await A.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
    expect(err).toBeInstanceOf(A.lock.BroadcastRefusedError);
    expect((err as { reason: string }).reason).toBe("storage");
    expect(n.accepted.size).toBe(0);
  });
});

// Last: tab A's abandoned call may still settle later (and write to
// whatever localStorage is current then).
describe("FZ1 — closing the tab mid-submission or mid-probe keeps the block", () => {
  it.each(["mid-submission", "mid-probe"] as const)("%s: a fresh tab is blocked on all four paths, probes on mount, unblocks only if found", async (when) => {
    const n = node();
    const never = new Promise<Response>(() => {});
    if (when === "mid-submission") n.sendAnswer = () => never;
    else {
      n.sendAnswer = (req) => rpcErr(req.id, -32000, "already known");
      const base = n.handle;
      n.handle = (req) => (req.method === "eth_getTransactionByHash" ? never : base(req)); // probe hangs
    }
    const A = await openTab();
    void A.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() }).catch(() => undefined);
    await until(() => n.accepted.size === 1);
    const hashA = [...n.accepted.keys()][0];
    // Tab A is closed here: its pending call never settles, the browser
    // releases its locks (a fresh lock manager for the next tab).
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    const C = await openTab();
    expect(C.store.unresolvedEthUnknown("mainnet", ME).map((r) => r.hash)).toEqual([hashA]);
    // Restore a responsive node for C (lookups: not found).
    const n2 = node();
    n2.accepted = n.accepted;
    for (const [name, call] of fourPaths(C)) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
    }
    expect(C.sign).not.toHaveBeenCalled();
    // Mount-time probe, not found: still blocks.
    await C.ethTx.probeEthUnknownRecords("mainnet", ME);
    expect(C.store.unresolvedEthUnknown("mainnet", ME)).toHaveLength(1);
    // Found: "it was sent", no longer blocks; the next send takes nonce 6.
    n2.lookupFound = true;
    await C.ethTx.probeEthUnknownRecords("mainnet", ME);
    expect(C.store.unresolvedEthUnknown("mainnet", ME)).toHaveLength(0);
    const r = (await fourPaths(C)[0][1]()) as { composed: { nonce: number } };
    expect(r.composed.nonce).toBe(6);
  });
});

// R3 round-3 (t13): the pre-submission record of a NORMAL send was stored
// in the same shape as a status-unknown record, so every tab (the sending
// one too) showed "Broadcast status unknown" with "I checked; it was not
// sent" while the tx was still in flight. Ticking it in tab B deleted the
// only crash-safe block; tab A then died mid-flight and a fresh tab C
// signed a second payment.
describe("FZ1 — an in-flight record is not status-unknown while its sender runs", () => {
  async function inflightA() {
    const n = node();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    n.sendAnswer = async (req) => {
      await gate;
      return rpcErr(req.id, -32000, "already known");
    };
    const A = await openTab();
    const pA = A.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
    await until(() => n.accepted.size === 1);
    const hashA = [...n.accepted.keys()][0] as `0x${string}`;
    return { n, A, pA, hashA, release };
  }

  it("the record is marked in flight with its sending tab; that tab sees it as its own", async () => {
    const { A, hashA, release, pA } = await inflightA();
    const [r] = stored();
    expect(r).toMatchObject({ hash: hashA, inflight: true, owner: A.lock.thisTabId });
    const rec = A.store.currentEthUnknown("mainnet", ME)!;
    expect(A.store.isOwnInflight(rec)).toBe(true);
    expect(await A.store.ethInflightSenderActive(rec)).toBe(true);
    release();
    await pA;
    expect(A.store.isOwnInflight(A.store.currentEthUnknown("mainnet", ME)!)).toBe(false);
  });

  it("tab B cannot acknowledge it while A's send runs; the block survives A then dying, and C cannot pay twice", async () => {
    const { n, A, hashA } = await inflightA();
    const B = await openTab();
    const recB = B.store.currentEthUnknown("mainnet", ME)!;
    expect(B.store.isOwnInflight(recB)).toBe(false);
    expect(await B.store.ethInflightSenderActive(recB)).toBe(true);
    // "I checked; it was not sent" while A still holds the address lock: refused, nothing cleared.
    expect(await B.store.acknowledgeEthUnknownChecked("mainnet", ME, hashA)).toBe(false);
    expect(stored().map((r: { hash: string }) => r.hash)).toEqual([hashA]);
    void A;
    // Tab A dies mid-flight: the browser frees its locks.
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    const C = await openTab();
    const n2 = node();
    n2.accepted = n.accepted;
    for (const [name, call] of fourPaths(C)) {
      const err = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
    }
    expect(C.sign).not.toHaveBeenCalled();
    expect(n2.accepted.size).toBe(1);
    // Now its sender is gone: it is status-unknown and can be acknowledged.
    const recC = C.store.currentEthUnknown("mainnet", ME)!;
    expect(await C.store.ethInflightSenderActive(recC)).toBe(false);
    expect(await C.store.acknowledgeEthUnknownChecked("mainnet", ME, hashA)).toBe(true);
    expect(stored()).toEqual([]);
  });

  it("A ending status-unknown turns the in-flight record into a plain one (acknowledgeable at once)", async () => {
    const { A, pA, hashA, release } = await inflightA();
    const B = await openTab();
    release();
    expect(await pA).toBeInstanceOf(A.ethTx.EthBroadcastStatusUnknownError);
    expect(stored()).toEqual([expect.objectContaining({ hash: hashA })]);
    expect(stored()[0].inflight).toBeUndefined();
    expect(stored()[0].owner).toBeUndefined();
    expect(await B.store.ethInflightSenderActive(B.store.currentEthUnknown("mainnet", ME)!)).toBe(false);
    expect(await B.store.acknowledgeEthUnknownChecked("mainnet", ME, hashA)).toBe(true);
    expect(stored()).toEqual([]);
  });

  it("a probe that finds the in-flight tx marks it sent; A's later 'unknown' outcome does not downgrade it", async () => {
    const { n, A, pA, hashA, release } = await inflightA();
    const B = await openTab();
    n.lookupFound = true;
    await B.ethTx.probeEthUnknownRecords("mainnet", ME);
    expect(stored()).toEqual([expect.objectContaining({ hash: hashA, sent: true })]);
    expect(stored()[0].inflight).toBeUndefined();
    n.lookupFound = false; // A's own lookup misses it: A ends status-unknown
    release();
    expect(await pA).toBeInstanceOf(A.ethTx.EthBroadcastStatusUnknownError);
    expect(stored()).toEqual([expect.objectContaining({ hash: hashA, sent: true })]);
    expect(B.store.unresolvedEthUnknown("mainnet", ME)).toEqual([]);
  });

  it("without Web Locks: the owner tab still listed counts as running; unlisted, it is status-unknown", async () => {
    vi.stubGlobal("navigator", {});
    const B = await openTab();
    const rec = { network: "mainnet" as const, from: ME.toLowerCase(), hash: `0x${"cd".repeat(32)}` as `0x${string}`, what: "ETH transfer", ts: 1, inflight: true as const, owner: "tab-A" };
    ls.setItem(KEY_V2, JSON.stringify({ [`mainnet:${ME.toLowerCase()}`]: [rec] }));
    ls.setItem("pearl-wallet-tabs-v1", JSON.stringify(["tab-A"]));
    expect(await B.store.ethInflightSenderActive(rec)).toBe(true);
    expect(await B.store.acknowledgeEthUnknownChecked("mainnet", ME, rec.hash)).toBe(false);
    ls.setItem("pearl-wallet-tabs-v1", JSON.stringify([]));
    expect(await B.store.ethInflightSenderActive(rec)).toBe(false);
    expect(await B.store.acknowledgeEthUnknownChecked("mainnet", ME, rec.hash)).toBe(true);
    expect(stored()).toEqual([]);
  });
});
