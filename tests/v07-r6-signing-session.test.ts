// R6 N2 (GPT-6 R3-A2, inherited) — a send confirmed before Lock never signs
// in the session unlocked afterwards.
//
// Before: an ETH / WPRL / approve / burn send confirmed while the
// pending-nonce RPC (or the gas estimate, or another tab's broadcast) was
// slow kept running after the user clicked Lock; once the user unlocked
// again it asked the NEW worker session to sign and submitted the old
// transfer, with no page left to show it. lockGeneration guarded only the
// end of unlock().
//
// Now each send captures the signing session when it is confirmed
// (wallet-store captureSigningSession: lock generation + unlocked wallet's
// ETH address) and checks it after its async preparation and, inside the
// address lock, immediately before the worker sign call:
// SigningSessionChangedError (E_SESSION_CHANGED), nothing signed, nothing
// recorded, nothing submitted. The PRL path had the same gap while waiting
// for another tab's broadcast lock (broadcastPearlPrecomposed), fixed the
// same way.
//
// Model: one tab (module instance); the worker is mocked (the public
// "abandon … about" key signs); the node is a fetch mock whose
// eth_getTransactionCount answer is held; Lock is the real wallet-store
// lock(); the unlock that follows is the state unlock() publishes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { fakeLocks, memoryStorage } from "./helpers/broadcast-env";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC);
const ME = account.address;
const TO = "0x000000000000000000000000000000000000dEaD" as const;
const V3 = "pearl-wallet-eth-unknown-v3:";
const g = globalThis as unknown as Record<string, unknown>;

interface RpcReq { id?: number; method: string; params?: unknown[] }
const ok = (id: number | undefined, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, result }), { status: 200, headers: { "content-type": "application/json" } });
const z64 = "0x" + "0".repeat(64);
const block = {
  number: "0x100", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), baseFeePerGas: "0x3b9aca00",
  gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x6500000", transactions: [], difficulty: "0x0", extraData: "0x",
  logsBloom: "0x" + "0".repeat(512), miner: "0x" + "0".repeat(40), mixHash: z64, nonce: "0x0000000000000000",
  receiptsRoot: z64, sha3Uncles: z64, size: "0x1", stateRoot: z64, totalDifficulty: "0x0", transactionsRoot: z64, uncles: [],
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
/** Mock node; while `hold` is set, eth_getTransactionCount waits for it. */
function node() {
  const n = {
    submitted: [] as string[],
    nonceReads: 0,
    hold: null as Promise<void> | null,
    handle: async (req: RpcReq): Promise<Response> => {
      switch (req.method) {
        case "eth_chainId": return ok(req.id, "0x1");
        case "eth_getTransactionCount":
          n.nonceReads++;
          if (n.hold) await n.hold;
          return ok(req.id, "0x5");
        case "eth_estimateGas": return ok(req.id, "0x5208");
        case "eth_getBlockByNumber": return ok(req.id, block);
        case "eth_sendRawTransaction": {
          const hash = keccak256(req.params?.[0] as Hex);
          n.submitted.push(hash);
          return ok(req.id, hash);
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

const ADDRS = { pearl: "prl1pme", pearlPool: ["prl1pme"], pearlChange: [], eth: ME };
async function openTab() {
  vi.resetModules();
  const ethTx = await import("../src/services/eth-tx");
  const pearlTx = await import("../src/services/pearl-tx");
  const ws = await import("../src/state/wallet-store");
  const wc = await import("../src/crypto/worker-client");
  const lock = await import("../src/services/broadcast-lock");
  const { useUI } = await import("../src/state/ui-store");
  const { ethRefusalMessage } = await import("../src/ui/components/EthBroadcastUnknown");
  const { refusalMessage } = await import("../src/ui/components/PendingBroadcasts");
  useUI.setState({ ethRpcOverride: undefined } as never);
  vi.spyOn(wc.cryptoWorker, "reset").mockImplementation(() => undefined);
  const sign = vi.fn(async (p: { tx: import("../src/crypto/worker").EthTxRequest }) => {
    const t = p.tx;
    const raw = await account.signTransaction({
      chainId: t.chainId, type: "eip1559", nonce: t.nonce, to: t.to, value: BigInt(t.value), data: t.data,
      gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
    });
    return { raw };
  });
  const signPrl = vi.fn(async () => ({ raw: "00" }));
  vi.spyOn(wc.cryptoWorker, "call").mockImplementation((async (m: string, p: never) => {
    if (m === "lock") return {};
    if (m === "signEthTx") return sign(p);
    if (m === "signPearlTx") return signPrl();
    throw new Error(`unexpected ${m}`);
  }) as never);
  const unlock = () => ws.useWallet.setState({ status: "unlocked", addresses: ADDRS as never, blob: {} as never });
  unlock();
  return { ethTx, pearlTx, ws, sign, signPrl, unlock, lock, ethRefusalMessage, refusalMessage };
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
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}
let ls: ReturnType<typeof memoryStorage>;

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

describe("N2 — a send confirmed before Lock is refused unsigned after Lock + unlock", () => {
  for (const i of [0, 1, 2, 3]) {
    it(`path ${i}: held nonce read, Lock, unlock, release → SigningSessionChangedError; nothing signed, recorded or submitted`, async () => {
      const n = node();
      const T = await openTab();
      const [name, call] = fourPaths(T)[i]!;
      const gate = deferred();
      n.hold = gate.promise;
      const p = call().catch((e) => e);
      await until(() => n.nonceReads === 1);
      expect(T.sign, name).not.toHaveBeenCalled();
      await T.ws.useWallet.getState().lock();
      expect(T.ws.useWallet.getState().status).toBe("locked");
      T.unlock(); // the user unlocks the same wallet again
      gate.resolve();
      const err = await p;
      expect(T.sign, name).not.toHaveBeenCalled();
      expect(n.submitted, name).toEqual([]);
      expect([...ls.data.keys()].filter((k) => k.startsWith(V3)), name).toEqual([]);
      expect(err, name).toBeInstanceOf(T.ethTx.SigningSessionChangedError);
      expect((err as Error).message, name).toMatch(/^E_SESSION_CHANGED/);
      expect(T.ethRefusalMessage(err)).toBe("The wallet was locked before this send was signed. Nothing was sent; review it again.");
    });
  }

  it("the unwrap's session (passed explicitly) also binds a burn started after the approval: Lock + unlock in between refuses the burn", async () => {
    const n = node();
    const T = await openTab();
    const session = T.ws.captureSigningSession();
    await T.ws.useWallet.getState().lock();
    T.unlock();
    const err = await T.ethTx
      .requestBurn({ network: "mainnet", from: ME, tier: "normal", ceiling, amount: 1n, pearlAddress: "prl1pme", session })
      .catch((e) => e);
    expect(err).toBeInstanceOf(T.ethTx.SigningSessionChangedError);
    expect(T.sign).not.toHaveBeenCalled();
    expect(n.submitted).toEqual([]);
  });

  it("another wallet unlocked (no lock in this tab) also refuses", async () => {
    const n = node();
    const T = await openTab();
    const gate = deferred();
    n.hold = gate.promise;
    const p = fourPaths(T)[0]![1]().catch((e) => e);
    await until(() => n.nonceReads === 1);
    T.ws.useWallet.setState({ addresses: { ...ADDRS, eth: "0x2222222222222222222222222222222222222222" } as never });
    gate.resolve();
    const err = await p;
    expect(T.sign).not.toHaveBeenCalled();
    expect(n.submitted).toEqual([]);
    expect(err).toBeInstanceOf(T.ethTx.SigningSessionChangedError);
  });

  it("no lock: unchanged — each path signs and submits once", async () => {
    for (const i of [0, 1, 2, 3]) {
      const n = node();
      const T = await openTab();
      const [name, call] = fourPaths(T)[i]!;
      const gate = deferred();
      n.hold = gate.promise;
      const p = call();
      await until(() => n.nonceReads === 1);
      gate.resolve();
      const r = (await p) as { txHash: string };
      expect(T.sign, name).toHaveBeenCalledTimes(1);
      expect(n.submitted, name).toEqual([r.txHash]);
    }
  });
});

describe("N2 — PRL: a send waiting for another tab's broadcast lock is refused after Lock + unlock", () => {
  const composed = () => ({
    utxos: [{ txid: "11".repeat(32), vout: 0, valueGrains: 200_000n, scriptHex: "00", branch: 0 as const, index: 0 }],
    outputs: [{ address: "prl1pdest", amountGrains: 100_000n }],
    amountGrains: 100_000n,
    feeGrains: 1_000n,
    tipGrains: 0n,
    changeGrains: 99_000n,
    degraded: false,
    historyIncomplete: 0,
    spendableGrains: 200_000n,
    spendableUtxoCount: 1,
  });

  it("broadcastPearlPrecomposed: Lock + unlock while it waits → refused unsigned; mapped to the readable message", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const T = await openTab();
    // Another tab holds the wallet's broadcast lock.
    const held = deferred();
    const other = T.lock.withBroadcastLock(() => held.promise);
    await tick();
    const p = T.pearlTx.broadcastPearlPrecomposed({ composed: composed() as never, composedAt: Date.now() }, "mainnet").catch((e) => e);
    await tick(20);
    await T.ws.useWallet.getState().lock();
    T.unlock();
    held.resolve();
    await other;
    const err = await p;
    expect(T.signPrl).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(T.ws.SigningSessionChangedError);
    expect(T.refusalMessage(err)).toBe("The wallet was locked before this send was signed. Nothing was sent; review it again.");
    expect(ls.data.get("pearl-wallet-broadcasts-v1") ?? "[]").not.toContain("11".repeat(32));
  });
});

describe('v0.7.1 durable burn intent before submission', () => {
  it('does not broadcast when saving the application intent fails', async () => {
    const n=node(), T=await openTab();
    const persist=vi.fn(async()=>{throw new Error('QuotaExceededError');});
    await expect(T.ethTx.requestBurn({network:'mainnet',from:ME,tier:'normal',ceiling,amount:1n,pearlAddress:'prl1pme',beforeBroadcast:persist})).rejects.toThrow('QuotaExceededError');
    expect(persist).toHaveBeenCalledOnce();expect(n.submitted).toEqual([]);
    expect(ls.length).toBe(0);
  });
  it('saves the locally computed burn hash before the RPC receives it', async () => {
    const n=node(), T=await openTab(); let saved:string|null=null;
    const r=await T.ethTx.requestBurn({network:'mainnet',from:ME,tier:'normal',ceiling,amount:1n,pearlAddress:'prl1pme',beforeBroadcast:async hash=>{
      expect(n.submitted).toEqual([]); saved=hash;
    }});
    expect(saved).toBe(r.txHash);expect(n.submitted).toEqual([saved]);
  });
  it('refuses broadcast if the signing session changes while saving intent', async () => {
    const n=node(), T=await openTab();
    await expect(T.ethTx.requestBurn({network:'mainnet',from:ME,tier:'normal',ceiling,amount:1n,pearlAddress:'prl1pme',beforeBroadcast:async()=>{await T.ws.useWallet.getState().lock();T.unlock();}})).rejects.toThrow('E_SESSION_CHANGED');
    expect(n.submitted).toEqual([]);
  });
});
