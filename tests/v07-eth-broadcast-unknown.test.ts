// v0.7 R1 FX1 (Sonnet F1, medium) — ETH broadcast status-unknown.
//
// A gateway 504 can follow a delivered eth_sendRawTransaction; viem then
// retries / hops to the next provider, which answers "already known". That
// must never surface as a plain failure (the user would resend and pay
// twice). broadcastRaw computes the hash locally, probes it by hash, and
// returns success / EthBroadcastStatusUnknownError / the original verdict.
//
// Everything goes through the REAL viem transport (fallback(http())) with
// only globalThis.fetch stubbed (pattern: v07-activity-eth-cancel).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { keccak256, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  broadcastRaw,
  EthBroadcastStatusUnknownError,
  ETH_BROADCAST_PROBE,
  isDefinitiveEthRejection,
} from "../src/services/eth-tx";
import * as ethTx from "../src/services/eth-tx";
import * as bridgeV1 from "../src/services/bridge-v1";
import { bridgeConfig } from "../src/services/bridge";
import { ETH_RPC_DEFAULTS, ethTxExplorerUrl } from "../src/chains/ethereum/network";
import { useUI } from "../src/state/ui-store";
import * as workerClient from "../src/crypto/worker-client";
import { createUnwrapFlow, type UnwrapView } from "../src/ui/pages/bridge-flows";
import EthBroadcastUnknown, { ethUnknownBlocksSend, type EthUnknownState } from "../src/ui/components/EthBroadcastUnknown";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const [URL_A, URL_B] = ETH_RPC_DEFAULTS.mainnet;
const account = mnemonicToAccount(MNEMONIC);

interface RpcReq { id?: number; method: string; params?: unknown[] }
interface Rec { method: string; url: string }
let records: Rec[] = [];

function ok(id: number | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function rpcErr(id: number | undefined, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const http504 = () => new Response("Gateway Timeout", { status: 504 });

type Handler = (req: RpcReq, url: string) => Response | Promise<Response>;
function installFetch(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const req: RpcReq = Array.isArray(body) ? body[0] : body;
    records.push({ method: req.method, url });
    return handler(req, url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function signedRaw(nonce = 0): Promise<Hex> {
  return await account.signTransaction({
    chainId: 1,
    type: "eip1559",
    nonce,
    to: "0x000000000000000000000000000000000000dEaD",
    value: 1n,
    gas: 21_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
  });
}

function rpcTx(hash: Hex) {
  return {
    hash,
    from: account.address.toLowerCase(),
    to: "0x000000000000000000000000000000000000dead",
    nonce: "0x0",
    value: "0x1",
    gas: "0x5208",
    maxFeePerGas: "0x6fc23ac00",
    maxPriorityFeePerGas: "0x77359400",
    input: "0x",
    type: "0x2",
    chainId: "0x1",
    accessList: [],
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
    v: "0x0",
    yParity: "0x0",
    r: "0x" + "1".repeat(64),
    s: "0x" + "2".repeat(64),
  };
}

/** Provider A: 504 on every send; provider B: `bAnswer`. */
function scenario(bAnswer: (req: RpcReq) => Response, lookup: (hash: Hex, req: RpcReq) => Response): Handler {
  return (req, url) => {
    if (req.method === "eth_sendRawTransaction") {
      if (url === URL_A) return http504();
      return bAnswer(req);
    }
    if (req.method === "eth_getTransactionByHash") return lookup(req.params?.[0] as Hex, req);
    return ok(req.id, null);
  };
}

const savedProbe = { ...ETH_BROADCAST_PROBE };
beforeEach(() => {
  records = [];
  ETH_BROADCAST_PROBE.intervalMs = 0;
  useUI.setState({ ethRpcOverride: undefined } as never);
});
afterEach(() => {
  Object.assign(ETH_BROADCAST_PROBE, savedProbe);
  vi.unstubAllGlobals();
});

const sends = () => records.filter((r) => r.method === "eth_sendRawTransaction").map((r) => r.url);
const lookups = () => records.filter((r) => r.method === "eth_getTransactionByHash");

describe("FX1 — ETH broadcast never reports a possibly delivered tx as failed", () => {
  it("(a) 504, 504, then 'already known' and the network has the tx: success with the local hash", async () => {
    const raw = await signedRaw();
    const local = keccak256(raw);
    installFetch(scenario(
      (req) => rpcErr(req.id, -32000, "already known"),
      (hash, req) => ok(req.id, hash === local ? rpcTx(local) : null),
    ));
    await expect(broadcastRaw("mainnet", raw)).resolves.toBe(local);
    expect(sends()).toEqual([URL_A, URL_A, URL_B]);
    expect(lookups().length).toBeGreaterThanOrEqual(1);
  });

  it("(b) same, but the lookup finds nothing: EthBroadcastStatusUnknownError carrying the hash", async () => {
    const raw = await signedRaw();
    const local = keccak256(raw);
    installFetch(scenario(
      (req) => rpcErr(req.id, -32000, "already known"),
      (_h, req) => ok(req.id, null),
    ));
    const err = await broadcastRaw("mainnet", raw).catch((e) => e);
    expect(err).toBeInstanceOf(EthBroadcastStatusUnknownError);
    expect((err as EthBroadcastStatusUnknownError).hash).toBe(local);
    expect((err as Error).message).toContain(local);
    // Bounded probing: exactly ETH_BROADCAST_PROBE.attempts lookups.
    expect(lookups().length).toBe(ETH_BROADCAST_PROBE.attempts);
  });

  it("(b2) a pure transport failure (504 everywhere) and lookups that themselves fail: still status-unknown", async () => {
    const raw = await signedRaw();
    installFetch((req) => {
      if (req.method === "eth_sendRawTransaction") return http504();
      return new Response("bad", { status: 400 });
    });
    const err = await broadcastRaw("mainnet", raw).catch((e) => e);
    expect(err).toBeInstanceOf(EthBroadcastStatusUnknownError);
  });

  // R1 repair: (c) used to let provider A answer 504 twice before B's
  // verdict and expected the plain error — but A may have delivered the tx,
  // and viem's fallback only throws B's (last) error. A definitive verdict
  // now requires every attempt to have been rejected definitively, so (c)
  // has both providers reject; the A-504 case moved to (c2) as unknown.
  it("(c) a definitive rejection ('insufficient funds') from every attempt rethrows the original error", async () => {
    const raw = await signedRaw();
    installFetch((req) => {
      if (req.method === "eth_sendRawTransaction") return rpcErr(req.id, -32000, "insufficient funds for gas * price + value");
      return ok(req.id, null);
    });
    const err = await broadcastRaw("mainnet", raw).catch((e) => e);
    expect(err).not.toBeInstanceOf(EthBroadcastStatusUnknownError);
    expect(String((err as Error).message)).toMatch(/insufficient funds/);
    expect(sends()).toEqual([URL_A, URL_B]);
  });

  it.each([
    "transaction underpriced",
    "nonce too high",
    "insufficient funds for gas * price + value",
    "exceeds the configured cap",
  ])("(c2) A 504 twice (may have delivered), B '%s', nobody finds the hash: status unknown, not a plain failure", async (msg) => {
    const raw = await signedRaw();
    const local = keccak256(raw);
    installFetch((req, url) => {
      if (url === URL_A) return http504(); // A stays down for the probes too
      if (req.method === "eth_sendRawTransaction") return rpcErr(req.id, -32000, msg);
      return ok(req.id, null); // B does not have the tx
    });
    const err = await broadcastRaw("mainnet", raw).catch((e) => e);
    expect(sends()).toEqual([URL_A, URL_A, URL_B]);
    expect(err).toBeInstanceOf(EthBroadcastStatusUnknownError);
    expect((err as EthBroadcastStatusUnknownError).hash).toBe(local);
    expect(String(((err as EthBroadcastStatusUnknownError).cause as Error).message)).toContain(msg.split(" ")[0]);
  });

  it("(c3) A answers a non-definitive JSON-RPC error (-32603 internal), B a verdict: status unknown", async () => {
    const raw = await signedRaw();
    installFetch((req, url) => {
      if (req.method === "eth_sendRawTransaction") {
        return url === URL_A ? rpcErr(req.id, -32603, "internal error") : rpcErr(req.id, -32000, "insufficient funds for gas * price + value");
      }
      return ok(req.id, null);
    });
    const err = await broadcastRaw("mainnet", raw).catch((e) => e);
    expect(err).toBeInstanceOf(EthBroadcastStatusUnknownError);
  });

  it("(d) the local hash is keccak256(signed raw) and equals what a successful send returns", async () => {
    const raw = await signedRaw(7);
    let nodeHash: Hex | null = null;
    installFetch((req) => {
      if (req.method === "eth_sendRawTransaction") {
        nodeHash = keccak256(req.params?.[0] as Hex);
        return ok(req.id, nodeHash);
      }
      return ok(req.id, null);
    });
    const got = await broadcastRaw("mainnet", raw);
    expect(got).toBe(keccak256(raw));
    expect(got).toBe(nodeHash);
    expect(lookups()).toEqual([]);
  });

  it.each([
    ["found by hash → success", true],
    ["not found → status unknown", false],
  ] as const)("end to end through sendNative (504, 504, 'already known'): %s", async (_label, found) => {
    const raw = await signedRaw();
    const local = keccak256(raw);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw } as never);
    installFetch((req, url) => {
      if (req.method === "eth_getTransactionCount") return ok(req.id, "0x0");
      if (req.method === "eth_sendRawTransaction") return url === URL_A ? http504() : rpcErr(req.id, -32000, "already known");
      if (req.method === "eth_getTransactionByHash") return ok(req.id, found ? rpcTx(local) : null);
      return ok(req.id, null);
    });
    const p = ethTx.sendNative({
      network: "mainnet",
      from: account.address,
      to: "0x000000000000000000000000000000000000dEaD",
      value: 1n,
      tier: "normal",
      frozen: { gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, composedAt: Date.now() },
    });
    if (found) {
      await expect(p).resolves.toMatchObject({ txHash: local });
    } else {
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(EthBroadcastStatusUnknownError);
      expect((err as EthBroadcastStatusUnknownError).hash).toBe(local);
    }
    vi.restoreAllMocks();
  });

  it("classification: known-tx messages and transport errors are ambiguous; verdicts are definitive", () => {
    for (const m of ["already known", "known transaction: 0xabc", "nonce too low", "replacement transaction underpriced", "already imported"]) {
      expect(isDefinitiveEthRejection(new Error(m))).toBe(false);
    }
    for (const m of [
      "insufficient funds for gas * price + value",
      "intrinsic gas too low",
      "invalid sender",
      "max fee per gas less than block base fee",
      "fee cap less than block base fee",
    ]) {
      expect(isDefinitiveEthRejection(new Error(m))).toBe(true);
    }
    expect(isDefinitiveEthRejection(new Error("fetch failed"))).toBe(false);
  });

  it("every ETH send path broadcasts through broadcastRaw", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/services/eth-tx.ts"), "utf8");
    expect(src.match(/await broadcastRaw\(/g)?.length).toBe(3);
    expect(src).not.toMatch(/sendRawTransaction\(\{[^}]*\}\);\s*\n\}/);
  });
});

// ─── UI: the status-unknown screen and the resend block ─────────────────

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ME = "0x1111111111111111111111111111111111111111" as const;
const AMOUNT = 100n * 100_000_000n;
const cfg = bridgeConfig("mainnet");
const burnQuote: bridgeV1.BurnQuote = {
  amount: AMOUNT, feeBps: 0, fee: 0n, net: AMOUNT, withinDailyCap: true, paused: false,
  addressValid: true, bridgeController: cfg.bridgeController, wprl: cfg.wprl,
};

function unwrapView() {
  const v = {
    err: null as string | null,
    notice: null as string | null,
    unknown: null as EthUnknownState | null,
    started: 0,
    setBusy: () => {},
    setErr: (m: string | null) => void (v.err = m),
    setNotice: (m: string | null) => void (v.notice = m),
    setGas: () => {},
    setNeedsApprove: () => {},
    setQuote: () => {},
    onStarted: async () => void v.started++,
    setEthUnknown: (st: EthUnknownState) => void (v.unknown = st),
  };
  return v satisfies UnwrapView;
}

describe("FX1 UI — status unknown shows the hash + Etherscan and blocks an immediate resend", () => {
  afterEach(() => vi.restoreAllMocks());

  it("the notice names the hash, links Etherscan, warns about paying twice and offers the acknowledgement", () => {
    const html = renderToStaticMarkup(
      createElement(EthBroadcastUnknown, {
        network: "mainnet",
        state: { hash: HASH, what: "ETH transfer", acknowledged: false },
        onAcknowledge: () => {},
      }),
    );
    expect(html).toContain(HASH);
    expect(html).toContain(`href="${ethTxExplorerUrl("mainnet", HASH)}"`);
    expect(html).toMatch(/pay twice/);
    expect(html).toMatch(/Check the transaction first/i);
    expect(html).toMatch(/I checked; it was not sent/);
    expect(html).toMatch(/type="checkbox"/);
  });

  it("send is blocked until acknowledged", () => {
    expect(ethUnknownBlocksSend(null)).toBe(false);
    expect(ethUnknownBlocksSend({ hash: HASH, what: "x", acknowledged: false })).toBe(true);
    expect(ethUnknownBlocksSend({ hash: HASH, what: "x", acknowledged: true })).toBe(false);
  });

  it.each(["approval", "burn"] as const)("bridge unwrap: a status-unknown %s is reported with its hash, not as a failure", async (step) => {
    const allowance = step === "approval" ? 0n : AMOUNT;
    vi.spyOn(bridgeV1, "fetchBurnQuote").mockResolvedValue(burnQuote);
    vi.spyOn(ethTx, "readWprlAllowance").mockImplementation(async () => allowance);
    vi.spyOn(ethTx, "readWprlBalanceOf").mockResolvedValue(AMOUNT);
    const approve = vi.spyOn(ethTx, "approveWprlForBridge").mockRejectedValue(new EthBroadcastStatusUnknownError(HASH, new Error("504")));
    const burn = vi.spyOn(ethTx, "requestBurn").mockRejectedValue(new EthBroadcastStatusUnknownError(HASH, new Error("504")));
    const v = unwrapView();
    await createUnwrapFlow()(
      { network: "mainnet", ethAddress: ME, pearlAddress: "prl1pme", amount: AMOUNT, quote: burnQuote,
        gas: step === "approval" ? { maxFeePerGas: 9n, approveWei: 450_000n, burnWei: null } : { maxFeePerGas: 7n, approveWei: null, burnWei: 700_000n } },
      v,
    );
    expect(v.unknown).toEqual({ hash: HASH, what: step, acknowledged: false });
    expect(v.err).toContain(HASH);
    expect(v.err).toContain(ethTxExplorerUrl("mainnet", HASH));
    expect(v.err).toMatch(/pay twice/);
    expect(v.err).not.toMatch(/E_ETH_BROADCAST_STATUS_UNKNOWN/);
    expect(v.started).toBe(0);
    expect((step === "approval" ? approve : burn)).toHaveBeenCalledTimes(1);
  });

  it("Send ETH, Send WPRL and Unwrap disable their send button while an unknown broadcast is unacknowledged", () => {
    const root = path.join(__dirname, "../src/ui/pages");
    for (const f of ["SendETH.tsx", "SendWPRL.tsx", "Bridge.tsx"]) {
      const page = fs.readFileSync(path.join(root, f), "utf8");
      expect(page, f).toMatch(/EthBroadcastStatusUnknownError|setEthUnknown/);
      expect(page, f).toMatch(/disabled=\{[^}]*ethUnknownBlocksSend\((unknown|ethUnknown)\)\}/);
      expect(page, f).toMatch(/if \(ethUnknownBlocksSend\((unknown|ethUnknown)\)\) return;/);
      expect(page, f).toMatch(/<EthBroadcastUnknown/);
    }
  });
});
