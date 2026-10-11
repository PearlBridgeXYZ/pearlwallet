// R2 FY6 — broadcastRaw's post-error lookups by hash are bounded: each uses
// a single-attempt client (http retryCount 0, fallback retryCount 0) with a
// short per-request timeout, and the whole probe has an overall deadline, so
// the status-unknown message appears promptly. Before: every lookup used the
// normal client (10 s timeout, 2 tries per URL, the fallback walk retried
// once: up to 8 fetches and minutes per lookup on a hung provider). The send
// itself keeps the normal client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { broadcastRaw, EthBroadcastStatusUnknownError, ETH_BROADCAST_PROBE } from "../src/services/eth-tx";
import { ETH_RPC_DEFAULTS } from "../src/chains/ethereum/network";
import { useUI } from "../src/state/ui-store";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC);
const URLS = ETH_RPC_DEFAULTS.mainnet;

interface Rec { method: string; url: string }
let records: Rec[] = [];

function installFetch(handler: (method: string, url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const req = Array.isArray(body) ? body[0] : body;
      records.push({ method: req.method, url });
      return handler(req.method, url, init);
    }),
  );
}

const signed = () =>
  account.signTransaction({
    chainId: 1, type: "eip1559", nonce: 0, to: "0x000000000000000000000000000000000000dEaD", value: 1n,
    gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
  }) as Promise<Hex>;

const sends = () => records.filter((r) => r.method === "eth_sendRawTransaction");
const lookups = () => records.filter((r) => r.method === "eth_getTransactionByHash");

const saved = { ...ETH_BROADCAST_PROBE };
beforeEach(() => {
  records = [];
  ETH_BROADCAST_PROBE.intervalMs = 0;
  useUI.setState({ ethRpcOverride: undefined } as never);
});
afterEach(() => {
  Object.assign(ETH_BROADCAST_PROBE, saved);
  vi.unstubAllGlobals();
});

describe("FY6 bounded status probes", () => {
  it("defaults: 5 s per lookup request, 25 s overall", () => {
    expect(saved.timeoutMs).toBe(5_000);
    expect(saved.deadlineMs).toBe(25_000);
  });

  it("each lookup is one request per URL (no http retry, no fallback re-walk); the send path is unchanged", async () => {
    installFetch(async () => new Response("unavailable", { status: 503 }));
    const err = await broadcastRaw("mainnet", await signed()).catch((e) => e);
    expect(err).toBeInstanceOf(EthBroadcastStatusUnknownError);
    // Send: the normal client — 2 tries per URL, no outer retry.
    expect(sends().map((r) => r.url)).toEqual([URLS[0], URLS[0], URLS[1], URLS[1]]);
    // Lookups: attempts × one request per URL.
    expect(lookups().map((r) => r.url)).toEqual(
      Array.from({ length: ETH_BROADCAST_PROBE.attempts }, () => [...URLS]).flat(),
    );
  }, 20_000);

  it("hung lookups: status-unknown arrives within the probe deadline", async () => {
    ETH_BROADCAST_PROBE.timeoutMs = 100;
    ETH_BROADCAST_PROBE.deadlineMs = 400;
    installFetch((method, _url, init) => {
      if (method === "eth_sendRawTransaction") return Promise.resolve(new Response("bad gateway", { status: 504 }));
      // Never answers; only the client's own timeout ends it.
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    });
    const raw = await signed();
    const sendDone = Date.now();
    const err = await broadcastRaw("mainnet", raw).catch((e) => e);
    expect(err).toBeInstanceOf(EthBroadcastStatusUnknownError);
    // The sends fail fast (504s) — what remains is the probe, bounded by
    // its deadline (plus scheduling slack), not by 10 s timeouts × retries.
    expect(Date.now() - sendDone).toBeLessThan(2_500);
  }, 8_000);
});
