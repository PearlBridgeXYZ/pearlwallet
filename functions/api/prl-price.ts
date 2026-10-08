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
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const timeoutMs = Math.min(maxMs, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error("upstream budget exhausted");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "pearlwallet-price/1", accept: "application/json" },
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
  return computePrice(r.json as Offer[]);
}

// Fallback: CoinGecko simple-price, native id first then WPRL. Returns a
// price or null; throws on transport/HTTP error.
async function fetchCoingeckoPrice(deadline: number): Promise<PriceResult | null> {
  const r = await fetchJson(COINGECKO_URL, deadline);
  if (!r.ok) throw new Error(`coingecko http ${r.status}`);
  const body = (r.json ?? {}) as Record<string, { usd?: unknown } | undefined>;
  for (const id of COINGECKO_IDS) {
    const usd = body[id]?.usd;
    if (typeof usd === "number" && isFinite(usd) && usd > 0) {
      return { usd_per_prl: usd, source: "coingecko", n_active_asks: 0 };
    }
  }
  return null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Upstream = { status: number; body: PriceResult | { error: string } };

// OTC → CoinGecko. First usable price wins.
async function fetchUpstream(): Promise<Upstream> {
  const deadline = Date.now() + UPSTREAM_TOTAL_BUDGET_MS;
  let otcErr: string | null = null;
  try {
    const otc = await fetchOtcPrice(deadline);
    if (otc) return { status: 200, body: otc };
  } catch (e) {
    otcErr = errText(e);
  }
  try {
    const cg = await fetchCoingeckoPrice(deadline);
    if (cg) return { status: 200, body: cg };
  } catch (e) {
    return {
      status: 502,
      body: { error: `otc: ${otcErr ?? "no asks"}; coingecko: ${errText(e)}` },
    };
  }
  return {
    status: 503,
    body: { error: `no price: otc: ${otcErr ?? "no active SELL_PRL asks"}; coingecko: no PRL/WPRL listing` },
  };
}

let cache: { at: number; ttl: number; value: Upstream } | null = null;

/** Test hook: drop the in-isolate cache. */
export function _resetPriceCacheForTests(): void {
  cache = null;
}

async function getCached(now: number = Date.now()): Promise<Upstream> {
  if (cache && now - cache.at < cache.ttl) return cache.value;
  const value = await fetchUpstream();
  cache = { at: now, ttl: value.status === 200 ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS, value };
  return value;
}

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

export const onRequestGet = async (): Promise<Response> => {
  const { status, body } = await getCached();
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "public, max-age=30" : "public, max-age=5",
      ...corsHeaders(),
    },
  });
};
