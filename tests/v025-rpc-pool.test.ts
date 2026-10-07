// v0.2.5 regression tests for the Pearl RPC pool + auto-rotation,
// updated for v0.7 (shared limiter + exponential backoff).
//
// v0.2.5 rotated across PEARL_RPC_POOL on every transient failure (5xx,
// 408, 429, TypeError-on-fetch which covers DNS/CORS/network/cert), after
// 2 attempts per endpoint. v0.7 changes the per-endpoint policy: transient
// failures back off exponentially (≈0.5,1,2,4,8 s, Retry-After honoured)
// and retry the SAME endpoint up to maxRetries (5) before the endpoint is
// parked for ENDPOINT_COOLDOWN_MS and the next candidate is tried. The
// pool itself shrank to the one resolvable host (the three direct sentry
// hostnames were NXDOMAIN), so rotation is exercised via an allowlisted
// override (override → pool). JSON-RPC body errors (-5, -32601, etc.) are
// still never retried: the chain spoke, the endpoint is fine.
//
// Timing: tests/setup-fast-rpc.ts shrinks backoff to milliseconds; the
// real delays are covered in tests/v07-rpc-transport.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchPrlBalanceGrains,
  _resetPearlRpcHealthForTests,
  pearlRpcTuning,
} from "../src/services/pearl-rpc";
import { PEARL_RPC_POOL } from "../src/chains/pearl/network";
import { useUI } from "../src/state/ui-store";

const ADDR = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";
const OVERRIDE = "https://rpc.pearlbridge.xyz/v2";
/** Attempts one endpoint gets before rotation: 1 + maxRetries. */
const PER_ENDPOINT = () => 1 + pearlRpcTuning().maxRetries;

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResult(): unknown {
  return { jsonrpc: "2.0", id: 1, result: [], error: null };
}

function reset() {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
  _resetPearlRpcHealthForTests();
}

describe("v0.7 — pool definition", () => {
  it("primary entry is the CF-fronted hostname (today's prod)", () => {
    expect(PEARL_RPC_POOL[0]).toBe("https://rpc.pearlbridge.xyz/");
  });

  it("every entry is https:// and distinct", () => {
    for (const url of PEARL_RPC_POOL) {
      expect(url.startsWith("https://")).toBe(true);
    }
    expect(new Set(PEARL_RPC_POOL).size).toBe(PEARL_RPC_POOL.length);
  });

  it("the never-resolving direct sentry hosts are no longer in the pool", () => {
    for (const url of PEARL_RPC_POOL) {
      expect(url).not.toMatch(/pearl-sentry-(fsn1|nbg1|hel1)-1/);
    }
  });
});

describe("v0.7 — backoff on 5xx retries the SAME endpoint", () => {
  beforeEach(reset);
  afterEach(reset);

  it("primary one-off 503 → same endpoint retried, succeeds", async () => {
    let primary = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      primary++;
      if (primary === 1) return new Response("upstream busy", { status: 503 });
      return jsonResp(emptyResult());
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    expect(calls).toEqual([PEARL_RPC_POOL[0], PEARL_RPC_POOL[0]]);
  });

  it("several consecutive 503s are absorbed (old policy gave up after 2)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n <= 4) return new Response("", { status: 503 });
      return jsonResp(emptyResult());
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    expect(n).toBe(5);
  });

  it("every attempt 5xx → throws after 1 + maxRetries attempts per endpoint", async () => {
    let total = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      total++;
      return new Response("", { status: 503 });
    }));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow(/rpc http 503/);
    expect(total).toBe(PEARL_RPC_POOL.length * PER_ENDPOINT());
  });

  it("override 503 until its backoff is exhausted → rotates to the pool", async () => {
    useUI.getState().setPearlRpcOverride(OVERRIDE);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === OVERRIDE) return new Response("upstream busy", { status: 503 });
      return jsonResp(emptyResult());
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    const k = PER_ENDPOINT();
    expect(calls.slice(0, k)).toEqual(new Array(k).fill(OVERRIDE));
    expect(calls[k]).toBe(PEARL_RPC_POOL[0]);
  });
});

describe("v0.7 — network errors (TypeError) back off and retry", () => {
  beforeEach(reset);
  afterEach(reset);

  it("persistent TypeError on override → rotates to pool after backoff", async () => {
    useUI.getState().setPearlRpcOverride(OVERRIDE);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === OVERRIDE) throw new TypeError("fetch failed");
      return jsonResp(emptyResult());
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    expect(calls[PER_ENDPOINT()]).toBe(PEARL_RPC_POOL[0]);
  });

  it("primary one-off TypeError → SAME endpoint retried, succeeds", async () => {
    let primary = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      primary++;
      if (primary === 1) throw new TypeError("network glitch");
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(calls).toEqual([PEARL_RPC_POOL[0], PEARL_RPC_POOL[0]]);
  });
});

describe("v0.2.5 — 4xx does NOT retry (request is wrong, next endpoint won't help)", () => {
  beforeEach(reset);
  afterEach(reset);

  it("400 on primary → throws immediately", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response("bad request", { status: 400 });
    }));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow(/rpc http 400/);
    expect(calls.length).toBe(1);
  });

  it("403 (method blocked by sentry allowlist) → throws immediately", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response("", { status: 403 });
    }));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow(/rpc http 403/);
    expect(calls.length).toBe(1);
  });

  it("408 (request timeout) DOES retry", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) return new Response("", { status: 408 });
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(n).toBe(2);
  });

  it("429 (rate limited) DOES retry — endpoint is saturated, not broken", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n <= 2) return new Response("", { status: 429 });
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(n).toBe(3);
  });
});

describe("v0.2.5 — chain-level JSON-RPC errors do NOT rotate", () => {
  beforeEach(reset);
  afterEach(reset);

  it("-5 'No information about address' is converted to grains=0 (caller swallows)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResp({
        jsonrpc: "2.0", id: 1, result: null,
        error: { code: -5, message: "No information available about address" },
      });
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    // Crucially: did NOT rotate. The chain has no data; rotating won't
    // produce different data.
    expect(calls.length).toBe(1);
  });

  it("-32601 'Method not found' surfaces directly, does NOT rotate", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResp({
        jsonrpc: "2.0", id: 1, result: null,
        error: { code: -32601, message: "Method not found" },
      });
    }));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow(/Method not found/);
    expect(calls.length).toBe(1);
  });
});

describe("v0.2.5 — endpoint cooldown", () => {
  beforeEach(reset);
  afterEach(() => {
    reset();
    useUI.getState().setPearlRpcOverride("");
  });

  it("an override that exhausted its backoff is skipped on the NEXT call within the cooldown window", async () => {
    useUI.getState().setPearlRpcOverride(OVERRIDE);
    let overrideCalls = 0;
    let poolCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === OVERRIDE) {
        overrideCalls++;
        return new Response("", { status: 503 });
      }
      poolCalls++;
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(overrideCalls).toBe(PER_ENDPOINT());
    expect(poolCalls).toBe(1);
    // Second call: override is cooled-down → pool primary tried FIRST.
    await fetchPrlBalanceGrains(ADDR);
    expect(overrideCalls).toBe(PER_ENDPOINT());
    expect(poolCalls).toBe(2);
  });

  it("when EVERY endpoint is cooled down we still try them rather than refuse", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      return new Response("", { status: 503 });
    }));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow();
    const firstRound = attempts;
    expect(firstRound).toBe(PEARL_RPC_POOL.length * PER_ENDPOINT());
    // Second call: all endpoints cooled-down, but we still try them
    // (cooldown is a soft hint, not a hard gate).
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow();
    expect(attempts).toBe(firstRound * 2);
  });
});

describe("v0.2.5 — override behaviour with the pool", () => {
  beforeEach(reset);
  afterEach(() => {
    reset();
    useUI.getState().setPearlRpcOverride("");
  });

  it("an allowlisted override is tried FIRST", async () => {
    useUI.getState().setPearlRpcOverride(OVERRIDE);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(calls).toEqual([OVERRIDE]);
  });

  it("override identical to the default pool primary is deduped (counts as one slot)", async () => {
    useUI.getState().setPearlRpcOverride("https://rpc.pearlbridge.xyz/");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response("", { status: 503 });
    }));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow();
    // One slot → 1 + maxRetries attempts, not twice that.
    const primaryHits = calls.filter((u) => u === PEARL_RPC_POOL[0]).length;
    expect(primaryHits).toBe(PER_ENDPOINT());
    expect(calls.length).toBe(PER_ENDPOINT() * PEARL_RPC_POOL.length);
  });
});
