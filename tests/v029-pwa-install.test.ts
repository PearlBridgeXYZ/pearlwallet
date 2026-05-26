// v0.2.9: PWA install state machine + manifest + index.html sanity.
//
// Vitest runs in a node environment on this repo (no jsdom dependency
// installed). The detector functions and the manifest/HTML invariants
// can both be tested without a DOM — the detectors gate every browser
// API behind a try/typeof check, so we stub `globalThis.window`,
// `globalThis.document`, `globalThis.navigator`, and `globalThis.matchMedia`
// the same way `tests/v020-eth-toggle.test.ts` polyfills localStorage.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  detectStandalone,
  detectIOS,
  detectFileProtocol,
} from "../src/lib/pwa-install";

const ROOT = resolve(__dirname, "..");

// ── detector stub helpers ───────────────────────────────────────────────

interface WindowLike {
  matchMedia?: (q: string) => { matches: boolean; media: string };
  navigator: Partial<Navigator> & { standalone?: boolean; platform?: string };
  location: { protocol: string };
}

function installWindowStub(stub: Partial<WindowLike>): () => void {
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  const prev = g.window;
  g.window = {
    matchMedia: stub.matchMedia ?? (() => ({ matches: false, media: "" })),
    navigator: stub.navigator ?? { userAgent: "", platform: "" },
    location: stub.location ?? { protocol: "https:" },
  };
  return () => {
    if (had) g.window = prev;
    else delete g.window;
  };
}

// ── detectStandalone ────────────────────────────────────────────────────

describe("detectStandalone", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it("returns true when (display-mode: standalone) matches", () => {
    restore = installWindowStub({
      matchMedia: (q) => ({ matches: q === "(display-mode: standalone)", media: q }),
      navigator: { userAgent: "" },
    });
    expect(detectStandalone()).toBe(true);
  });

  it("returns true when iOS navigator.standalone is true", () => {
    restore = installWindowStub({
      matchMedia: () => ({ matches: false, media: "" }),
      navigator: { userAgent: "iPhone", standalone: true },
    });
    expect(detectStandalone()).toBe(true);
  });

  it("returns false when neither path is set", () => {
    restore = installWindowStub({
      matchMedia: () => ({ matches: false, media: "" }),
      navigator: { userAgent: "" },
    });
    expect(detectStandalone()).toBe(false);
  });

  it("returns false when window is undefined (SSR / node)", () => {
    // No installWindowStub — pristine node env, no window global.
    restore = () => {};
    const g = globalThis as Record<string, unknown>;
    const hadWindow = "window" in g;
    const prev = g.window;
    delete g.window;
    try {
      expect(detectStandalone()).toBe(false);
    } finally {
      if (hadWindow) g.window = prev;
    }
  });

  it("never throws on a partially-broken window", () => {
    restore = installWindowStub({
      // matchMedia missing entirely → forces the try/catch to skip silently
      matchMedia: undefined as unknown as () => { matches: boolean; media: string },
      navigator: { userAgent: "" },
    });
    expect(() => detectStandalone()).not.toThrow();
  });
});

// ── detectIOS ───────────────────────────────────────────────────────────

describe("detectIOS", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  function withUA(userAgent: string, platform = "iPhone", maxTouchPoints = 5) {
    restore = installWindowStub({
      navigator: { userAgent, platform, maxTouchPoints } as Partial<Navigator> & {
        platform: string;
      },
    });
  }

  it("detects iPhone", () => {
    withUA(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    );
    expect(detectIOS()).toBe(true);
  });

  it("detects iPad with explicit iPad UA", () => {
    withUA(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      "iPad",
    );
    expect(detectIOS()).toBe(true);
  });

  it("detects iPad spoofing as Mac (iOS 13+)", () => {
    withUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "MacIntel",
      5,
    );
    expect(detectIOS()).toBe(true);
  });

  it("does NOT flag real Mac desktops (no touch)", () => {
    withUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "MacIntel",
      0,
    );
    expect(detectIOS()).toBe(false);
  });

  it("does NOT flag Android", () => {
    withUA(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
      "Linux armv8l",
      5,
    );
    expect(detectIOS()).toBe(false);
  });

  it("does NOT flag desktop Chrome", () => {
    withUA(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      "Linux x86_64",
      0,
    );
    expect(detectIOS()).toBe(false);
  });
});

// ── detectFileProtocol ──────────────────────────────────────────────────

describe("detectFileProtocol", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it("returns true for file:// origin", () => {
    restore = installWindowStub({
      navigator: { userAgent: "" },
      location: { protocol: "file:" },
    });
    expect(detectFileProtocol()).toBe(true);
  });

  it("returns false for https:// origin", () => {
    restore = installWindowStub({
      navigator: { userAgent: "" },
      location: { protocol: "https:" },
    });
    expect(detectFileProtocol()).toBe(false);
  });

  it("never throws when window is missing", () => {
    expect(() => detectFileProtocol()).not.toThrow();
  });
});

// ── manifest.webmanifest invariants ─────────────────────────────────────

describe("manifest.webmanifest — PWA install requirements", () => {
  const manifestRaw = readFileSync(
    resolve(ROOT, "public/manifest.webmanifest"),
    "utf8",
  );
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

  it("is valid JSON", () => {
    expect(() => JSON.parse(manifestRaw)).not.toThrow();
  });

  it("has the required core PWA fields", () => {
    expect(manifest.name).toBe("PearlWallet");
    expect(manifest.short_name).toBe("PearlWallet");
    expect(typeof manifest.start_url).toBe("string");
    expect(manifest.display).toBe("standalone");
  });

  it("declares a navigation scope at /", () => {
    expect(manifest.scope).toBe("/");
  });

  it("has an orientation hint", () => {
    expect(manifest.orientation).toBe("portrait");
  });

  it("declares lang and dir for accessibility", () => {
    expect(manifest.lang).toBe("en");
    expect(manifest.dir).toBe("ltr");
  });

  it("does not prefer a related native app", () => {
    expect(manifest.prefer_related_applications).toBe(false);
  });

  it("includes both 192 and 512 icons", () => {
    const icons = manifest.icons as Array<Record<string, unknown>>;
    expect(Array.isArray(icons)).toBe(true);
    const sizes = icons.map((i) => i.sizes as string);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("declares at least one maskable icon (Android adaptive icon)", () => {
    const icons = manifest.icons as Array<Record<string, unknown>>;
    const maskable = icons.filter(
      (i) => typeof i.purpose === "string" && i.purpose.includes("maskable"),
    );
    expect(maskable.length).toBeGreaterThanOrEqual(1);
  });

  it("declares hex background_color and theme_color", () => {
    expect(manifest.background_color as string).toMatch(/^#[0-9a-f]{3,8}$/i);
    expect(manifest.theme_color as string).toMatch(/^#[0-9a-f]{3,8}$/i);
  });
});

// ── index.html PWA / mobile meta tags ───────────────────────────────────

describe("index.html — mobile / PWA meta tags", () => {
  const html = readFileSync(resolve(ROOT, "index.html"), "utf8");

  it("has viewport with viewport-fit=cover (notch handling)", () => {
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/);
  });

  it("declares apple-mobile-web-app-capable=yes", () => {
    expect(html).toMatch(
      /<meta name="apple-mobile-web-app-capable" content="yes"/,
    );
  });

  it("declares mobile-web-app-capable=yes (Android alias)", () => {
    expect(html).toMatch(/<meta name="mobile-web-app-capable" content="yes"/);
  });

  it("declares apple-mobile-web-app-title=PearlWallet", () => {
    expect(html).toMatch(
      /<meta name="apple-mobile-web-app-title" content="PearlWallet"/,
    );
  });

  it("disables iOS phone-number auto-linking on digit runs", () => {
    expect(html).toMatch(/<meta name="format-detection" content="telephone=no"/);
  });

  it("links the manifest", () => {
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
  });

  it("ships dual theme-color metas (light + dark)", () => {
    const matches = html.match(
      /<meta name="theme-color"[^>]*media="\(prefers-color-scheme: (?:light|dark)\)"/g,
    );
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(2);
  });

  it("declares both 192 and 512 apple-touch-icons", () => {
    expect(html).toMatch(/<link rel="apple-touch-icon" sizes="192x192"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" sizes="512x512"/);
  });
});
