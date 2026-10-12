// R8 Q2 (Sonnet R5 F01) — the worker's Ethereum signer enforces its own
// policy on the request instead of signing whatever the main thread sends.
//
// Before: signEthTx checked only the types of chainId / nonce and the `to`
// shape: chainId 999 was SIGNED; a fractional or negative nonce and bad
// calldata reached viem (refused there, or not, by accident of its
// serializer, never with the worker's own error).
//
// Now: the service passes the chain id of the wallet's ETH network
// (EthTxRequest.expectedChainId = ETH_CHAIN_ID[network]); the worker signs
// only when it is one of the wallet's networks and the tx's chainId equals
// it (else E_TX_CHAIN), the nonce is a safe integer >= 0 and `data` is
// absent or 0x-prefixed whole bytes (else E_TX_SHAPE).
//
// Runs the REAL worker module (public "abandon … about" mnemonic) and the
// REAL signing service; the node is a fetch mock. Nothing is broadcast.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ETH_CHAIN_ID, ethChain } from "../src/chains/ethereum/network";
import { cryptoWorker } from "../src/crypto/worker-client";
import type { EthTxRequest } from "../src/crypto/worker";
import * as ethTx from "../src/services/eth-tx";
import { useUI } from "../src/state/ui-store";
import { fakeLocks, memoryStorage } from "./helpers/broadcast-env";
import { fakeIndexedDB } from "./helpers/fake-idb";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ME = mnemonicToAccount(MNEMONIC).address;
const TO = "0x000000000000000000000000000000000000dEaD" as const;

type Resp = { id: string; ok: boolean; result?: unknown; error?: string };
const g = globalThis as unknown as { self?: unknown };
const prevSelf = g.self;
let dispatch: (ev: { data: unknown; origin: string }) => Promise<void>;
let lastResp: Resp | null = null;
async function workerCall<R>(cmd: string, args: Record<string, unknown>): Promise<R> {
  lastResp = null;
  await dispatch({ data: { id: "t", cmd, ...args }, origin: "" });
  const r = lastResp as Resp | null;
  if (!r) throw new Error("no worker response");
  if (!r.ok) throw new Error(r.error);
  return r.result as R;
}
beforeAll(async () => {
  const fakeSelf: { location: { origin: string }; postMessage: (m: Resp) => void; onmessage?: unknown } = {
    location: { origin: "" },
    postMessage: (m: Resp) => {
      lastResp = m;
    },
  };
  g.self = fakeSelf;
  await import("../src/crypto/worker");
  dispatch = fakeSelf.onmessage as typeof dispatch;
  await workerCall("restoreWallet", { mnemonic: MNEMONIC, password: "policy-test-pw", network: "mainnet" });
}, 60_000);
afterAll(() => {
  g.self = prevSelf;
});

const base = (): EthTxRequest => ({
  chainId: 1,
  expectedChainId: 1,
  nonce: 5,
  to: TO,
  value: "1",
  gas: "21000",
  maxFeePerGas: "30000000000",
  maxPriorityFeePerGas: "2000000000",
});
const sign = (tx: Partial<EthTxRequest> & Record<string, unknown>) => workerCall<{ raw: Hex }>("signEthTx", { tx: { ...base(), ...tx } });

describe("R8 Q2 — worker signEthTx policy", () => {
  it("the wallet's networks map to their EIP-155 chain ids (as the service's viem chains)", () => {
    expect(ETH_CHAIN_ID).toEqual({ mainnet: 1, sepolia: 11155111 });
    for (const n of ["mainnet", "sepolia"] as const) expect(ETH_CHAIN_ID[n]).toBe(ethChain(n).id);
  });

  it("normal requests still sign (mainnet and sepolia; plain transfer, ERC-20 calldata, empty 0x data, nonce 0)", async () => {
    for (const tx of [
      {},
      { chainId: 11155111, expectedChainId: 11155111 },
      { data: ("0xa9059cbb" + "00".repeat(64)) as Hex, value: "0" },
      { data: "0x" as Hex },
      { nonce: 0 },
    ]) {
      const { raw } = await sign(tx);
      const parsed = parseTransaction(raw);
      expect(parsed.chainId).toBe(tx.chainId ?? 1);
      expect(parsed.nonce ?? 0).toBe(tx.nonce ?? 5); // viem omits a zero nonce
      expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(ME);
    }
  });

  it("refuses E_TX_CHAIN: chainId 999, a chainId other than the expected one, an expected id that is not a wallet network, or none", async () => {
    for (const tx of [
      { chainId: 999 },
      { chainId: 999, expectedChainId: 999 },
      { chainId: 11155111 },
      { chainId: 1, expectedChainId: 11155111 },
      { expectedChainId: undefined },
      { expectedChainId: "1" },
      { chainId: 1.5, expectedChainId: 1.5 },
    ]) {
      await expect(sign(tx as never), JSON.stringify(tx)).rejects.toThrow(/^E_TX_CHAIN$/);
    }
  });

  it("refuses E_TX_SHAPE: a fractional, negative, unsafe or non-finite nonce", async () => {
    for (const nonce of [1.5, -1, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(sign({ nonce }), String(nonce)).rejects.toThrow(/^E_TX_SHAPE$/);
    }
  });

  it("refuses E_TX_SHAPE: data that is not 0x-prefixed whole bytes of hex", async () => {
    for (const data of ["0xzz", "0xabc", "a9059cbb", "0X00", "0x 00", 123, null]) {
      await expect(sign({ data } as never), String(data)).rejects.toThrow(/^E_TX_SHAPE$/);
    }
  });
});

// ── The signing service passes the wallet network's chain id ─────────────

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

describe("R8 Q2 — every ETH send path signs through the policy with the wallet network's chain id", () => {
  const sentRaw: Hex[] = [];
  beforeEach(() => {
    sentRaw.length = 0;
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    vi.stubGlobal("indexedDB", fakeIndexedDB().factory);
    useUI.setState({ ethRpcOverride: undefined } as never);
    vi.stubGlobal("fetch", vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const req = (Array.isArray(body) ? body[0] : body) as RpcReq;
      switch (req.method) {
        case "eth_chainId": return ok(req.id, "0x1");
        case "eth_getTransactionCount": return ok(req.id, "0x" + (7 + sentRaw.length).toString(16));
        case "eth_estimateGas": return ok(req.id, "0x5208");
        case "eth_getBlockByNumber": return ok(req.id, block);
        case "eth_maxPriorityFeePerGas": return ok(req.id, "0x77359400");
        case "eth_sendRawTransaction": {
          const raw = req.params?.[0] as Hex;
          sentRaw.push(raw);
          return ok(req.id, keccak256(raw));
        }
        default: return ok(req.id, null);
      }
    }));
    vi.spyOn(cryptoWorker, "call").mockImplementation(((cmd: string, args: Record<string, unknown>) => workerCall(cmd, args)) as typeof cryptoWorker.call);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sendNative, sendWprl, approve and burn requests carry expectedChainId 1 on mainnet and are signed", async () => {
    const requests: EthTxRequest[] = [];
    const call = cryptoWorker.call as unknown as ReturnType<typeof vi.fn>;
    const forward = call.getMockImplementation()!;
    call.mockImplementation(((cmd: string, args: { tx: EthTxRequest }) => {
      if (cmd === "signEthTx") requests.push(args.tx);
      return forward(cmd, args);
    }) as never);
    const frozen = () => ({ gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, composedAt: Date.now() });
    const ceiling = { maxFeePerGas: 10n ** 18n, maxCostWei: 10n ** 30n };
    await ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() });
    await ethTx.sendWprl({ network: "mainnet", from: ME, to: TO, amount: 1n, tier: "normal", frozen: { ...frozen(), gas: 65_000n } });
    await ethTx.approveWprlForBridge({ network: "mainnet", from: ME, tier: "normal", ceiling, amount: 1n });
    await ethTx.requestBurn({ network: "mainnet", from: ME, tier: "normal", ceiling, amount: 1n, pearlAddress: "prl1pme" });
    expect(requests).toHaveLength(4);
    for (const r of requests) expect([r.chainId, r.expectedChainId]).toEqual([1, 1]);
    expect(sentRaw).toHaveLength(4);
    for (const raw of sentRaw) expect(parseTransaction(raw).chainId).toBe(1);
  });
});
