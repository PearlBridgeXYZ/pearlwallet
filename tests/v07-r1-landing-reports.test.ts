// v0.7 R1 FX8 (Sonnet I8): the landing page says the published review
// reports cover v0.1.0 through v0.4.3. The reviewer read the earliest
// version off the file names (v0.1.5); the earliest report,
// AUDIT-2026-05-19.md, is titled "PearlWallet v0.1.0 ...", so the claim is
// accurate. This pins the claim to the files: a report added, removed or
// renamed must update the copy too.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const reports = readdirSync(".").filter((f) => /^AUDIT-.*\.md$/.test(f));
const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
const versionOf = (f: string): number[] | null => {
  const m = f.match(/^AUDIT-v(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

describe("FX8 — landing review-report claims match the reports in the repo", () => {
  it("36 reports, v0.1.0 (AUDIT-2026-05-19) through v0.4.3", () => {
    expect(reports).toHaveLength(36);
    expect(readFileSync("AUDIT-2026-05-19.md", "utf8").split("\n")[0]).toBe("# PearlWallet v0.1.0 Security & Quality Audit");
    const versions = reports.map(versionOf).filter((v): v is number[] => v !== null).sort(cmp);
    expect(versions.at(-1)).toEqual([0, 4, 3]);
    const page = readFileSync("src/ui/pages/landing/LandingPage.tsx", "utf8");
    expect(page).toContain("36 public review reports covering v0.1.0 through v0.4.3");
    expect(page).toContain("36 public review reports cover v0.1.0 through v0.4.3");
    expect(page).toContain("AI-assisted · v0.1.0–v0.4.3");
  });
});
