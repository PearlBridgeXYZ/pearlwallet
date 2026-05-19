// CF Pages Function: GET /api/prl-price
//
// Proxies api.pearl-otc.com/offers (which doesn't CORS to
// pearlwallet.xyz) and computes a single indicative PRL/USDC price
// from the active SELL_PRL asks. Mirrors the logic in
// pearlbridge-relay/scripts/pearlbridge-tvl-alerter.py so the wallet,
// the TVL alerter, and any future tooling all derive the same number
// from the same orderbook.
//
// Response shape (snake_case to mirror the Python alerter):
//   { "usd_per_prl": number,
//     "source": "vwap_median" | "lowest_ask",
//     "n_active_asks": number }
//
// HTTP semantics:
//   200 — body above, Cache-Control: 30s edge
//   503 — orderbook reachable but empty / no active asks
//   502 — orderbook unreachable or returned non-array
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
  source: "vwap_median" | "lowest_ask";
  n_active_asks: number;
}

function computePrice(offers: Offer[]): PriceResult | null {
  const asks: Array<[number, number]> = [];
  for (const o of offers) {
    if (o.status !== "ACTIVE" || o.side !== "SELL_PRL") continue;
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

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

export const onRequestGet = async (): Promise<Response> => {
  let offers: Offer[];
  try {
    const r = await fetch(OTC_URL, {
      headers: { "user-agent": "pearlwallet-price/1" },
      cf: { cacheTtl: 30, cacheEverything: true },
    } as RequestInit);
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `upstream ${r.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders() },
      });
    }
    const raw = await r.json();
    if (!Array.isArray(raw)) {
      return new Response(JSON.stringify({ error: "upstream not array" }), {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders() },
      });
    }
    offers = raw as Offer[];
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  const price = computePrice(offers);
  if (!price) {
    return new Response(JSON.stringify({ error: "no active SELL_PRL asks" }), {
      status: 503,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }
  return new Response(JSON.stringify(price), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=30",
      ...corsHeaders(),
    },
  });
};
