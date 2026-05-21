// v0.2.5 regression tests for the Pearl RPC pool + auto-rotation.
//
// Before v0.2.5 the wallet talked to a single sentry endpoint, retrying
// the same URL on transient failures. A degraded sentry meant a degraded
// wallet — the retry loop just burned wall-clock against the broken host.
//
// v0.2.5 rotates across PEARL_RPC_POOL on every transient failure (5xx,
// 408, 429, TypeError-on-fetch which covers DNS/CORS/network/cert). An
// endpoint that fails is parked for ENDPOINT_COOLDOWN_MS so the next
// call() doesn't re-burn the same timeout. JSON-RPC body errors (-5,
// -32601, etc.) are NOT rotation-worthy: the chain spoke, the endpoint
// is fine, surface the error to the caller.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchPrlBalanceGrains,
  _resetPearlRpcHealthForTests,
} from "../src/services/pearl-rpc";
import { PEARL_RPC_POOL } from "../src/chains/pearl/network";
import { useUI } from "../src/state/ui-store";

const ADDR = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResult(): unknown {
  return { jsonrpc: "2.0", id: 1, result: [], error: null };
}

describe("v0.2.5 — pool definition", () => {
  it("has at least 2 distinct endpoints", () => {
    const unique = new Set(PEARL_RPC_POOL);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it("primary entry is the CF-fronted hostname (today's prod)", () => {
    expect(PEARL_RPC_POOL[0]).toBe("https://rpc.pearlwallet.xyz/");
  });

  it("every entry is https://", () => {
    for (const url of PEARL_RPC_POOL) {
      expect(url.startsWith("https://")).toBe(true);
    }
  });
});

describe("v0.2.5 — rotation on 5xx", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    _resetPearlRpcHealthForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPearlRpcHealthForTests();
  });

  it("primary 503 → falls through to secondary, returns secondary's result", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === PEARL_RPC_POOL[0]) {
        return new Response("upstream busy", { status: 503 });
      }
      return jsonResp(emptyResult());
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    expect(calls[0]).toBe(PEARL_RPC_POOL[0]);
    expect(calls[1]).toBe(PEARL_RPC_POOL[1]);
  });

  it("primary + secondary both 5xx → falls through to tertiary", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === PEARL_RPC_POOL[0]) return new Response("", { status: 502 });
      if (url === PEARL_RPC_POOL[1]) return new Response("", { status: 504 });
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(calls.length).toBe(3);
    expect(calls[2]).toBe(PEARL_RPC_POOL[2]);
  });

  it("every endpoint 5xx → throws after exhausting pool", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow(/rpc http 503/);
  });
});

describe("v0.2.5 — rotation on network errors (TypeError)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    _resetPearlRpcHealthForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPearlRpcHealthForTests();
  });

  it("DNS failure (TypeError) on primary → rotates to secondary", async () => {
    // The provisioning-ready entries in the pool may NXDOMAIN today.
    // fetch() rejects with TypeError on NXDOMAIN — same code path as
    // network errors, CORS rejections, and TLS handshake failures.
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === PEARL_RPC_POOL[0]) throw new TypeError("fetch failed");
      return jsonResp(emptyResult());
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    expect(calls[0]).toBe(PEARL_RPC_POOL[0]);
    expect(calls[1]).toBe(PEARL_RPC_POOL[1]);
  });
});

describe("v0.2.5 — 4xx does NOT rotate (request is wrong, next endpoint won't help)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    _resetPearlRpcHealthForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPearlRpcHealthForTests();
  });

  it("400 on primary → throws immediately, does NOT try secondary", async () => {
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

  it("408 (request timeout) DOES rotate — that's an endpoint health issue", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === PEARL_RPC_POOL[0]) return new Response("", { status: 408 });
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toBe(PEARL_RPC_POOL[1]);
  });

  it("429 (rate limited) DOES rotate — this endpoint is saturated, try the next", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === PEARL_RPC_POOL[0]) return new Response("", { status: 429 });
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("v0.2.5 — chain-level JSON-RPC errors do NOT rotate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    _resetPearlRpcHealthForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPearlRpcHealthForTests();
  });

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
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    _resetPearlRpcHealthForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPearlRpcHealthForTests();
  });

  it("a failing primary is skipped on the NEXT call within the cooldown window", async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === PEARL_RPC_POOL[0]) {
        primaryCalls++;
        return new Response("", { status: 503 });
      }
      secondaryCalls++;
      return jsonResp(emptyResult());
    }));
    // First call: primary fails (1 hit), secondary returns (1 hit).
    await fetchPrlBalanceGrains(ADDR);
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(1);
    // Second call: primary is cooled-down → secondary is tried FIRST.
    // We expect primary's count to stay at 1 and secondary to be hit again.
    await fetchPrlBalanceGrains(ADDR);
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(2);
  });

  it("when EVERY endpoint is cooled down we still try them rather than refuse", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      return new Response("", { status: 503 });
    }));
    // First call: exhausts every endpoint, all get parked.
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow();
    const firstRound = attempts;
    expect(firstRound).toBe(PEARL_RPC_POOL.length);
    // Second call: all endpoints are still in cooldown, but we don't
    // refuse — we try them anyway (the cooldown is a soft hint, not a
    // hard gate). User shouldn't be locked out because of a brief
    // pool-wide outage.
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow();
    expect(attempts).toBe(firstRound + PEARL_RPC_POOL.length);
  });
});

describe("v0.2.5 — override behaviour with the pool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    _resetPearlRpcHealthForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    _resetPearlRpcHealthForTests();
  });

  it("an allowlisted override is tried FIRST; pool is the fallback", async () => {
    // Override path on the existing allowlisted host — a power user
    // running a custom sentry on a versioned endpoint.
    useUI.getState().setPearlRpcOverride("https://rpc.pearlwallet.xyz/v2");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "https://rpc.pearlwallet.xyz/v2") {
        return new Response("", { status: 503 });
      }
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    expect(calls[0]).toBe("https://rpc.pearlwallet.xyz/v2");
    // After override fails, the pool kicks in starting at index 0.
    expect(calls[1]).toBe(PEARL_RPC_POOL[0]);
  });

  it("override identical to the default pool primary is deduped (no double-attempt)", async () => {
    useUI.getState().setPearlRpcOverride("https://rpc.pearlwallet.xyz/");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === PEARL_RPC_POOL[0]) return new Response("", { status: 503 });
      return jsonResp(emptyResult());
    }));
    await fetchPrlBalanceGrains(ADDR);
    // Primary appears exactly once across the attempt list, then the
    // rotation moves on to the secondary — no wasted call.
    const primaryHits = calls.filter((u) => u === PEARL_RPC_POOL[0]).length;
    expect(primaryHits).toBe(1);
  });
});
