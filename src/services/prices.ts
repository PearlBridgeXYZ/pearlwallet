// PRL/USDC indicative price from the Pearl OTC orderbook.
//
// The OTC API (api.pearl-otc.com/offers) is the only public price
// source for PRL right now — there is no centralised oracle. We pull
// the active SELL_PRL asks and compute:
//   - >=3 asks: quantity-weighted median (vwap_median) — robust to
//     a single stale lowball offer.
//   - 1–2 asks: lowest ask (thin book; consumer should display a
//     "thin book" warning if surfaced).
//   - 0 asks: throws — caller should treat as unpriced.
//
// CORS: api.pearl-otc.com only allows pearl-otc.com origins, so a
// CF Pages Function at /api/prl-price proxies + computes server-side
// and returns just the number. This keeps the wallet's CSP narrow
// (no extra connect-src) and means the proxy can cache/rate-limit.
//
// In dev (`vite dev`) the same path 404s — tests stub fetch directly.

export interface PrlPrice {
  usdPerPrl: number;
  source: "vwap_median" | "lowest_ask";
  nActiveAsks: number;
}

interface PriceProxyResponse {
  usd_per_prl: number;
  source: "vwap_median" | "lowest_ask";
  n_active_asks: number;
}

export async function fetchPrlPrice(): Promise<PrlPrice> {
  const res = await fetch("/api/prl-price", {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`price http ${res.status}`);
  const body = (await res.json()) as PriceProxyResponse;
  if (typeof body.usd_per_prl !== "number" || !isFinite(body.usd_per_prl) || body.usd_per_prl <= 0) {
    throw new Error("price: invalid response");
  }
  return {
    usdPerPrl: body.usd_per_prl,
    source: body.source,
    nActiveAsks: body.n_active_asks,
  };
}

export async function fetchPrlPriceUsd(): Promise<number> {
  const p = await fetchPrlPrice();
  return p.usdPerPrl;
}
