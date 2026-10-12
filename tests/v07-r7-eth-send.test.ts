// R7 P2 (GPT-6 R4-A2) — an eth_sendRawTransaction reply counts only if it
// names this very tx; R7 P4 (Sonnet S-03) — ETH signing inside the
// per-address lock is bounded.
//
// P2 before: broadcastRaw discarded the RPC result and returned the locally
// computed hash, so `result: null` or a different hash was a success: the
// send record was cleared from both stores, the UI said "Transaction
// broadcast" and the next send (next nonce) went out — a possible second
// payment. Now only a 0x 32-byte hash equal (any case) to keccak256(raw) is
// an acknowledgement; anything else is looked up by hash (the bounded
// probe): found → sent, not found → EthBroadcastStatusUnknownError and the
// record stays.
//
// P4 before: a worker that never answered signEthTx held
// pearl-wallet-eth-broadcast:<network>:<addr> forever (every later send
// from the address refused "busy" until reload). Now the sign is raced
// against ETH_SIGN_TIMEOUT: E_SIGN_TIMEOUT, nothing recorded or submitted,
// the lock released, a late signature discarded.
//
// Real viem transport with fetch stubbed; signing with the public
// "abandon … about" key; tabs = module instances sharing localStorage,
// navigator.locks and IndexedDB (tests/helpers).
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
function rpcTx(hash: Hex, nonce: number) {
  return {
    hash, from: ME.toLowerCase(), to: TO.toLowerCase(), nonce: "0x" + nonce.toString(16), value: "0x1", gas: "0x5208",
    maxFeePerGas: "0x6fc23ac00", maxPriorityFeePerGas: "0x77359400", input: "0x", type: "0x2", chainId: "0x1", accessList: [],
    blockHash: null, blockNumber: null, transactionIndex: null, v: "0x0", yParity: "0x0", r: "0x" + "1".repeat(64), s: "0x" + "2".repeat(64),
  };
}

/** Mock node: keeps every raw tx it is sent; `ack` decides the result of
 *  eth_sendRawTransaction; lookups find a kept tx only when `lookupFound`. */
function node() {
  const n = {
    accepted: new Map<string, number>(),
    calls: [] as string[],
    ack: (hash: Hex): unknown => hash,
    lookupFound: false,
    handle: async (req: RpcReq): Promise<Response> => {
      n.calls.push(req.method);
      switch (req.method) {
        case "eth_chainId": return ok(req.id, "0x1");
        case "eth_getTransactionCount": return ok(req.id, "0x" + (5 + n.accepted.size).toString(16));
        case "eth_estimateGas": return ok(req.id, "0x5208");
        case "eth_getBlockByNumber": return ok(req.id, block);
        case "eth_sendRawTransaction": {
          const raw = req.params?.[0] as Hex;
          const hash = keccak256(raw);
          if (!n.accepted.has(hash)) n.accepted.set(hash, parseTransaction(raw).nonce ?? -1);
          return ok(req.id, n.ack(hash));
        }
        case "eth_getTransactionByHash": {
          const h = req.params?.[0] as Hex;
          return ok(req.id, n.lookupFound && n.accepted.has(h) ? rpcTx(h, n.accepted.get(h)!) : null);
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

let ls: MemoryStorage;
let idb: FakeIdb;
async function openTab(signer?: (tx: import("../src/crypto/worker").EthTxRequest) => Promise<{ raw: Hex }>) {
  vi.resetModules();
  const ethTx = await import("../src/services/eth-tx");
  const store = await import("../src/state/eth-unknown");
  const wc = await import("../src/crypto/worker-client");
  const { useUI } = await import("../src/state/ui-store");
  useUI.setState({ ethRpcOverride: undefined } as never);
  ethTx.ETH_BROADCAST_PROBE.attempts = 1;
  ethTx.ETH_BROADCAST_PROBE.intervalMs = 0;
  ethTx.ETH_BROADCAST_PROBE.timeoutMs = 500;
  ethTx.ETH_BROADCAST_PROBE.deadlineMs = 2_000;
  const realSign = async (t: import("../src/crypto/worker").EthTxRequest) => ({
    raw: await account.signTransaction({
      chainId: t.chainId, type: "eip1559", nonce: t.nonce, to: t.to, value: BigInt(t.value), data: t.data,
      gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
    }),
  });
  const sign = vi.spyOn(wc.cryptoWorker, "call").mockImplementation((async (_m: string, p: { tx: import("../src/crypto/worker").EthTxRequest }) =>
    (signer ?? realSign)(p.tx)) as never);
  return { ethTx, store, sign, realSign };
}
type Tab = Awaited<ReturnType<typeof openTab>>;
const frozen = () => ({ gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, composedAt: Date.now() });
const sendA = (t: Tab) => t.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() });
const mine = (k: string) => k.startsWith(`${V3}mainnet:${ME.toLowerCase()}:`);
const stored = () => [...ls.data].filter(([k]) => mine(k)).map(([, v]) => JSON.parse(v));
const durable = () => [...idb.entries("pearl-wallet-eth-sends", "records")].filter(([k]) => mine(k)).map(([, v]) => JSON.parse(v as string));

beforeEach(() => {
  ls = memoryStorage();
  idb = fakeIndexedDB();
  vi.stubGlobal("localStorage", ls);
  vi.stubGlobal("navigator", { locks: fakeLocks() });
  vi.stubGlobal("indexedDB", idb.factory);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function signedRaw(nonce = 7): Promise<Hex> {
  return account.signTransaction({
    chainId: 1, type: "eip1559", nonce, to: TO, value: 1n, gas: 21_000n, maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
  });
}

describe("R7 P2 — broadcastRaw accepts only this tx's own hash as the acknowledgement", () => {
  const bad: Array<[string, (h: Hex) => unknown]> = [
    ["null", () => null],
    ["a different hash", () => "0x" + "ff".repeat(32)],
    ["a malformed hash", (h) => h.slice(0, 40)],
    ["a non-string", () => 42],
  ];
  for (const [what, ack] of bad) {
    it(`${what}, not found by the lookup → EthBroadcastStatusUnknownError (never success); the lookup ran`, async () => {
      const n = node();
      n.ack = ack;
      const { ethTx } = await openTab();
      const raw = await signedRaw();
      const err = await ethTx.broadcastRaw("mainnet", raw).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ethTx.EthBroadcastStatusUnknownError);
      expect((err as InstanceType<typeof ethTx.EthBroadcastStatusUnknownError>).hash).toBe(keccak256(raw));
      expect(n.calls).toContain("eth_getTransactionByHash");
    });
  }

  it("null, but the lookup finds the tx by its hash → success", async () => {
    const n = node();
    n.ack = () => null;
    n.lookupFound = true;
    const { ethTx } = await openTab();
    const raw = await signedRaw();
    await expect(ethTx.broadcastRaw("mainnet", raw)).resolves.toBe(keccak256(raw));
  });

  it("the tx's own hash (any case) → success with no lookup", async () => {
    const n = node();
    n.ack = (h) => "0x" + h.slice(2).toUpperCase();
    const { ethTx } = await openTab();
    const raw = await signedRaw();
    await expect(ethTx.broadcastRaw("mainnet", raw)).resolves.toBe(keccak256(raw));
    expect(n.calls).toEqual(["eth_sendRawTransaction"]);
  });
});

describe("R7 P2 — through sendNative: a bad acknowledgement keeps the record and blocks the next send", () => {
  for (const [what, ack] of [["null", () => null], ["a different hash", () => "0x" + "ff".repeat(32)]] as const) {
    it(`${what}: status unknown, both stores keep the record, a second send is refused unsigned; a later lookup that finds it unblocks`, async () => {
      const n = node();
      n.ack = ack;
      const A = await openTab();
      const err = await sendA(A).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(A.ethTx.EthBroadcastStatusUnknownError);
      const hash = [...n.accepted.keys()][0]!;
      expect(stored()).toEqual([expect.objectContaining({ hash })]);
      expect(durable()).toEqual([expect.objectContaining({ hash })]);

      n.ack = (h) => h;
      const signsBefore = A.sign.mock.calls.length;
      await expect(sendA(A)).rejects.toBeInstanceOf(A.ethTx.EthUnresolvedBroadcastError);
      expect(A.sign.mock.calls.length).toBe(signsBefore);
      expect(n.accepted.size).toBe(1);

      n.lookupFound = true;
      await A.ethTx.probeEthUnknownRecords("mainnet", ME);
      await expect(sendA(A)).resolves.toMatchObject({ txHash: expect.any(String) });
      expect(n.accepted.size).toBe(2);
    });
  }
});

describe("R7 P4 — a hung ETH sign is bounded and releases the address lock", () => {
  it("E_SIGN_TIMEOUT after ETH_SIGN_TIMEOUT: nothing recorded or submitted, the next send from the address runs; a late signature is ignored", async () => {
    const n = node();
    let lateResolve: ((v: { raw: Hex }) => void) | null = null;
    const A = await openTab(() => new Promise<{ raw: Hex }>((r) => (lateResolve = r)));
    A.ethTx.ETH_SIGN_TIMEOUT.ms = 50;
    const err = await sendA(A).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^E_SIGN_TIMEOUT/);
    expect(stored()).toEqual([]);
    expect(durable()).toEqual([]);
    expect(n.calls).not.toContain("eth_sendRawTransaction");

    // The lock was released: the next send (worker answering now) goes out
    // at once rather than waiting LOCK_WAIT_MS and refusing "busy".
    A.sign.mockImplementation((async (_m: string, p: { tx: import("../src/crypto/worker").EthTxRequest }) => A.realSign(p.tx)) as never);
    const t0 = Date.now();
    await expect(sendA(A)).resolves.toMatchObject({ txHash: expect.any(String) });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(n.accepted.size).toBe(1);

    // The first request's signature arriving late is never submitted.
    lateResolve!(await A.realSign({ chainId: 1, nonce: 5, to: TO, value: "1", gas: "21000", maxFeePerGas: "30000000000", maxPriorityFeePerGas: "2000000000" } as never));
    await new Promise((r) => setTimeout(r, 20));
    expect(n.accepted.size).toBe(1);
    expect(stored()).toEqual([]);
  });

  it("with the default bound (fake clock, +121 s) a worker that never answers ends E_SIGN_TIMEOUT and frees the address lock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const n = node();
    const A = await openTab(() => new Promise<{ raw: Hex }>(() => {}));
    let settled: string | null = null;
    void sendA(A).then(() => (settled = "sent"), (e: unknown) => (settled = (e as Error).message));
    const lockName = `pearl-wallet-eth-broadcast:mainnet:${ME.toLowerCase()}`;
    for (let i = 0; i < 100 && !locks.isHeld(lockName); i++) await vi.advanceTimersByTimeAsync(1);
    expect(locks.isHeld(lockName)).toBe(true);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(settled, "the send settled within the bound").not.toBeNull();
    expect(settled).toMatch(/^E_SIGN_TIMEOUT/);
    expect(locks.isHeld(lockName)).toBe(false);
    expect(n.calls).not.toContain("eth_sendRawTransaction");
    expect(stored()).toEqual([]);
  });

  it("the default bound is Pearl's 120 s", async () => {
    const { ethTx } = await openTab();
    const { SIGN_TIMEOUT_MS } = await import("../src/services/pearl-tx");
    expect(ethTx.ETH_SIGN_TIMEOUT.ms).toBe(SIGN_TIMEOUT_MS);
  });

  it("the send pages show a readable 'nothing was sent' message", async () => {
    const { ethRefusalMessage } = await import("../src/ui/components/EthBroadcastUnknown");
    expect(ethRefusalMessage(new Error("E_SIGN_TIMEOUT: signing didn't finish; nothing was sent. Reload the page and try again."))).toMatch(/^Nothing was sent: signing didn't finish/);
  });
});
