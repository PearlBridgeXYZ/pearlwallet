#!/usr/bin/env node
// Builds the single-file offline HTML.
//
//   1. Run `vite build --config vite.config.offline.ts` (already done
//      by the caller) which emits dist-offline/index.html, a single
//      JS chunk in dist-offline/assets/, a single CSS file, and the
//      static public/ files (favicons, manifest, iframe-bust.js,
//      _headers).
//
//   2. This script reads dist-offline/index.html and folds every
//      external asset reference into the document:
//        - <script src="/assets/index.js"> → inline <script type=module>
//        - <link rel=stylesheet href="/assets/index.css"> → inline <style>
//        - <script src="/iframe-bust.js"> → inline <script>
//        - <link rel=icon href="/favicon-32.png"> → data: URI
//        - <link rel=apple-touch-icon href="/logo-192.png"> → data: URI
//        - <link rel=manifest> → dropped (no remote fetch under file://)
//
//      The CSP <meta> is also rewritten:
//        - `script-src 'self'` → `script-src 'self' 'unsafe-inline'`
//          (the inlined scripts are part of the same signed file — the
//          file's integrity IS the trust root)
//        - `connect-src` keeps the original HTTPS allowlist so the user
//          can opt into live balance/activity from file:// if they
//          want; otherwise the wallet degrades gracefully.
//
//   3. Result is written to
//      dist-offline/pearlwallet-offline-vX.Y.Z.html — a single file
//      the user can scp to an air-gapped machine.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist-offline");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;

function readAsset(rel) {
  return readFileSync(resolve(dist, rel.replace(/^\//, "")));
}

function readAssetText(rel) {
  return readAsset(rel).toString("utf8");
}

function dataUri(rel) {
  const ext = extname(rel).toLowerCase();
  const mime = ext === ".png" ? "image/png"
    : ext === ".svg" ? "image/svg+xml"
    : ext === ".ico" ? "image/x-icon"
    : "application/octet-stream";
  const b64 = readAsset(rel).toString("base64");
  return `data:${mime};base64,${b64}`;
}

let html = readAssetText("index.html");

// 1. Inline the main JS chunk.
//    Match either /assets/index.js or assets/index.js (Vite emits the
//    leading slash on absolute paths). We capture the whole <script>
//    tag — including any `type=module`, `crossorigin`, etc. attrs.
html = html.replace(
  /<script[^>]*\bsrc=["']\/?(assets\/[^"']+\.js)["'][^>]*><\/script>/g,
  (_m, p1) => {
    const code = readAssetText(p1);
    // Strip the inline source-map comment if present (no map is shipped).
    const clean = code.replace(/\n?\/\/# sourceMappingURL=[^\n]*$/m, "");
    return `<script type="module">\n${clean}\n</script>`;
  },
);

// 2. Inline the main CSS bundle.
html = html.replace(
  /<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']\/?(assets\/[^"']+\.css)["'][^>]*>/g,
  (_m, p1) => `<style>\n${readAssetText(p1)}\n</style>`,
);

// 3. Inline iframe-bust.js. Vite copies this from public/ into the
//    dist root unchanged. It MUST run before the React entry — keep
//    the same source order the original index.html had.
html = html.replace(
  /<script[^>]*\bsrc=["']\/?(iframe-bust\.js)["'][^>]*><\/script>/g,
  (_m, p1) => `<script>\n${readAssetText(p1)}\n</script>`,
);

// 4. Convert favicons / touch icons to data: URIs so the offline file
//    has no remote favicon fetches.
html = html.replace(
  /<link([^>]*\bhref=)["']\/?([^"']*\.(?:png|ico|svg))["']([^>]*)>/g,
  (_m, before, file, after) => `<link${before}"${dataUri(file)}"${after}>`,
);

// 5. Drop the manifest reference — manifest+icons would need to be a
//    real URL for PWA install to work; under file:// it's a no-op
//    that just generates a spurious 404 in the DevTools console.
html = html.replace(
  /<link[^>]*\brel=["']manifest["'][^>]*>\s*/g,
  "",
);

// 5b. Drop apple-touch-icon links. file:// browsers can't install the
//     PWA anyway, and inlining the 512×512 PNG as a data URI bloated
//     the offline file by ~290 kB without changing user behaviour at
//     all. The favicon-32/64 references stay — those DO render in the
//     browser tab.
html = html.replace(
  /<link[^>]*\brel=["']apple-touch-icon["'][^>]*>\s*/g,
  "",
);

// 6. Relax the inline-script CSP. The web build forbids inline scripts
//    (defense against XSS); the offline file IS one self-contained
//    document the user audited and saved, so inline is the only way
//    the bundle can execute under file://. We keep every OTHER CSP
//    directive — connect-src allowlist still gates remote calls,
//    object-src 'none' still blocks plugins, etc.
html = html.replace(
  /script-src 'self'/,
  "script-src 'self' 'unsafe-inline'",
);
// Vite's `?worker&inline` builds a Blob-URL worker first and falls
// back to a `data:text/javascript;base64,...` URL if Blob URLs are
// blocked. Under the default CSP `worker-src 'self' blob:` the
// fallback path would be blocked — keep `data:` allowed so the
// fallback works in browsers/contexts that reject the Blob path.
html = html.replace(
  /worker-src 'self' blob:/,
  "worker-src 'self' blob: data:",
);

// 7. Stamp a comment with version + build sha so a downloaded file is
//    self-identifying without opening DevTools.
const stamp = `<!--\n  PearlWallet offline single-file build · v${version}\n  Built: ${new Date().toISOString()}\n  Source: github.com/PearlBridgeXYZ/pearlwallet\n-->\n`;
html = stamp + html;

const outName = `pearlwallet-offline-v${version}.html`;
const outPath = resolve(dist, outName);
writeFileSync(outPath, html);

const sizeKB = Math.round(statSync(outPath).size / 1024);
console.log(`offline build → dist-offline/${outName} (${sizeKB} kB)`);

// Sanity: confirm no /assets/ or root-relative references survived.
// A leftover `<script src="/assets/...">` would silently 404 under
// file:// and the wallet would never mount.
const dangling = html.match(/(?:href|src)=["']\/(?!\/)[^"']+/g);
if (dangling) {
  console.error("offline build: dangling absolute refs:", dangling);
  process.exit(1);
}

// Also confirm the document is in fact self-contained — no http(s)://
// asset references, only data: URIs and same-document inline content.
const remote = html.match(/(?:href|src)=["']https?:\/\/[^"']+\.(?:js|css|png|ico|svg)["']/g);
if (remote) {
  console.error("offline build: remote asset refs:", remote);
  process.exit(1);
}

// Quick directory listing — surface anything beyond the single HTML
// so a future contributor remembers the file is what gets uploaded.
const extra = readdirSync(dist).filter((f) => f !== outName);
if (extra.length) {
  console.log(`(other files in dist-offline/ — not part of the release: ${extra.join(", ")})`);
}
