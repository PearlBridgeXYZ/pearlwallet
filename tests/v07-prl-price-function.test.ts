// v0.7 — functions/api/prl-price.ts: OTC order book with the CoinGecko
// fallback ported from the production price service; same response shape;
// in-isolate cache 30 s for good prices, 5 s for errors.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { onRequestGet, _resetPriceCacheForTests } from "../functions/api/prl-price";

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
