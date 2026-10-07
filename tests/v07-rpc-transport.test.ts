// v0.7 — shared Pearl RPC transport: token-bucket limiter, exponential
// backoff with jitter + Retry-After, page-level resume, per-request
// timeouts, broadcast outcome rules, and activity ordering / pacing.
//
// Most tests here run with PRODUCTION tuning and fake timers so the real
// delays (3 req/s, burst 5, 0.5→8 s backoff, 12 s timeout) are asserted.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TokenBucket,
  mapWithConcurrency,
  sleep,
} from "../src/services/rpc-limiter";
import {
  callPearlRpc,
  fetchPrlUtxos,
  broadcastPearlTx,
  BroadcastStatusUnknownError,
  PearlRpcTimeoutError,
  isAlreadyKnownBroadcastError,
  parseRetryAfterMs,
  rawTxId,
  DEFAULT_PEARL_RPC_TUNING,
  _setPearlRpcTuningForTests,
  _resetPearlRpcHealthForTests,
} from "../src/services/pearl-rpc";
import { scanPrlPool } from "../src/services/balances";
import { fetchActivity } from "../src/services/activity";
import * as ethRpc from "../src/chains/ethereum/rpc";
import { useUI } from "../src/state/ui-store";

const ADDR = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";
const SCRIPT = "5120" + "00".repeat(32);

// Bitcoin genesis coinbase — a well-known raw tx with a well-known txid.
const GENESIS_RAW =
  "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000";
const GENESIS_TXID = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result, error: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function rpcErr(code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null, error: { code, message } }), {
    status: 200,
  });
}
function bodyOf(init?: RequestInit): { method: string; params: unknown[] } {
  return JSON.parse(String(init?.body ?? "{}"));
}
/** A fetch that never answers until its signal aborts (then rejects like the platform). */
function hangingFetch(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });
}
function creditTx(i: number, value = 1) {
  return {
    txid: i.toString(16).padStart(64, "0"),
    vin: [],
    vout: [{ value, n: 0, scriptPubKey: { address: ADDR, hex: SCRIPT } }],
  };
}

function useProductionTuning() {
  _setPearlRpcTuningForTests(undefined);
  _resetPearlRpcHealthForTests();
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Token bucket ────────────────────────────────────────────────────────

describe("TokenBucket", () => {
  beforeEach(() => vi.useFakeTimers());

  it("allows `burst` immediately, then paces at ratePerSec", async () => {
    const b = new TokenBucket({ ratePerSec: 3, burst: 5 });
    const granted: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 11; i++) void b.take().then(() => granted.push(Date.now() - t0));
    await vi.advanceTimersByTimeAsync(0);
    expect(granted.length).toBe(5);
    await vi.advanceTimersByTimeAsync(1_010); // ms-rounded refill ticks
    expect(granted.length).toBe(8); // +3 in the first second
    await vi.advanceTimersByTimeAsync(1_000);
    expect(granted.length).toBe(11);
    // Never more than burst + rate·t in any prefix.
    granted.forEach((t, i) => expect(i + 1).toBeLessThanOrEqual(5 + Math.floor((t * 3) / 1000) + 1));
  });

  it("serves the high lane before the low lane when tokens are scarce", async () => {
    const b = new TokenBucket({ ratePerSec: 2, burst: 1 });
    await b.take(); // drain
    const order: string[] = [];
    void b.take("low").then(() => order.push("low1"));
    void b.take("low").then(() => order.push("low2"));
    void b.take("high").then(() => order.push("high1"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(order).toEqual(["high1", "low1", "low2"]);
  });

  it("an aborted waiter is removed and rejects", async () => {
    const b = new TokenBucket({ ratePerSec: 1, burst: 1 });
    await b.take();
    const ctrl = new AbortController();
    const p = b.take("high", ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeDefined();
    expect(b.pending).toBe(0);
  });
});

describe("helpers", () => {
  it("mapWithConcurrency keeps order and caps in-flight work", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });

  it("sleep rejects on abort", async () => {
    const c = new AbortController();
    const p = sleep(10_000, c.signal);
    c.abort();
    await expect(p).rejects.toBeDefined();
  });

  it("parseRetryAfterMs handles seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("3")).toBe(3_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("garbage")).toBeNull();
    const now = Date.parse("2026-10-07T00:00:00Z");
    expect(parseRetryAfterMs("Wed, 07 Oct 2026 00:00:02 GMT", now)).toBe(2_000);
  });

  it("production tuning stays under the measured origin limit (≈1 r/s, burst ≈10)", () => {
    expect(DEFAULT_PEARL_RPC_TUNING.ratePerSec).toBeLessThan(1);
    expect(DEFAULT_PEARL_RPC_TUNING.burst).toBeLessThan(10);
    expect(DEFAULT_PEARL_RPC_TUNING.retryBudgetMs).toBeLessThanOrEqual(20_000);
    expect(DEFAULT_PEARL_RPC_TUNING.scanConcurrency).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_PEARL_RPC_TUNING.scanConcurrency).toBeLessThanOrEqual(3);
  });
});

// ─── Backoff ─────────────────────────────────────────────────────────────

describe("callPearlRpc backoff (production tuning, fake timers)", () => {
  beforeEach(() => {
    useProductionTuning();
    vi.useFakeTimers();
  });

  it("retries 503 with exponential delays ≈0.5,1,2,4 s (jitter ≤ nominal)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999); // jitter factor ≈ 1.0
    const at: number[] = [];
    const t0 = Date.now();
    vi.stubGlobal("fetch", vi.fn(async () => {
      at.push(Date.now() - t0);
      return at.length <= 4 ? new Response("", { status: 503 }) : ok(42);
    }));
    const p = callPearlRpc<number>("getblockcount", []);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe(42);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps).toEqual([500, 1_000, 2_000, 4_000]);
  });

  it("jitter keeps every delay within [50%, 100%] of nominal", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const at: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      at.push(Date.now());
      return at.length <= 2 ? new Response("", { status: 503 }) : ok(1);
    }));
    const p = callPearlRpc<number>("getblockcount", []);
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(at[1]! - at[0]!).toBe(250);
    expect(at[2]! - at[1]!).toBe(500);
  });

  it("honours Retry-After (capped at backoffMaxMs)", async () => {
    const at: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      at.push(Date.now());
      if (at.length === 1) return new Response("", { status: 429, headers: { "retry-after": "3" } });
      return ok(7);
    }));
    const p = callPearlRpc<number>("getblockcount", []);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe(7);
    expect(at[1]! - at[0]!).toBe(3_000);
  });

  it("gives up within the ~20 s budget and only then reports the failure", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      return new Response("", { status: 503 });
    }));
    const t0 = Date.now();
    let settledAt = 0;
    const p = callPearlRpc("getblockcount", []).catch((e: unknown) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await p;
    expect(String(err)).toMatch(/rpc http 503/);
    // 0.5+1+2+4+8 = 15.5 s fits the budget → 6 attempts total.
    expect(n).toBe(6);
    expect(settledAt - t0).toBeLessThanOrEqual(20_000);
  });

  it("time queued in the limiter does not eat the retry budget", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    // Saturate the bucket with 40 high-priority calls, then issue one
    // low-priority call whose first attempt 503s after a long queue wait.
    let lowHits = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { method } = bodyOf(init);
      if (method === "low") {
        lowHits++;
        return lowHits === 1 ? new Response("", { status: 503 }) : ok("done");
      }
      return ok(1);
    }));
    const highs = Array.from({ length: 40 }, (_, i) => callPearlRpc("high", [i]));
    const low = callPearlRpc<string>("low", [], { priority: "low" });
    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.all(highs);
    await expect(low).resolves.toBe("done");
    expect(lowHits).toBe(2);
  });

  it("every attempt (including retries) draws from the shared limiter", async () => {
    // 10 concurrent calls; first attempt of each 503s once. Count requests
    // per 1 s window: never above burst + rate.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const seen = new Map<string, number>();
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      times.push(Date.now());
      const id = JSON.stringify(bodyOf(init).params);
      const k = (seen.get(id) ?? 0) + 1;
      seen.set(id, k);
      return k === 1 ? new Response("", { status: 503 }) : ok(1);
    }));
    const ps = Array.from({ length: 10 }, (_, i) => callPearlRpc("getblockhash", [i]));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(ps);
    expect(times.length).toBe(20);
    const { burst, ratePerSec } = DEFAULT_PEARL_RPC_TUNING;
    const t0 = times[0]!;
    // Token-bucket invariant: by time t, at most burst + rate·t requests.
    times.forEach((t, i) => {
      expect(i + 1).toBeLessThanOrEqual(burst + Math.floor(((t - t0) * ratePerSec) / 1000) + 1);
    });
    // 20 requests after a burst of 8 need ≥ (20 − 8) / 0.9 s.
    expect(times[times.length - 1]! - t0).toBeGreaterThanOrEqual(((20 - burst) / ratePerSec) * 1000 - 1_100);
  });
});

// ─── Timeouts ────────────────────────────────────────────────────────────

describe("per-request timeout", () => {
  beforeEach(() => {
    useProductionTuning();
    vi.useFakeTimers();
  });

  it("aborts a hung request after 12 s and retries it", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      n++;
      if (n === 1) return hangingFetch(init);
      return ok(5);
    }));
    const p = callPearlRpc<number>("getblockcount", []);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe(5);
    expect(n).toBe(2);
  });

  it("persistent hang surfaces PearlRpcTimeoutError within the ~20 s budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => hangingFetch(init)));
    const t0 = Date.now();
    let settledAt = 0;
    const p = callPearlRpc("getblockcount", []).catch((e: unknown) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await p).toBeInstanceOf(PearlRpcTimeoutError);
    expect(settledAt - t0).toBeLessThanOrEqual(20_000);
  });

  it("every Pearl fetch carries an AbortSignal", async () => {
    vi.useRealTimers();
    _setPearlRpcTuningForTests({ ratePerSec: Infinity, burst: 100 });
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal("fetch", f);
    await fetchPrlUtxos(ADDR);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─── Resume ──────────────────────────────────────────────────────────────

describe("UTXO walk resumes the SAME page after 503s", () => {
  it("503 on page 2 (twice) then success → walk continues from page 2, totals correct", async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => creditTx(i + 1));
    const page1 = Array.from({ length: 100 }, (_, i) => creditTx(i + 101));
    const page2 = Array.from({ length: 40 }, (_, i) => creditTx(i + 201));
    const skips: number[] = [];
    let page2Hits = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { params } = bodyOf(init);
      const skip = params[2] as number;
      skips.push(skip);
      if (skip === 0) return ok(page0);
      if (skip === 100) return ok(page1);
      if (skip === 200) {
        page2Hits++;
        if (page2Hits <= 2) return new Response("", { status: 503 });
        return ok(page2);
      }
      return ok([]);
    }));
    const r = await fetchPrlUtxos(ADDR);
    expect(skips).toEqual([0, 100, 200, 200, 200]);
    expect(r.utxos.length).toBe(240);
    expect(r.degraded).toBe(false);
    const total = r.utxos.reduce((a, u) => a + u.valueGrains, 0n);
    expect(total).toBe(240n * 100_000_000n);
  });

  it("a pool scan keeps the address (status ok) when one of its pages 503s", async () => {
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { params } = bodyOf(init);
      if (params[0] === ADDR && first) {
        first = false;
        return new Response("", { status: 503 });
      }
      if (params[0] === ADDR && params[2] === 0) return ok([creditTx(1, 2.5)]);
      return ok([]);
    }));
    const scan = await scanPrlPool([ADDR, "prl1pOTHER"]);
    expect(scan.source).toBe("live");
    expect(scan.failures).toBe(0);
    expect(scan.grains).toBe(250_000_000n);
  });
});

// ─── Broadcast ───────────────────────────────────────────────────────────

describe("broadcastPearlTx outcome rules", () => {
  it("rawTxId computes the txid locally", () => {
    expect(rawTxId(GENESIS_RAW)).toBe(GENESIS_TXID);
    expect(rawTxId("zz")).toBeNull();
  });

  it("success returns the node's txid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(GENESIS_TXID)));
    await expect(broadcastPearlTx(GENESIS_RAW)).resolves.toBe(GENESIS_TXID);
  });

  it("'already have transaction' is success (local txid)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      rpcErr(-25, `TX rejected: already have transaction ${GENESIS_TXID}`)));
    await expect(broadcastPearlTx(GENESIS_RAW)).resolves.toBe(GENESIS_TXID);
  });

  it("first attempt times out, retry says 'already have transaction' → success", async () => {
    useProductionTuning();
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      n++;
      if (n === 1) return hangingFetch(init);
      return rpcErr(-25, "TX rejected: already have transaction");
    }));
    const p = broadcastPearlTx(GENESIS_RAW);
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(p).resolves.toBe(GENESIS_TXID);
  });

  it("a client timeout is NEVER reported as a plain failure", async () => {
    useProductionTuning();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => hangingFetch(init)));
    const p = broadcastPearlTx(GENESIS_RAW).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300_000);
    const err = await p;
    expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
    expect((err as BroadcastStatusUnknownError).txid).toBe(GENESIS_TXID);
    expect((err as Error).message).toMatch(/status unknown/);
    expect((err as Error).message).toContain(GENESIS_TXID);
  });

  it("broadcast uses the longer broadcast timeout, not the 12 s read timeout", async () => {
    useProductionTuning();
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      n++;
      if (n === 1) {
        // Answers after 16 s — would be cut off by the 12 s read timeout.
        return new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(ok(GENESIS_TXID)), 16_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return ok(GENESIS_TXID);
    }));
    const p = broadcastPearlTx(GENESIS_RAW);
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(p).resolves.toBe(GENESIS_TXID);
    expect(n).toBe(1);
  });

  it("dropped connections on every attempt → status unknown (may have been delivered)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network connection lost");
    }));
    await expect(broadcastPearlTx(GENESIS_RAW)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
  });

  it("node rejection on FIRST contact is a real failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      rpcErr(-26, "TX rejected: transaction has insufficient priority")));
    const err = await broadcastPearlTx(GENESIS_RAW).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(String(err)).toMatch(/insufficient priority/);
  });

  it("node rejection AFTER an ambiguous attempt → status unknown, not failure", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) return new Response("", { status: 502 });
      return rpcErr(-25, "TX rejected: orphan transaction references outputs of unknown or fully-spent transaction");
    }));
    await expect(broadcastPearlTx(GENESIS_RAW)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
  });

  it("only edge 429s (never forwarded) → plain failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    const err = await broadcastPearlTx(GENESIS_RAW).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(String(err)).toMatch(/rpc http 429/);
  });

  it("already-known matcher", () => {
    expect(isAlreadyKnownBroadcastError(new Error("rpc -25: TX rejected: already have transaction abc"))).toBe(true);
    expect(isAlreadyKnownBroadcastError(new Error("rpc -27: transaction already in block chain"))).toBe(true);
    expect(isAlreadyKnownBroadcastError(new Error("rpc -26: txn-already-in-mempool"))).toBe(true);
    expect(isAlreadyKnownBroadcastError(new Error("rpc -26: bad-txns-inputs-missingorspent"))).toBe(false);
    expect(isAlreadyKnownBroadcastError(new Error("rpc http 503"))).toBe(false);
  });
});

// ─── Activity ────────────────────────────────────────────────────────────

const POOL = ["prl1pAAA", "prl1pBBB"];
const ETH_ADDR = "0x0000000000000000000000000000000000000001" as const;

function stubEth() {
  vi.spyOn(ethRpc, "ethClient").mockReturnValue({
    getBlockNumber: async () => 18_000_000n,
    getLogs: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe("activity — newest first via the shared client", () => {
  it("requests verbose=1, vinextra=1, reverse=true (btcd param positions)", async () => {
    const seen: unknown[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { method, params } = bodyOf(init);
      if (method === "searchrawtransactions") seen.push(params);
      return ok([]);
    }));
    stubEth();
    await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(seen.length).toBe(2);
    for (const p of seen) {
      expect(p[1]).toBe(1);      // verbose
      expect(p[2]).toBe(0);      // skip
      expect(p[4]).toBe(1);      // vinextra
      expect(p[5]).toBe(true);   // reverse → newest first
    }
  });

  it("items come back newest-first", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { params } = bodyOf(init);
      if (params[0] === POOL[0]) {
        return ok([
          { txid: "N3", vin: [], vout: [{ value: 3, n: 0, scriptPubKey: { address: POOL[0] } }], time: 300 },
          { txid: "N1", vin: [], vout: [{ value: 1, n: 0, scriptPubKey: { address: POOL[0] } }], time: 100 },
        ]);
      }
      return ok([{ txid: "N2", vin: [], vout: [{ value: 2, n: 0, scriptPubKey: { address: POOL[1] } }], time: 200 }]);
    }));
    stubEth();
    const r = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(r.items.map((i) => i.txid)).toEqual(["N3", "N2", "N1"]);
  });

  it("classifies a spend as 'out' from prevOut even when the funding tx is outside the window", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { params } = bodyOf(init);
      if (params[0] === POOL[0]) {
        return ok([{
          txid: "SPEND",
          vin: [{ txid: "OLDFUND", vout: 0, prevOut: { addresses: [POOL[0]], value: 5 } }],
          vout: [
            { value: 3, n: 0, scriptPubKey: { address: "prl1pPEER" } },
            { value: 1.9, n: 1, scriptPubKey: { address: POOL[0] } },
          ],
          time: 500,
        }]);
      }
      return ok([]);
    }));
    stubEth();
    const r = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.direction).toBe("out");
    expect(r.items[0]!.amount).toBe(300_000_000n);
  });

  it("activity reuses complete histories from a recent balance walk (no extra requests)", async () => {
    let actRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { params } = bodyOf(init);
      if (params.length === 6) actRequests++;
      if (params[0] === POOL[0]) {
        return ok([{ txid: "H1", vin: [], vout: [{ value: 1, n: 0, scriptPubKey: { address: POOL[0], hex: SCRIPT } }], time: 10 }]);
      }
      return new Response(JSON.stringify({ result: null, error: { code: -5, message: "No information available about address" } }));
    }));
    stubEth();
    await scanPrlPool(POOL);
    const r = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(actRequests).toBe(0);
    expect(r.pearlSource).toBe("live");
    expect(r.items.map((i) => i.txid)).toEqual(["H1"]);
  });

  it("activity requests yield to a concurrent balance scan (low lane)", async () => {
    useProductionTuning();
    vi.useFakeTimers();
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const { params } = bodyOf(init);
      // Balance walk sends 4 params; activity sends 6.
      log.push(params.length === 6 ? "act" : "bal");
      return ok([]);
    }));
    stubEth();
    const pool = Array.from({ length: 12 }, (_, i) => `prl1pADDR${i}`);
    const act = fetchActivity(pool, ETH_ADDR, "mainnet", 10);
    const bal = scanPrlPool(pool);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([act, bal]);
    expect(log.filter((x) => x === "bal").length).toBe(12);
    // Addresses whose complete history the balance walk already saw are
    // not fetched again by activity (shared scan).
    expect(log.filter((x) => x === "act").length).toBeLessThan(12);
    // Once the burst is spent, no activity request is served while a
    // balance request is waiting: the last balance request comes before
    // the bulk of the activity requests.
    const lastBal = log.lastIndexOf("bal");
    const actBeforeLastBal = log.slice(0, lastBal).filter((x) => x === "act").length;
    expect(actBeforeLastBal).toBeLessThanOrEqual(DEFAULT_PEARL_RPC_TUNING.burst);
  });
});
