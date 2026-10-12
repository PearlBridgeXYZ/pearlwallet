// FZ7: every description of the developer tip says the same thing as
// computeTipGrains, and the review screen shows the tip as a share of
// the send (100% of a 1 PRL send, not "0.1%").
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeTipGrains, tipPercentOfSend, TIP_POLICY_TEXT } from "../src/chains/pearl/tip";

const PRL = 100_000_000n;
const ROOT = join(__dirname, "..");

describe("tip policy text matches computeTipGrains", () => {
  it.each([
    [PRL / 2n, 0n],
    [PRL, PRL],
    [10n * PRL, PRL],
    [999n * PRL, PRL],
    [1000n * PRL, PRL],
    [1001n * PRL, (1001n * PRL) / 1000n],
    [5000n * PRL, 5n * PRL],
  ])("amount %s grains -> tip %s grains", (amount, tip) => {
    expect(computeTipGrains(amount)).toBe(tip);
  });

  it("states the three bands", () => {
    expect(TIP_POLICY_TEXT).toBe(
      "No tip on sends under 1 PRL, a flat 1 PRL on sends of 1 to 1,000 PRL, and 0.1% above 1,000 PRL.",
    );
  });

  // Every file under src/ui (and the README), not a hand-picked list: a
  // page that describes the tip on its own drifts from computeTipGrains.
  const uiFiles = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? uiFiles(join(dir, d.name)) : /\.(tsx?|md)$/.test(d.name) ? [join(dir, d.name)] : [],
    );
  const STALE = [/0\.1 ?%[^"`]{0,20}min/i, /minimum[^.]{0,60}1 PRL/i, /max\(10 bps/i];

  it("no file under src/ui, tip.ts or the README still says '0.1%, min 1 PRL' or 'minimum 1 PRL'", () => {
    const files = [...uiFiles("src/ui"), "src/chains/pearl/tip.ts", "README.md"];
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const re of STALE) expect(src, `${f} ${re}`).not.toMatch(re);
    }
  });

  it("every page that describes the tip uses TIP_POLICY_TEXT", () => {
    for (const f of [
      "src/ui/pages/landing/LandingPage.tsx",
      "src/ui/pages/About.tsx",
      "src/ui/pages/SendPRL.tsx",
      "src/ui/pages/Settings.tsx",
    ]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toContain("TIP_POLICY_TEXT");
    }
  });
});

describe("tipPercentOfSend", () => {
  it.each([
    [PRL, PRL, "100%"],
    [PRL, 10n * PRL, "10%"],
    [PRL, 3n * PRL, "33.33%"],
    [PRL, 1000n * PRL, "0.1%"],
    [5n * PRL, 5000n * PRL, "0.1%"],
    // L6: rounded half-up at the 2 decimals shown, trailing zeros trimmed
    // after rounding (pre-fix: truncated, "66.66%" / "14.28%" / "0.10%").
    [computeTipGrains(PRL + PRL / 2n), PRL + PRL / 2n, "66.67%"], // 1.5 PRL
    [computeTipGrains(7n * PRL), 7n * PRL, "14.29%"], // 7 PRL
    [computeTipGrains(999n * PRL), 999n * PRL, "0.1%"], // 999 PRL: 0.1001%
    [PRL, 8n * PRL, "12.5%"],
    [PRL, 20_000n * PRL, "0.01%"], // 0.005% rounds up
    [0n, PRL, ""],
  ])("tip %s of amount %s -> %s", (tip, amount, pct) => {
    expect(tipPercentOfSend(tip, amount)).toBe(pct);
  });
});
