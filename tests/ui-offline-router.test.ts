// Offline single-file build runs from file://. BrowserRouter there redirects
// to "/" via history.replaceState(…, "file:///") and the browser throws
// SecurityError (blank page). The app picks HashRouter at runtime only for
// file://, so the web build keeps path URLs (/vault/tx/<token> links).
// Also guards against root-absolute asset paths in JSX/CSS, which the
// offline inliner cannot rewrite.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { routerKindFor } from "../src/lib/router-kind";

const ROOT = join(__dirname, "..");

describe("routerKindFor", () => {
  it("uses the hash router only under file://", () => {
    expect(routerKindFor("file:")).toBe("hash");
    expect(routerKindFor("https:")).toBe("browser");
    expect(routerKindFor("http:")).toBe("browser");
    expect(routerKindFor("")).toBe("browser");
  });

  it("main.tsx wires the runtime choice to HashRouter / BrowserRouter", () => {
    const main = readFileSync(join(ROOT, "src/main.tsx"), "utf8");
    expect(main).toMatch(
      /routerKindFor\(window\.location\.protocol\) === "hash" \? HashRouter : BrowserRouter/,
    );
    expect(main).toMatch(/<Router>\s*<App \/>\s*<\/Router>/);
  });
});

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

describe("no root-absolute asset paths in the bundle source", () => {
  it("JSX src/href and CSS url() are relative or imported", () => {
    const bad: string[] = [];
    for (const f of walk(join(ROOT, "src"), [".tsx", ".css"])) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\b(?:src|href)=["']\/(?!\/)/.test(line) || /url\(\s*["']?\/(?!\/)/.test(line)) {
            bad.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(bad).toEqual([]);
  });
});
