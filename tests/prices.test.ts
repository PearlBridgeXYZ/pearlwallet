import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchPrlPrice, fetchPrlPriceUsd } from "../src/services/prices";

describe("fetchPrlPrice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a valid vwap_median response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ usd_per_prl: 1.42, source: "vwap_median", n_active_asks: 7 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const p = await fetchPrlPrice();
    expect(p.usdPerPrl).toBe(1.42);
    expect(p.source).toBe("vwap_median");
    expect(p.nActiveAsks).toBe(7);
  });

  it("parses a lowest_ask thin-book response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ usd_per_prl: 10.2, source: "lowest_ask", n_active_asks: 1 }),
      { status: 200 },
    )));
    const p = await fetchPrlPrice();
    expect(p.source).toBe("lowest_ask");
    expect(p.nActiveAsks).toBe(1);
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(fetchPrlPrice()).rejects.toThrow(/price http 503/);
  });

  it("throws on invalid price (NaN)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ usd_per_prl: NaN, source: "lowest_ask", n_active_asks: 1 }),
      { status: 200 },
    )));
    // NaN is JSON-serialised as null → number check fails.
    await expect(fetchPrlPrice()).rejects.toThrow(/invalid response/);
  });

  it("throws on zero or negative price", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ usd_per_prl: 0, source: "lowest_ask", n_active_asks: 1 }),
      { status: 200 },
    )));
    await expect(fetchPrlPrice()).rejects.toThrow(/invalid response/);
  });

  it("fetchPrlPriceUsd returns the bare number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ usd_per_prl: 2.5, source: "vwap_median", n_active_asks: 5 }),
      { status: 200 },
    )));
    expect(await fetchPrlPriceUsd()).toBe(2.5);
  });

  it("calls /api/prl-price with accept: application/json", async () => {
    const mock = vi.fn(async () => new Response(
      JSON.stringify({ usd_per_prl: 1.0, source: "lowest_ask", n_active_asks: 1 }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", mock);
    await fetchPrlPrice();
    expect(mock).toHaveBeenCalledWith("/api/prl-price", expect.objectContaining({
      headers: expect.objectContaining({ accept: "application/json" }),
    }));
  });
});
