#!/usr/bin/env node
// Sync src/build-info.ts's BUILD_VERSION constant with package.json's
// version field. Runs as a prebuild step so the bundle always reflects
// the version a publisher just bumped, without requiring two manual edits.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`bad version in package.json: ${JSON.stringify(version)}`);
}

const buildInfoPath = resolve(root, "src/build-info.ts");
const src = readFileSync(buildInfoPath, "utf8");
const out = src.replace(
  /export const BUILD_VERSION = "[^"]*";/,
  `export const BUILD_VERSION = "${version}";`,
);
if (out === src) {
  // No replacement made — fail loud rather than ship an out-of-date string.
  if (!src.includes(`export const BUILD_VERSION = "${version}"`)) {
    throw new Error("sync-version: BUILD_VERSION declaration not found in build-info.ts");
  }
}
writeFileSync(buildInfoPath, out);
console.log(`build-info.ts: BUILD_VERSION → ${version}`);
