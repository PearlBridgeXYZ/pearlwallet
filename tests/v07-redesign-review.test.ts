// v0.7 redesign review (gpt-5.6-sol, 25a5675): regression cover for the
// fixes to L3–L5 and for the price function's hop/normal cache split.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import Splash from "../src/ui/pages/Splash";
import { onRequestGet, _resetPriceCacheForTests } from "../functions/api/prl-price";

const wallet = vi.hoisted(() => ({ status: "no-wallet" }));
vi.mock("../src/state/wallet-store", () => ({
  useWallet: (select: (state: typeof wallet) => unknown) => select(wallet),
}));
vi.mock("../src/ui/components/InstallPWA", () => ({ default: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const WARNING = "Experimental, pre-1.0 software. Only store what you can afford to lose.";

describe("redesign review fixes", () => {
  it("L3: the experimental warning is visible beside the onboarding actions, outside the collapsed guide", () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:" },
      navigator: { standalone: false },
      matchMedia: () => ({ matches: false }),
    });
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: "/" }, createElement(Splash)));
    const hero = html.slice(html.indexOf('class="landing-hero"'), html.indexOf("</section>"));
    expect(hero).toContain(`<p class="landing-warning">${WARNING}</p>`);
    expect(hero).not.toContain("<details");
  });

  it("L4: the dashboard says what the USD total covers", () => {
    const src = readFileSync("src/ui/pages/Dashboard.tsx", "utf8");
    expect(src).toContain("PRL + WPRL in USD. ETH for network fees is shown separately.");
  });

  it("L5: the landing canvas pauses offscreen and releases its observers", () => {
    const src = readFileSync("src/ui/pages/landing/AsciiPearl.tsx", "utf8");
    expect(src).toMatch(/new IntersectionObserver/);
    expect(src).toMatch(/if \(document\.hidden \|\| !onScreen\) return;/);
    expect(src).toMatch(/visibility\?\.disconnect\(\)/);
  });

  it("M2: a hop request's answer never serves a normal request, and vice versa (no cache reset between)", async () => {
    _resetPriceCacheForTests();
    const OTC = "https://api.pearl-otc.com/offers";
    const HOSTED = "https://wallet.pearlbridge.xyz/api/prl-price";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === OTC) return new Response("", { status: 404 });
      if (String(url) === HOSTED) return new Response(JSON.stringify({ usd_per_prl: 1.5, source: "coingecko", n_active_asks: 0 }));
      return new Response("", { status: 429 });
    }));
    const hop = () => onRequestGet({ request: new Request("https://next.wallet.pearlbridge.xyz/api/prl-price", { headers: { "x-pearlwallet-price-hop": "1" } }) });
    const normal = () => onRequestGet({ request: new Request("https://next.wallet.pearlbridge.xyz/api/prl-price") });
    expect((await hop()).status).toBe(502);   // hop skips hosted; CoinGecko 429
    expect((await normal()).status).toBe(200); // not served the cached hop error
    expect((await hop()).status).toBe(502);   // not served the cached normal price
    expect((await normal()).status).toBe(200);
  });
});
