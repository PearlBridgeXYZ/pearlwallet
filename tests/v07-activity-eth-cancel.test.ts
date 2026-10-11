// v0.7 — residual D1 (LOW): once an activity scan is cancelled (react-query
// signal on lock / wipe / wallet switch, or the balance-memory epoch bump)
// viem's retry + fallback stack must issue ZERO further Ethereum JSON-RPC
// requests. Before the fix, a 503 on the held eth_getLogs let viem keep
// retrying / failing over with the former wallet's padded address in the
// topic filter.
//
// Everything here goes through the REAL viem transport (fallback(http()))
// with only globalThis.fetch stubbed, so the assertions are about what
// leaves the browser, not about our own bookkeeping.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fetchActivity } from "../src/services/activity";
import { ethClient, ETH_RPC_TIMEOUT_MS } from "../src/chains/ethereum/rpc";
import { ETH_RPC_DEFAULTS } from "../src/chains/ethereum/network";
import { clearBalanceMemory } from "../src/state/balance-memory";
import { useUI } from "../src/state/ui-store";

const ETH_ADDR = "0x1234567890AbcdEF1234567890aBcdef12345678" as const;
const PADDED = "0x" + "0".repeat(24) + ETH_ADDR.slice(2).toLowerCase();
const [URL_A, URL_B] = ETH_RPC_DEFAULTS.mainnet;
const HEAD = "0x1000000";

interface Rec {
  method: string;
  url: string;
  topics?: unknown;
  afterAbort: boolean;
}
interface Held {
  method: string;
  url: string;
  init: RequestInit | undefined;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}
interface RpcReq {
  id?: number;
  method: string;
  params?: unknown[];
}

let records: Rec[] = [];
let held: Held[] = [];
let aborted = false;

function ok(id: number | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function http503(): Response {
  return new Response("Service Unavailable", { status: 503 });
}
function rpcErr(id: number | undefined, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function parseBody(init?: RequestInit): RpcReq[] {
  const body = JSON.parse(String(init?.body ?? "{}"));
  return Array.isArray(body) ? body : [body];
}
function record(req: RpcReq, url: string): void {
  const p0 = req.params?.[0] as { topics?: unknown } | undefined;
  records.push({
    method: req.method,
    url,
    topics: p0 && typeof p0 === "object" ? p0.topics : undefined,
    afterAbort: aborted,
  });
}
const ethCalls = (pred: (r: Rec) => boolean) => records.filter(pred);
const postAbort = () =>
  ethCalls((r) => r.afterAbort && /^eth_(getLogs|getBlockByNumber|blockNumber)$/.test(r.method));

/** A fetch that only ever rejects via its own init.signal (platform shape). */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });
}

type Handler = (req: RpcReq, url: string, init: RequestInit | undefined) => Promise<Response> | Response;

/** Installs a fetch stub that routes single-object or batched JSON-RPC bodies. */
function installFetch(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const reqs = parseBody(init);
    // viem sends one object per request when batch is off; handle arrays
    // defensively by answering the first entry (the tests never batch).
    const req = reqs[0];
    record(req, url);
    return handler(req, url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Holds eth_getLogs in flight until the test releases them; answers
 *  eth_blockNumber immediately. Anything arriving AFTER the abort flag is
 *  set is answered 503 at once so a (buggy) retry cascade runs to the end
 *  and gets counted instead of hanging the test. */
function holdGetLogs(): Handler {
  return (req, url, init) => {
    if (req.method === "eth_blockNumber") return ok(req.id, HEAD);
    if (req.method === "eth_getLogs") {
      if (aborted) return http503();
      return new Promise<Response>((resolve, reject) => {
        held.push({ method: req.method, url, init, resolve, reject });
      });
    }
    if (req.method === "eth_getBlockByNumber") return ok(req.id, minimalBlock(String(req.params?.[0])));
    return ok(req.id, null);
  };
}

function minimalBlock(number: string) {
  return {
    number,
    timestamp: "0x1",
    hash: "0x" + "1".repeat(64),
    parentHash: "0x" + "0".repeat(64),
    nonce: "0x" + "0".repeat(16),
    sha3Uncles: "0x" + "0".repeat(64),
    logsBloom: "0x" + "0".repeat(512),
    transactionsRoot: "0x" + "0".repeat(64),
    stateRoot: "0x" + "0".repeat(64),
    receiptsRoot: "0x" + "0".repeat(64),
    miner: "0x" + "0".repeat(40),
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    baseFeePerGas: "0x0",
    transactions: [],
    uncles: [],
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function untilHeld(n: number): Promise<void> {
  for (let i = 0; i < 200 && held.length < n; i++) await tick();
  expect(held.length).toBe(n);
}
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  records = [];
  held = [];
  aborted = false;
  useUI.getState().setEthRpcOverride("");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("activity scan cancellation stops viem's retry/fallback stack (D1)", () => {
  it("A1: signal abort mid-cascade, 503 on release -> zero post-abort Ethereum requests", async () => {
    const fetchMock = installFetch(holdGetLogs());
    const ctrl = new AbortController();
    const p = fetchActivity([], ETH_ADDR, "mainnet", 10, { signal: ctrl.signal });
    await untilHeld(2);

    // Privacy angle: the in-flight filters carry the former wallet's address.
    const pre = ethCalls((r) => r.method === "eth_getLogs" && !r.afterAbort);
    expect(pre.length).toBe(2);
    expect(pre.some((r) => JSON.stringify(r.topics).includes(PADDED))).toBe(true);

    ctrl.abort();
    clearBalanceMemory();
    aborted = true;
    const before = fetchMock.mock.calls.length;
    const t0 = performance.now();
    for (const h of held.splice(0)) h.resolve(http503());

    const err = await p.then(
      () => { throw new Error("expected rejection"); },
      (e: unknown) => e,
    );
    // No retry sleeps after cancellation: the 499 guard rejects at once.
    expect(performance.now() - t0).toBeLessThan(300);
    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).name).not.toBe("HttpRequestError");

    // Let any retry sleeps / fallback hops viem might still schedule run out.
    await realSleep(1300);
    const extra = postAbort();
    expect(fetchMock.mock.calls.length - before).toBe(0);
    expect(extra).toEqual([]);
  });

  it("A2: signal abort with a custom reason, JSON-RPC -32000 on release -> zero post-abort requests", async () => {
    const fetchMock = installFetch(holdGetLogs());
    const ctrl = new AbortController();
    const reason = new Error("wallet locked");
    const p = fetchActivity([], ETH_ADDR, "mainnet", 10, { signal: ctrl.signal });
    await untilHeld(2);

    ctrl.abort(reason);
    clearBalanceMemory();
    aborted = true;
    const before = fetchMock.mock.calls.length;
    const t0 = performance.now();
    for (const h of held.splice(0)) h.resolve(rpcErr(1, -32000, "query timeout"));

    await expect(p).rejects.toBe(reason);
    expect(performance.now() - t0).toBeLessThan(300);
    await realSleep(1300);
    expect(fetchMock.mock.calls.length - before).toBe(0);
    expect(postAbort()).toEqual([]);
  });

  it("B: epoch-only (no signal): clearBalanceMemory while getLogs are held -> zero post-clear requests", async () => {
    const fetchMock = installFetch(holdGetLogs());
    const p = fetchActivity([], ETH_ADDR, "mainnet", 10);
    await untilHeld(2);

    clearBalanceMemory();
    aborted = true;
    const before = fetchMock.mock.calls.length;
    const t0 = performance.now();
    for (const h of held.splice(0)) h.resolve(http503());

    await expect(p).rejects.toThrow(/E_SESSION_CLEARED/);
    expect(performance.now() - t0).toBeLessThan(300);
    await realSleep(1300);
    expect(fetchMock.mock.calls.length - before).toBe(0);
    expect(postAbort()).toEqual([]);
  });

  it("C: no abort: a 503 on the first getLogs attempts is still retried through the guard -> live", async () => {
    const seen = new Map<string, number>();
    installFetch((req, url) => {
      if (req.method === "eth_blockNumber") return ok(req.id, HEAD);
      if (req.method === "eth_getLogs") {
        const key = JSON.stringify((req.params?.[0] as { topics?: unknown }).topics);
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        return n === 1 ? http503() : ok(req.id, []);
      }
      return ok(req.id, null);
    });
    const ctrl = new AbortController();
    const result = await fetchActivity([], ETH_ADDR, "mainnet", 10, { signal: ctrl.signal });
    expect(result.wprlSource).toBe("live");
    expect(result.items).toEqual([]);
    const logs = ethCalls((r) => r.method === "eth_getLogs");
    // Two legs (from / to), each: 503 then success on the same URL.
    expect(logs.length).toBe(4);
    expect(logs.every((r) => r.url === URL_A)).toBe(true);
  });

  it("D: viem's per-request timeout still fires with the guard installed (ETH_RPC_TIMEOUT_MS, then fail over)", async () => {
    vi.useFakeTimers();
    const inits: RequestInit[] = [];
    installFetch((req, url, init) => {
      if (url === URL_A) {
        inits.push(init!);
        return hangUntilAborted(init);
      }
      return ok(req.id, HEAD);
    });
    const ctrl = new AbortController(); // never aborted
    const client = ethClient("mainnet", { signal: ctrl.signal });
    const p = client.getBlockNumber();
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(ETH_RPC_TIMEOUT_MS - 1);
    expect(inits.length).toBe(1);
    expect(inits[0].signal?.aborted).toBe(false);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(501);
    // viem's own timeout controller (not ours) abandoned the hung request
    // and the retry on the same URL has started.
    expect(inits[0].signal?.aborted).toBe(true);
    expect(inits.length).toBe(2);

    await vi.advanceTimersByTimeAsync(ETH_RPC_TIMEOUT_MS + 500);
    await vi.advanceTimersByTimeAsync(ETH_RPC_TIMEOUT_MS + 500);
    await expect(p).resolves.toBe(BigInt(HEAD));
    expect(ethCalls((r) => r.url === URL_B && r.method === "eth_blockNumber").length).toBe(1);
    expect(inits.every((i) => i.signal?.aborted)).toBe(true);
  });

  it("G: abort while eth_blockNumber is in flight -> abort reason, zero further requests", async () => {
    const heldHead: Array<(r: Response) => void> = [];
    const fetchMock = installFetch((req) => {
      if (req.method === "eth_blockNumber") {
        if (aborted) return http503();
        return new Promise<Response>((resolve) => heldHead.push(resolve));
      }
      return ok(req.id, []);
    });
    const ctrl = new AbortController();
    const p = fetchActivity([], ETH_ADDR, "mainnet", 10, { signal: ctrl.signal });
    for (let i = 0; i < 200 && heldHead.length < 1; i++) await tick();
    expect(heldHead.length).toBe(1);

    ctrl.abort();
    aborted = true;
    const before = fetchMock.mock.calls.length;
    heldHead.splice(0).forEach((r) => r(http503()));

    const err = await p.then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    await realSleep(900);
    expect(fetchMock.mock.calls.length - before).toBe(0);
    expect(postAbort()).toEqual([]);
  });

  it("H: abort during the narrow-window fallback scan -> abort reason, zero further requests", async () => {
    // Wide window (fromBlock = head - 100_000) fails for good; the narrow
    // retry (fromBlock = head - 5_000) is held and the scan cancelled there.
    const narrowFrom = "0x" + (0x1000000 - 5000).toString(16);
    const fetchMock = installFetch((req, url, init) => {
      if (req.method === "eth_blockNumber") return ok(req.id, HEAD);
      if (req.method === "eth_getLogs") {
        const from = (req.params?.[0] as { fromBlock?: string } | undefined)?.fromBlock;
        if (aborted) return http503();
        if (from !== narrowFrom) return rpcErr(req.id, -32000, "range too wide");
        return new Promise<Response>((resolve, reject) => {
          held.push({ method: req.method, url, init, resolve, reject });
        });
      }
      return ok(req.id, null);
    });
    const ctrl = new AbortController();
    const p = fetchActivity([], ETH_ADDR, "mainnet", 10, { signal: ctrl.signal });
    for (let i = 0; i < 2000 && held.length < 2; i++) await tick();
    expect(held.length).toBe(2);

    ctrl.abort();
    aborted = true;
    const before = fetchMock.mock.calls.length;
    for (const h of held.splice(0)) h.resolve(http503());

    const err = await p.then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    await realSleep(900);
    expect(fetchMock.mock.calls.length - before).toBe(0);
    expect(postAbort()).toEqual([]);
  });

  it("E: source pin: only activity.ts (signal) and eth-tx.ts broadcastRaw (observe) pass a second argument to ethClient()", () => {
    const root = path.resolve(__dirname, "../src");
    const files = fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
      .map((f) => path.join(root, f));
    expect(files.length).toBeGreaterThan(20);
    const withOpts: string[] = [];
    let totalCalls = 0;
    let rawOccurrences = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const re = /(?<![\w.$])ethClient\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (/function\s+ethClient\s*\($/.test(src.slice(Math.max(0, m.index - 20), m.index + "ethClient(".length))) continue;
        rawOccurrences++;
        // Walk to the matching ')' so arguments containing calls or
        // nested parentheses are still inspected; a top-level comma means
        // a second argument.
        let depth = 0;
        let second = false;
        let closed = false;
        for (let i = re.lastIndex; i < src.length; i++) {
          const ch = src[i];
          if (ch === "(" || ch === "{" || ch === "[") depth++;
          else if (ch === ")" && depth === 0) { closed = true; break; }
          else if (ch === ")" || ch === "}" || ch === "]") depth--;
          else if (ch === "," && depth === 0) second = true;
        }
        expect(closed).toBe(true);
        totalCalls++;
        if (second) withOpts.push(path.relative(root, file));
      }
    }
    expect(totalCalls).toBe(rawOccurrences);
    expect(totalCalls).toBeGreaterThan(20);
    // R1 repair (FX1): broadcastRaw also passes options — an `observe`
    // hook only (no signal), on exactly one call, so the value path never
    // gets the cancellation guard.
    expect([...withOpts].sort()).toEqual(["services/activity.ts", "services/eth-tx.ts"]);
    const ethTxSrc = fs.readFileSync(path.join(root, "services/eth-tx.ts"), "utf8");
    expect(ethTxSrc.match(/ethClient\(network, \{\s*observe:/g)?.length).toBe(1);
    expect(ethTxSrc).not.toMatch(/signal/);
    for (const vp of ["services/eth-tx.ts", "services/bridge.ts", "services/balances.ts", "services/ens.ts"]) {
      expect(fs.readFileSync(path.join(root, vp), "utf8")).toMatch(/ethClient\(/);
    }
  });

  it("F: construction pin: ethClient(net) with no opts / {} keeps the exact retry + fallback ordering", async () => {
    vi.useFakeTimers();
    for (const opts of [undefined, {}] as const) {
      records = [];
      const fetchMock = installFetch(() => http503());
      const client = opts === undefined ? ethClient("mainnet") : ethClient("mainnet", opts);
      const p = client.getBlockNumber();
      let err: unknown;
      p.catch((e) => { err = e; });
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1_000);
      expect((err as Error)?.name).toBe("HttpRequestError");
      // http retryCount 1 (a,a), fallback hop (b,b), outer fallback retryCount 1 (again).
      expect(records.map((r) => r.url)).toEqual([URL_A, URL_A, URL_B, URL_B, URL_A, URL_A, URL_B, URL_B]);
      expect(fetchMock.mock.calls.length).toBe(8);
      vi.unstubAllGlobals();
    }
  });
});
