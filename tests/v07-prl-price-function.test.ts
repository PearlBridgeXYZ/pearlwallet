// v0.7 — functions/api/prl-price.ts: OTC order book with the CoinGecko
// fallback ported from the production price service; same response shape;
// in-isolate cache 30 s for good prices, 5 s for errors.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { onRequestGet, _resetPriceCacheForTests, weightedMedianLow } from "../functions/api/prl-price";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("functions/api/prl-price — OTC with CoinGecko fallback", () => {
  const OTC = "https://api.pearl-otc.com/offers";
  beforeEach(() => _resetPriceCacheForTests());

  function stubUpstream(otc: () => Response | Promise<Response>, cg: () => Response | Promise<Response>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url) === OTC) return otc();
      if (String(url).startsWith("https://api.coingecko.com/")) return cg();
      throw new Error("unexpected " + url);
    }));
    return calls;
  }
  const ask = (px: number, qty = 10) => ({ status: "ACTIVE", side: "SELL_PRL", usdc_per_prl: String(px), prl_remaining: String(qty) });

  it("OTC book with asks → OTC price, CoinGecko not consulted", async () => {
    const calls = stubUpstream(() => new Response(JSON.stringify([ask(1.5)])), () => new Response("{}"));
    const r = await onRequestGet();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ usd_per_prl: 1.5, source: "lowest_ask", n_active_asks: 1 });
    expect(calls.some((c) => c.includes("coingecko"))).toBe(false);
    expect(r.headers.get("cache-control")).toBe("public, max-age=30");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("OTC empty book → CoinGecko pearl-2", async () => {
    stubUpstream(() => new Response("[]"), () => new Response(JSON.stringify({ "pearl-2": { usd: 1.41 } })));
    const r = await onRequestGet();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ usd_per_prl: 1.41, source: "coingecko", n_active_asks: 0 });
  });

  it("OTC down → CoinGecko wrapped-pearl when pearl-2 missing", async () => {
    stubUpstream(() => new Response("", { status: 500 }), () => new Response(JSON.stringify({ "wrapped-pearl": { usd: 1.38 } })));
    const r = await onRequestGet();
    expect(await r.json()).toMatchObject({ usd_per_prl: 1.38, source: "coingecko" });
  });

  it("both fail: CoinGecko unreachable → 502; no listing → 503", async () => {
    stubUpstream(() => new Response("[]"), () => new Response("", { status: 429 }));
    expect((await onRequestGet()).status).toBe(502);
    _resetPriceCacheForTests();
    stubUpstream(() => new Response("[]"), () => new Response("{}"));
    const r = await onRequestGet();
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("public, max-age=5");
  });

  it("OTC down + CoinGecko 429 on Pages egress → the hosted price service answers", async () => {
    const HOSTED = "https://wallet.pearlbridge.xyz/api/prl-price";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url) === OTC) return new Response("", { status: 404 });
      if (String(url) === HOSTED) return new Response(JSON.stringify({ usd_per_prl: 1.5, source: "coingecko", n_active_asks: 0 }));
      return new Response("", { status: 429 });
    }));
    const r = await onRequestGet();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ usd_per_prl: 1.5, source: "coingecko", n_active_asks: 0 });
    expect(calls.some((c) => c.includes("coingecko"))).toBe(false);
  });

  it("a hosted answer in any other shape is ignored and CoinGecko is tried", async () => {
    const HOSTED = "https://wallet.pearlbridge.xyz/api/prl-price";
    for (const bad of [{ usd_per_prl: -1, source: "coingecko", n_active_asks: 0 }, { usd_per_prl: 1.5, source: "x", n_active_asks: 0 }, { usd_per_prl: "1.5", source: "coingecko", n_active_asks: 0 }]) {
      _resetPriceCacheForTests();
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (String(url) === OTC) return new Response("[]");
        if (String(url) === HOSTED) return new Response(JSON.stringify(bad));
        return new Response(JSON.stringify({ "pearl-2": { usd: 1.41 } }));
      }));
      expect(await (await onRequestGet()).json()).toEqual({ usd_per_prl: 1.41, source: "coingecko", n_active_asks: 0 });
    }
  });

  it("hosted answers outside the bound or with inconsistent metadata are rejected", async () => {
    const HOSTED = "https://wallet.pearlbridge.xyz/api/prl-price";
    for (const bad of [
      { usd_per_prl: 1e300, source: "coingecko", n_active_asks: 0 },
      { usd_per_prl: 10_001, source: "coingecko", n_active_asks: 0 },
      { usd_per_prl: 1.5, source: "coingecko", n_active_asks: 4 },
      { usd_per_prl: 1.5, source: "lowest_ask", n_active_asks: 0 },
      { usd_per_prl: 1.5, source: "vwap_median", n_active_asks: 2 },
      { usd_per_prl: 1.5, source: "coingecko", n_active_asks: 0, extra: 1 },
    ]) {
      _resetPriceCacheForTests();
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (String(url) === OTC) return new Response("[]");
        if (String(url) === HOSTED) return new Response(JSON.stringify(bad));
        return new Response(JSON.stringify({ "pearl-2": { usd: 1.41 } }));
      }));
      expect(await (await onRequestGet()).json()).toEqual({ usd_per_prl: 1.41, source: "coingecko", n_active_asks: 0 });
    }
  });

  it("an implausible price from any source is never served", async () => {
    stubUpstream(() => new Response(JSON.stringify([ask(50_000)])), () => new Response(JSON.stringify({ "pearl-2": { usd: 1e300 } })));
    const r = await onRequestGet();
    expect(r.status).not.toBe(200);
  });

  it("never takes the hosted hop from the hosted origin or from a hop request (no self-recursion)", async () => {
    const HOSTED = "https://wallet.pearlbridge.xyz/api/prl-price";
    for (const request of [
      new Request(HOSTED),
      new Request("https://next.wallet.pearlbridge.xyz/api/prl-price", { headers: { "x-pearlwallet-price-hop": "1" } }),
    ]) {
      _resetPriceCacheForTests();
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url) === OTC) return new Response("", { status: 404 });
        return new Response(JSON.stringify({ "pearl-2": { usd: 1.41 } }));
      }));
      const r = await onRequestGet({ request });
      expect(r.status).toBe(200);
      expect(calls).not.toContain(HOSTED);
    }
  });

  it("the hosted hop is marked so the far side can refuse to recurse", async () => {
    const HOSTED = "https://wallet.pearlbridge.xyz/api/prl-price";
    let hopHeader: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === OTC) return new Response("", { status: 404 });
      if (String(url) === HOSTED) {
        hopHeader = new Headers(init?.headers).get("x-pearlwallet-price-hop");
        return new Response(JSON.stringify({ usd_per_prl: 1.5, source: "coingecko", n_active_asks: 0 }));
      }
      return new Response("", { status: 429 });
    }));
    expect((await onRequestGet({ request: new Request("https://next.wallet.pearlbridge.xyz/api/prl-price") })).status).toBe(200);
    expect(hopHeader).toBe("1");
  });

  it("caches a good price for 30 s and an error for 5 s", async () => {
    vi.useFakeTimers();
    try {
      let otcCalls = 0;
      stubUpstream(() => {
        otcCalls++;
        return new Response(JSON.stringify([ask(2)]));
      }, () => new Response("{}"));
      await onRequestGet();
      await onRequestGet();
      expect(otcCalls).toBe(1);
      vi.advanceTimersByTime(30_001);
      await onRequestGet();
      expect(otcCalls).toBe(2);

      _resetPriceCacheForTests();
      let cgCalls = 0;
      stubUpstream(() => new Response("[]"), () => {
        cgCalls++;
        return new Response("{}");
      });
      await onRequestGet();
      await onRequestGet();
      expect(cgCalls).toBe(1);
      vi.advanceTimersByTime(5_001);
      await onRequestGet();
      expect(cgCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("functions/api/prl-price — weighted median without expanding asks", () => {
  // The previous implementation: one array element per whole PRL offered.
  function expandedMedianLow(asks: Array<[number, number]>): number {
    const xs: number[] = [];
    for (const [px, qty] of asks) for (let i = 0; i < Math.max(1, Math.floor(qty)); i++) xs.push(px);
    xs.sort((a, b) => a - b);
    return xs[Math.floor((xs.length - 1) / 2)]!;
  }

  it("matches the expanded lower median on small and random books", () => {
    const books: Array<Array<[number, number]>> = [
      [[1, 1], [2, 1], [3, 1]],
      [[1, 1], [2, 1], [3, 1], [4, 1]],
      [[3, 10], [1, 0.5], [2, 2.9]],
      [[0.5, 100], [0.7, 1], [0.6, 99]],
    ];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let b = 0; b < 200; b++) {
      const n = 3 + Math.floor(rnd() * 6);
      books.push(Array.from({ length: n }, () => [Math.round(rnd() * 1000) / 100 + 0.01, rnd() * 50] as [number, number]));
    }
    for (const book of books) expect(weightedMedianLow(book)).toBe(expandedMedianLow(book));
  });

  it("three million-PRL asks are priced without allocating per PRL", () => {
    const before = process.memoryUsage().heapUsed;
    const px = weightedMedianLow([[0.3, 1e6], [0.2, 1e6], [0.25, 1e6]]);
    expect(px).toBe(0.25);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(16 * 1024 * 1024);
    // Absurd quantities stay exact and finite.
    expect(weightedMedianLow([[1, 1e300], [2, 1e300], [3, 1e300]])).toBe(2);
  });

  it("the function no longer pushes one element per PRL", () => {
    const src = readFileSync("functions/api/prl-price.ts", "utf8");
    expect(src).not.toMatch(/for \(let i = 0; i < reps; i\+\+\)/);
    expect(src).toMatch(/usd_per_prl: weightedMedianLow\(asks\)/);
  });
});
