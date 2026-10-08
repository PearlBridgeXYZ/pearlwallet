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
const UPSTREAM_TIMEOUT_MS = 8_000;
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

function medianLow(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) throw new Error("medianLow: empty");
  return sorted[Math.floor((n - 1) / 2)];
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
    const weighted: number[] = [];
    for (const [px, qty] of asks) {
      const reps = Math.max(1, Math.floor(qty));
      for (let i = 0; i < reps; i++) weighted.push(px);
    }
    return {
      usd_per_prl: medianLow(weighted),
      source: "vwap_median",
      n_active_asks: asks.length,
    };
  }
  let minAsk = asks[0][0];
  for (const [px] of asks) if (px < minAsk) minAsk = px;
  return { usd_per_prl: minAsk, source: "lowest_ask", n_active_asks: asks.length };
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
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
async function fetchOtcPrice(): Promise<PriceResult | null> {
  const r = await fetchJson(OTC_URL);
  if (!r.ok) throw new Error(`otc http ${r.status}`);
  if (!Array.isArray(r.json)) throw new Error("otc not array");
  return computePrice(r.json as Offer[]);
}

// Fallback: CoinGecko simple-price, native id first then WPRL. Returns a
// price or null; throws on transport/HTTP error.
async function fetchCoingeckoPrice(): Promise<PriceResult | null> {
  const r = await fetchJson(COINGECKO_URL);
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
  let otcErr: string | null = null;
  try {
    const otc = await fetchOtcPrice();
    if (otc) return { status: 200, body: otc };
  } catch (e) {
    otcErr = errText(e);
  }
  try {
    const cg = await fetchCoingeckoPrice();
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
