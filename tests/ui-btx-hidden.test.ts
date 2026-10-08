// BTX front end is switched off at build time (src/lib/features.ts), backend
// kept. These tests pin that:
//   1. the switch is off;
//   2. /send/btx resolves to /dashboard (pure decision, like
//      tests/v024-route-guard.test.ts does for routeGuardTarget);
//   3. the crypto worker refuses BTX derivation/signing (E_BTX_DISABLED) —
//      checked through the real worker dispatch, before any session check;
//   4. no user-visible BTX / post-quantum copy survives in the UI source
//      outside blocks gated on the switch (pragmatic source scan: vitest runs
//      in node, nothing renders).
//
// If BTX is deliberately re-enabled, flip BTX_UI_ENABLED and update (1).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  BTX_UI_ENABLED,
  btxRouteTarget,
  btxSurfaceOn,
  assertBtxUiEnabled,
} from "../src/lib/features";

const ROOT = join(__dirname, "..");

describe("BTX build switch", () => {
  it("is off", () => {
    expect(BTX_UI_ENABLED).toBe(false);
  });

  it("btxSurfaceOn requires both the switch and the user toggle", () => {
    expect(btxSurfaceOn(true)).toBe(false); // switch off wins over stored toggle
    expect(btxSurfaceOn(false)).toBe(false);
    expect(btxSurfaceOn(true, true)).toBe(true);
    expect(btxSurfaceOn(false, true)).toBe(false);
    expect(btxSurfaceOn(true, false)).toBe(false);
  });
});

describe("btxRouteTarget", () => {
  it("sends /send/btx to /dashboard with the switch off, whatever the toggle", () => {
    expect(btxRouteTarget("/send/btx")).toBe("/dashboard");
    expect(btxRouteTarget("/send/btx", true)).toBe("/dashboard");
    expect(btxRouteTarget("/send/btx", false)).toBe("/dashboard");
  });

  it("sends /send/btx to /dashboard when the user toggle is off", () => {
    expect(btxRouteTarget("/send/btx", false, true)).toBe("/dashboard");
  });

  it("allows /send/btx only when switch and toggle are both on", () => {
    expect(btxRouteTarget("/send/btx", true, true)).toBeNull();
  });

  it("never redirects non-BTX paths", () => {
    for (const p of [
      "/",
      "/dashboard",
      "/receive",
      "/send/prl",
      "/send/wprl",
      "/send/eth",
      "/send/btx/",
      "/send/btxx",
      "/settings",
      "/vault/tx/abc",
    ]) {
      expect(btxRouteTarget(p)).toBeNull();
      expect(btxRouteTarget(p, false, false)).toBeNull();
    }
  });
});

describe("worker BTX hard stop", () => {
  it("assertBtxUiEnabled throws E_BTX_DISABLED when off", () => {
    expect(() => assertBtxUiEnabled()).toThrow("E_BTX_DISABLED");
    expect(() => assertBtxUiEnabled(false)).toThrow("E_BTX_DISABLED");
    expect(() => assertBtxUiEnabled(true)).not.toThrow();
  });

  type Resp = { id: string; ok: boolean; error?: string };
  const posted: Resp[] = [];
  let dispatch: (ev: { data: unknown; origin: string }) => Promise<void>;

  const g = globalThis as unknown as { self?: unknown };
  const prevSelf = g.self;

  beforeAll(async () => {
    // Minimal worker global so the real module can install its handler
    // (the handler reads `self` at call time, so it stays installed until
    // afterAll).
    const fakeSelf: { location: { origin: string }; postMessage: (m: Resp) => void; onmessage?: unknown } = {
      location: { origin: "" },
      postMessage: (m: Resp) => posted.push(m),
    };
    g.self = fakeSelf;
    await import("../src/crypto/worker");
    dispatch = fakeSelf.onmessage as typeof dispatch;
    expect(typeof dispatch).toBe("function");
  });

  afterAll(() => {
    g.self = prevSelf;
  });

  async function call(data: Record<string, unknown>): Promise<Resp> {
    const before = posted.length;
    await dispatch({ data, origin: "" });
    expect(posted.length).toBe(before + 1);
    return posted[posted.length - 1];
  }

  it("deriveBtx is refused before any session/key work", async () => {
    const r = await call({ id: "d1", cmd: "deriveBtx" });
    expect(r).toEqual({ id: "d1", ok: false, error: "E_BTX_DISABLED" });
  });

  it("signBtxTx is refused before any session/key work", async () => {
    const r = await call({ id: "s1", cmd: "signBtxTx", ins: [], outs: [] });
    expect(r).toEqual({ id: "s1", ok: false, error: "E_BTX_DISABLED" });
  });

  it("other commands still dispatch (control)", async () => {
    const r = await call({ id: "x1", cmd: "deriveAddresses" });
    expect(r).toEqual({ id: "x1", ok: false, error: "E_LOCKED" });
  });
});

// ---- source scan ---------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Drop comments (keeps line structure so hit line numbers stay right). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

/**
 * Blank out every JSX expression gated on the BTX switch:
 * `{BTX_UI_ENABLED && …}` and `{btxOn && …}` (btxOn = switch && toggle).
 */
function stripGated(src: string): string {
  const re = /\{\s*(?:BTX_UI_ENABLED|btxOn)\s*&&/g;
  let out = src;
  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(out);
    if (!m) return out;
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < out.length; i++) {
      const c = out[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) throw new Error("unbalanced gated block");
    const blank = out.slice(m.index, end + 1).replace(/[^\n]/g, " ");
    out = out.slice(0, m.index) + blank + out.slice(end + 1);
  }
}

const VISIBLE = [/\bBTX\b/, /post-quantum/i, /\bbtx1/i, /ML-DSA|SLH-DSA|\bP2MR\b/];

function hits(src: string): string[] {
  const found: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (VISIBLE.some((re) => re.test(line))) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

// Pages/components that only mount behind the switch.
const BTX_ONLY = new Set(["src/ui/components/BtxCard.tsx", "src/ui/pages/SendBTX.tsx"]);

describe("no user-visible BTX copy with the switch off", () => {
  const files = [join(ROOT, "src/App.tsx"), ...walk(join(ROOT, "src/ui"))]
    .map((f) => relative(ROOT, f))
    .filter((f) => !BTX_ONLY.has(f));

  it("scans a real file set", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("src/ui/pages/Settings.tsx");
  });

  it("scanner is not vacuous: gated Settings/Receive copy is detected before stripping", () => {
    for (const f of ["src/ui/pages/Settings.tsx", "src/ui/pages/Receive.tsx"]) {
      const src = stripComments(readFileSync(join(ROOT, f), "utf8"));
      expect(hits(src).length, f).toBeGreaterThan(0);
    }
  });

  it("every BTX / post-quantum string is inside a gated block", () => {
    const leaks: string[] = [];
    for (const f of files) {
      const src = stripGated(stripComments(readFileSync(join(ROOT, f), "utf8")));
      for (const h of hits(src)) leaks.push(`${f}:${h}`);
    }
    expect(leaks).toEqual([]);
  });

  it("BtxCard renders only inside a gated block", () => {
    for (const f of files) {
      const src = stripGated(stripComments(readFileSync(join(ROOT, f), "utf8")));
      expect(src.includes("<BtxCard"), f).toBe(false);
    }
  });

  it("/send/btx mounts SendBTX only when the switch is on", () => {
    const app = stripComments(readFileSync(join(ROOT, "src/App.tsx"), "utf8"));
    expect(app).toMatch(
      /path="\/send\/btx"\s*element=\{BTX_UI_ENABLED \? <SendBTX \/> : <Navigate to="\/dashboard" replace \/>\}/,
    );
    expect(app.match(/<SendBTX\b/g)?.length).toBe(1);
  });
});
