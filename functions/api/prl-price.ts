// CF Pages Function: GET /api/prl-price
//
// Proxies api.pearl-otc.com/offers (which doesn't CORS to
// wallet.pearlbridge.xyz) and computes a single indicative PRL/USDC price
// from the active SELL_PRL asks. Mirrors the logic in
// pearlbridge-relay/scripts/pearlbridge-tvl-alerter.py so the wallet,
// the TVL alerter, and any future tooling all derive the same number
// from the same orderbook.
//
// Fallback (ported from the production price service): when the OTC book
// is unreachable or has no usable asks, price from CoinGecko simple-price
// — native `pearl-2` first, then `wrapped-pearl` (WPRL, 1:1 through the
// bridge). Only when BOTH sources fail does the endpoint return an error.
//
// Between the two (2026-10-12): the hosted wallet's own price service
// (wallet.pearlbridge.xyz/api/prl-price, nginx → a Node service on our
// VPS). Pages Functions egress through shared Cloudflare IPs that
// CoinGecko rate-limits (429), so on Pages the fallback alone is not
// dependable; the hosted service runs the same OTC → CoinGecko chain
// from a dedicated IP. Its answer is accepted only in the exact shape
// below, with source and ask count consistent, and only inside the
// plausibility bound every source must meet (MAX_USD_PER_PRL).
//
// The hosted hop must never reach this Function itself (it would if this
// Function were ever served at the hosted origin): the hop carries
// HOP_HEADER, and a request that carries it, or that arrives on the
// hosted origin, skips the hop.
//
// Response shape (snake_case to mirror the Python alerter):
//   { "usd_per_prl": number,
//     "source": "vwap_median" | "lowest_ask" | "coingecko",
//     "n_active_asks": number }          // 0 for coingecko
//
// HTTP semantics:
//   200 — body above, Cache-Control: 30s
//   502 — OTC failed/empty AND CoinGecko unreachable / non-2xx
//   503 — OTC failed/empty AND CoinGecko has no PRL/WPRL price
// Results are cached in-isolate: good prices for 30 s, errors for 5 s (so
// a recovered upstream is picked up within seconds).
//
// We always send CORS headers so the same proxy works for any future
// PearlBridge surface that wants this price.

interface Offer {
  status?: string;
  side?: string;
  usdc_per_prl?: string;
  prl_remaining?: string;
}

const OTC_URL = "https://api.pearl-otc.com/offers";
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=pearl-2,wrapped-pearl&vs_currencies=usd";
const COINGECKO_IDS = ["pearl-2", "wrapped-pearl"] as const;
const HOSTED_URL = "https://wallet.pearlbridge.xyz/api/prl-price";
/** The hosted service answers from its own cache; keep its share small. */
export const HOSTED_TIMEOUT_MS = 3_000;
const HOSTED_HOST = "wallet.pearlbridge.xyz";
const HOP_HEADER = "x-pearlwallet-price-hop";
/** Upper sanity bound for any source's PRL price. Far above any traded
 *  price; it only stops a broken upstream from showing an absurd value
 *  (or overflowing USD totals downstream). */
export const MAX_USD_PER_PRL = 10_000;

function plausibleUsd(usd: unknown): usd is number {
  return typeof usd === "number" && isFinite(usd) && usd > 0 && usd <= MAX_USD_PER_PRL;
}
/** Per-upstream timeout (CoinGecko). */
export const UPSTREAM_TIMEOUT_MS = 8_000;
/** OTC gets less so a slow order book still leaves the fallback time. */
export const OTC_TIMEOUT_MS = 5_000;
/** End-to-end budget for OTC + CoinGecko together: the fallback only
 *  gets what the first call left, so the function always answers inside
 *  this budget — below the client's PRICE_FETCH_TIMEOUT_MS
 *  (src/services/prices.ts; a test pins the relation). */
export const UPSTREAM_TOTAL_BUDGET_MS = 9_000;
const CACHE_TTL_MS = 30_000;
const ERROR_CACHE_TTL_MS = 5_000;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

/**
 * Lower median of the ask prices with each ask counted once per whole PRL
 * it offers (at least once) — the same value as expanding every ask into
 * floor(qty) copies and taking medianLow, but computed over the sorted
 * (price, weight) pairs with a running sum, so memory no longer grows with
 * the quantity on offer (a few large asks used to exhaust the isolate).
 * Weights are capped so their sum stays an exact integer.
 */
export function weightedMedianLow(asks: ReadonlyArray<readonly [number, number]>): number {
  if (asks.length === 0) throw new Error("weightedMedianLow: empty");
  const cap = Math.floor(Number.MAX_SAFE_INTEGER / asks.length);
  const items = asks
    .map(([px, qty]) => [px, Math.min(cap, Math.max(1, Math.floor(qty)))] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, w] of items) total += w;
  const k = Math.floor((total - 1) / 2); // index of the lower median
  let cum = 0;
  for (const [px, w] of items) {
    cum += w;
    if (cum > k) return px;
  }
  return items[items.length - 1]![0];
}

interface PriceResult {
  usd_per_prl: number;
  source: "vwap_median" | "lowest_ask" | "coingecko";
  n_active_asks: number;
}

function computePrice(offers: Offer[]): PriceResult | null {
  const asks: Array<[number, number]> = [];
  for (const o of offers) {
    if (o?.status !== "ACTIVE" || o?.side !== "SELL_PRL") continue;
    const px = Number(o.usdc_per_prl);
    const qty = Number(o.prl_remaining);
    if (!isFinite(px) || !isFinite(qty) || px <= 0 || qty <= 0) continue;
    asks.push([px, qty]);
  }
  if (asks.length === 0) return null;
  if (asks.length >= 3) {
    return {
      usd_per_prl: weightedMedianLow(asks),
      source: "vwap_median",
      n_active_asks: asks.length,
    };
  }
  let minAsk = asks[0][0];
  for (const [px] of asks) if (px < minAsk) minAsk = px;
  return { usd_per_prl: minAsk, source: "lowest_ask", n_active_asks: asks.length };
}

async function fetchJson(
  url: string,
  deadline: number,
  maxMs: number = UPSTREAM_TIMEOUT_MS,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const timeoutMs = Math.min(maxMs, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error("upstream budget exhausted");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "pearlwallet-price/1", accept: "application/json", ...extraHeaders },
      signal: ac.signal,
      // Cloudflare subrequest edge cache (ignored outside Workers).
      cf: { cacheTtl: 30, cacheEverything: true },
    } as RequestInit);
    return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
  } finally {
    clearTimeout(t);
  }
}

// Primary: OTC order book. Returns a price or null (no usable asks);
// throws on transport/HTTP error.
async function fetchOtcPrice(deadline: number): Promise<PriceResult | null> {
  const r = await fetchJson(OTC_URL, deadline, OTC_TIMEOUT_MS);
  if (!r.ok) throw new Error(`otc http ${r.status}`);
  if (!Array.isArray(r.json)) throw new Error("otc not array");
  const p = computePrice(r.json as Offer[]);
  if (p && !plausibleUsd(p.usd_per_prl)) throw new Error("otc implausible price");
  return p;
}

// Fallback: CoinGecko simple-price, native id first then WPRL. Returns a
// price or null; throws on transport/HTTP error.
async function fetchCoingeckoPrice(deadline: number): Promise<PriceResult | null> {
  const r = await fetchJson(COINGECKO_URL, deadline);
  if (!r.ok) throw new Error(`coingecko http ${r.status}`);
  const body = (r.json ?? {}) as Record<string, { usd?: unknown } | undefined>;
  for (const id of COINGECKO_IDS) {
    const usd = body[id]?.usd;
    if (plausibleUsd(usd)) {
      return { usd_per_prl: usd, source: "coingecko", n_active_asks: 0 };
    }
  }
  return null;
}

// Second: the hosted wallet's price service. Same response shape; anything
// else is rejected. Returns a price or throws.
async function fetchHostedPrice(deadline: number): Promise<PriceResult> {
  const r = await fetchJson(HOSTED_URL, deadline, HOSTED_TIMEOUT_MS, { [HOP_HEADER]: "1" });
  if (!r.ok) throw new Error(`hosted http ${r.status}`);
  const b = (r.json ?? {}) as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  const usd = b.usd_per_prl;
  const source = b.source;
  const n = b.n_active_asks;
  const consistent =
    typeof n === "number" && Number.isInteger(n) &&
    ((source === "coingecko" && n === 0) ||
      (source === "lowest_ask" && (n === 1 || n === 2)) ||
      (source === "vwap_median" && n >= 3));
  if (keys !== "n_active_asks,source,usd_per_prl" || !plausibleUsd(usd) || !consistent) {
    throw new Error("hosted bad shape");
  }
  return { usd_per_prl: usd, source: source as PriceResult["source"], n_active_asks: n as number };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Upstream = { status: number; body: PriceResult | { error: string } };

// OTC → hosted service → CoinGecko. First usable price wins.
async function fetchUpstream(skipHosted: boolean): Promise<Upstream> {
  const deadline = Date.now() + UPSTREAM_TOTAL_BUDGET_MS;
  let otcErr: string | null = null;
  let hostedErr = "skipped (self)";
  try {
    const otc = await fetchOtcPrice(deadline);
    if (otc) return { status: 200, body: otc };
  } catch (e) {
    otcErr = errText(e);
  }
  if (!skipHosted) {
    try {
      return { status: 200, body: await fetchHostedPrice(deadline) };
    } catch (e) {
      hostedErr = errText(e);
    }
  }
  try {
    const cg = await fetchCoingeckoPrice(deadline);
    if (cg) return { status: 200, body: cg };
  } catch (e) {
    return {
      status: 502,
      body: { error: `otc: ${otcErr ?? "no asks"}; hosted: ${hostedErr}; coingecko: ${errText(e)}` },
    };
  }
  return {
    status: 503,
    body: { error: `no price: otc: ${otcErr ?? "no active SELL_PRL asks"}; hosted: ${hostedErr}; coingecko: no PRL/WPRL listing` },
  };
}

type CacheEntry = { at: number; ttl: number; value: Upstream };
// Keyed by whether the hosted hop was skipped, so a self-hop answer never
// serves a normal request (and vice versa).
const cache = new Map<boolean, CacheEntry>();

/** Test hook: drop the in-isolate cache. */
export function _resetPriceCacheForTests(): void {
  cache.clear();
}

async function getCached(skipHosted: boolean, now: number = Date.now()): Promise<Upstream> {
  const hit = cache.get(skipHosted);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const value = await fetchUpstream(skipHosted);
  cache.set(skipHosted, { at: now, ttl: value.status === 200 ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS, value });
  return value;
}

/** True when this request must not take the hosted hop: it is the hop
 *  itself, or it arrived on the hosted origin. */
function isSelfRequest(request: Request | undefined): boolean {
  if (!request) return false;
  if (request.headers.get(HOP_HEADER)) return true;
  try {
    return new URL(request.url).host === HOSTED_HOST;
  } catch {
    return false;
  }
}

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

export const onRequestGet = async (context?: { request?: Request }): Promise<Response> => {
  const { status, body } = await getCached(isSelfRequest(context?.request));
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "public, max-age=30" : "public, max-age=5",
      ...corsHeaders(),
    },
  });
};
