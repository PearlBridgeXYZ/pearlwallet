import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Splash from "../src/ui/pages/Splash";

const wallet = vi.hoisted(() => ({ status: "no-wallet" }));
vi.mock("../src/state/wallet-store", () => ({
  useWallet: (select: (state: typeof wallet) => unknown) => select(wallet),
}));
vi.mock("../src/ui/components/InstallPWA", () => ({ default: () => null }));

function render(status: string, protocol = "https:", standalone = false, iosStandalone = false) {
  wallet.status = status;
  vi.stubGlobal("window", {
    location: { protocol },
    navigator: { standalone: iosStandalone },
    matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" && standalone }),
  });
  return renderToStaticMarkup(createElement(StaticRouter, { location: "/" }, createElement(Splash)));
}

afterEach(() => vi.unstubAllGlobals());

describe("Landing page visitor states", () => {
  it.each([["https:", false], ["https:", true], ["file:", false]])(
    "suppresses marketing and onboarding while initializing (%s, standalone %s)",
    (protocol, standalone) => {
      const html = render("initializing", protocol as string, standalone as boolean);
      expect(html).toContain('role="status"');
      expect(html).not.toMatch(/onboarding|landing-hero|Security reviews|Create wallet/);
    },
  );

  it.each(["locked", "unlocked"])("keeps the existing-wallet fallback for %s", (status) => {
    const html = render(status);
    expect(html).toContain('href="/unlock"');
    expect(html).not.toMatch(/onboarding|landing-hero|Create wallet/);
  });

  it.each([["file:", false], ["https:", true]])("uses compact welcome for %s, standalone %s", (protocol, standalone) => {
    const html = render("no-wallet", protocol as string, standalone as boolean);
    expect(html).toContain('href="/onboarding/create"');
    expect(html).toContain('href="/onboarding/restore"');
    expect(html).toContain("PearlWallet");
    expect(html).not.toMatch(/landing-hero|Security reviews|<details/);
  });

  it("uses compact welcome for an iOS home-screen PWA when matchMedia reports false", () => {
    const html = render("no-wallet", "https:", false, true);
    expect(html).toContain('href="/onboarding/create"');
    expect(html).toContain('href="/onboarding/restore"');
    expect(html).toContain("PearlWallet");
    expect(html).not.toMatch(/landing-hero|<details/);
  });

  it("keeps the simple hero and one-click guide with accurate disclosures and destinations", () => {
    const html = render("no-wallet");
    expect(html).toContain('href="/onboarding/create"');
    expect(html).toContain('href="/onboarding/restore"');
    expect(html).toContain('href="https://github.com/PearlBridgeXYZ/pearlwallet/releases/latest"');
    expect(html).toContain('href="https://github.com/PearlBridgeXYZ/pearlwallet"');
    expect(html).toContain('href="https://pearlbridge.xyz/audit"');
    expect(html.match(/<article>/g)).toHaveLength(6);
    expect(html.match(/<details(?: class="landing-about")?>/g)).toHaveLength(8);
    expect(html).toContain('<details class="landing-about"><summary>about / FAQ</summary>');
    expect(html).toContain('aria-label="Create wallet"');
    expect(html).toContain('aria-label="Import wallet"');
    expect(html).toContain('class="ascii-pearl" aria-hidden="true"');
    expect(html).toContain("your keys stay in your browser.");
    expect(html).toContain("No paid third-party audit has taken place yet.");
    expect(html).toContain("AI-assisted multi-model reviews");
    expect(html).toContain("36 public review reports");
    expect(html).toContain("a flat 1 PRL on sends of 1 to 1,000 PRL, and 0.1% above 1,000 PRL");
    expect(html).toContain("you can turn it off for any send or in Settings.");
    expect(html).toContain("Experimental, pre-1.0");
    expect(html).not.toMatch(/BTX|trustless|reproducible builds|MIT licensed/i);
  });
});
