# Audit — v0.1.17 (single-pass focused reaudit)

**Auditor:** Opus 4.7 (single pass).
**Date:** 2026-05-20.
**Scope:** v0.1.16 → v0.1.17 diff. Adjacent code in scope only as the
diff touches it. Special section on offline-readiness commissioned by
G this turn.

## What changed

User ask: "What about version 0.1.1 for offline stuff? Can you do a
full audit on that and publish it?" Two deliverables fold into the
same release:

1. **Single-file offline HTML build.** Vite config + post-build inliner
   produces `pearlwallet-offline-vX.Y.Z.html` — one self-contained
   document with the worker baked in as a data URI, CSS inlined,
   favicons as data URIs, runnable from `file://`.
2. **Manifest MIME fix on the nginx mirror.** `manifest.webmanifest`
   was serving as `application/octet-stream` from pearlwallet.xyz,
   which blocked PWA install (Chrome rejects the
   manifest under that MIME). Patched the host's `/etc/nginx/mime.types`
   to register `application/manifest+json` for `webmanifest`. CF Pages
   deploy (when source flips on) already serves it correctly via
   `public/_headers`. Verified `Content-Type: application/manifest+json`
   on both roots after reload.

### Files

- `vite.config.offline.ts` (NEW). Offline-build override. Forces
  worker imports to Vite's `?worker&inline` form (worker bundled as a
  base64 data URI inside the main chunk), `cssCodeSplit: false`,
  `inlineDynamicImports: true`, `assetsInlineLimit: ∞`. Output to
  `dist-offline/`. No new dependencies — built-in Vite features only.
- `scripts/build-offline.mjs` (NEW). Post-build inliner. Reads
  `dist-offline/index.html` and folds the single JS chunk, single CSS
  bundle, `iframe-bust.js`, and the favicons into one HTML document.
  Drops the `<link rel="manifest">` (no remote fetch under file://),
  relaxes CSP `script-src` to allow the inlined script (`'self'
  'unsafe-inline'`), and adds `data:` to `worker-src` so Vite's
  data-URI worker fallback works under strict-CSP browsers. Two
  guardrails before writing: fail if any absolute-path asset
  reference (`<… src="/assets/…">`) survived, and fail if any remote
  asset URL (`https://…(.js|.css|.png|.svg|.ico)`) made it in.
- `package.json`. New `build:offline` script. Version 0.1.16 → 0.1.17.
- `src/ui/pages/About.tsx`. New "Offline / air-gapped use" section
  pointing users at the single-file release. Links to
  `github.com/PearlBridgeXYZ/pearlwallet/releases/latest`.
- (host-side, not in repo) nginx `mime.types` — added
  `application/manifest+json webmanifest;`. Reload verified, both
  pearlwallet.xyz now serves the manifest with the correct
  Content-Type.

## Offline-readiness audit (commissioned)

The wallet's threat model assumes the user may want to run it on a
machine that never touches the network. What's true today:

### Works without network

- **Crypto worker.** All key generation, mnemonic validation, HD
  derivation (Pearl BIP-86 + Eth BIP-44), keystore encrypt/decrypt
  (AES-256-GCM + PBKDF2-600k), and transaction signing happen inside
  the Web Worker on local code. Zero network IO inside the worker.
- **Unlock + auto-lock + lock-while-unlocking races.** State machine
  is local-only.
- **Receive page.** QR generation is local. Copy buttons are local.
- **Address pool display.** Already cached in IndexedDB after first
  unlock — no fetch required to re-render.
- **About / Settings.** Local-only.

### Correctly degrades under network failure

Every external call routes through a `try/catch` and surfaces a
`source: "live" | "partial" | "error"` flag the UI displays as a
warning. Never returns a fabricated value or crashes:

- `services/balances.ts` — pool walk tolerates per-address failures,
  flips to `partial`; whole-walk failure flips to `error`.
- `services/activity.ts` — same pattern; v0.1.14 added 3-attempt 5xx
  retry on transient sentry overload.
- `services/prices.ts` — throws on bad response; balance service
  catches and shows `priceSource: "error"` (USD column empties).
- `services/bridge.ts` (WPRL balance) — `readWprlBalance` error →
  `wprlSource: "error"`.

### Blocked without network (correctly, fails closed)

- **Send composition.** Needs current UTXO set (Pearl) or nonce + base
  fee (Eth). No cached fallback — refusing to compose is the safe
  outcome. UI shows the RPC failure.
- **Tx broadcast.** Must POST to the sentry / Eth RPC. Fails with a
  visible error; the signed tx-hex is preserved in the preview so a
  user could in principle copy it out and broadcast it via a side
  channel.
- **Activity refresh.** Falls back to the cached last-fetch in
  react-query while marked stale.

### What the single-file HTML adds

After the user downloads the single-file build once and audits its
SHA-256:

- The app shell loads from `file://` — no network round-trip to fetch
  HTML, JS, CSS, worker, or favicons.
- Key generation and derivation work fully offline (verified by static
  inspection: the worker payload contains the BIP-39 wordlist, the
  derivation constants, and the address encoder; the data URI is 235
  kB base64 = 176 kB of worker code, including bip39, hd, and pearl-
  address code).
- CSP keeps `connect-src` allowlist active — if the user later goes
  online, balance/activity will populate against the configured RPCs.
- CSP keeps `object-src 'none'`, `frame-ancestors 'none'` (well —
  meta tags can't set frame-ancestors, but the iframe-bust script is
  inlined first and still self-aborts under embedding), `style-src`
  unchanged. The relaxation is strictly `script-src 'self'
  'unsafe-inline'` and `worker-src += data:`, scoped to enable the
  inlined entry script and Vite's data-URI worker fallback.

## Findings

**0 Critical, 0 High, 0 Medium, 0 new Low.**

### Considered and rejected

- **L (rejected): does relaxing `script-src` to `'unsafe-inline'` in
  the offline file open it to XSS?** XSS requires an untrusted input
  channel injecting a `<script>` into the page. The offline file is a
  static document with no remote XHR-driven HTML insertion; the only
  DOM mutations come from React render of state derived from the
  user's own input (mnemonic, password, address strings) or from
  HTTPS-fetched JSON parsed and rendered as text. No `innerHTML`
  surface accepts attacker-controlled HTML. The CSP relaxation is
  the only way to ship an inlined bundle under file://, and the
  remaining directives (`object-src 'none'`, `default-src 'self'`,
  `connect-src` allowlist, `worker-src` enumerated) preserve the
  meaningful guarantees.

- **L (rejected): could the `data:` worker URL leak the worker source
  to other origins?** Workers spawned from a data URL inherit the
  spawning document's origin (which is `null` under file://). They
  can't be reached cross-origin. The base64 payload itself is
  identical to what ships in the chunked web build at
  `/assets/worker-*.js` — there's no new information disclosed by
  inlining it.

- **L (rejected): does `inlineDynamicImports: true` break the
  ccip-read path used by viem for L2 name resolution?** The web build
  emits a separate `ccip-*.js` chunk for that path; under
  `inlineDynamicImports` it folds back into the main chunk. viem's
  internal `import()` calls get rewritten by Rollup to immediate
  references — same module graph, no runtime fetch. The 597 kB web
  bundle becomes 836 kB offline because of this fold, but that's the
  correct cost for a single-file release.

- **L (rejected): does dropping the `<link rel="manifest">` in the
  offline file regress install-as-PWA UX?** PWA install requires a
  served `start_url` — meaningless under file://. Removing the link
  prevents a spurious "Manifest fetch failed" DevTools warning that
  would otherwise alarm a paranoid user mid-audit. The chunked web
  build retains the manifest.

- **L (rejected): does the worker origin guard (`worker.ts:474`)
  still pass under the data-URI worker?** Yes — already explicitly
  designed for it. The guard accepts `ev.origin === ""` (which is
  what data-URI workers see), AND the exact spawning origin. Comment
  documents the file:// path. No new code needed.

- **L (rejected): could a 918 kB single-file HTML get truncated by a
  user-agent / email client that has a max-size limit?** Out of scope
  for the in-browser load case. As a GitHub release attachment the
  file downloads without re-encoding. If a user emails it to
  themselves they should verify SHA-256 anyway — the offline file's
  whole point is provenance.

- **L (rejected): does the manifest MIME fix on nginx widen any
  attack surface?** No. `application/manifest+json` is the IANA
  registered type for `webmanifest`. `X-Content-Type-Options: nosniff`
  is already set, so the browser respects the explicit type and
  doesn't fall through to MIME sniffing on this resource.

### Carried Highs (status table)

| Finding                                   | Status                  |
| ----------------------------------------- | ----------------------- |
| O1-H-1 (insane baseFee DoS)               | FIXED v0.1.9            |
| O2-H-1 ≡ M2-H-2 (sign-what-you-saw)       | FIXED v0.1.9            |
| O1-H-2 (signature freshness via Eth time) | Open — UX only, deferred|
| O2-H-2 (chainId binding from RPC)         | Open — defense-in-depth |
| M2-H-1 (auto-lock countdown UX)           | FIXED v0.1.5            |

No regression on any of the above.

## Verdict

**Ship.** Adds a real offline-use surface (single-file HTML release
attached to every tag) and fixes a real PWA-install bug (manifest
MIME on nginx mirror). 232/236 tests pass. No new key-handling code,
no signing-path changes — the offline build is the same crypto worker
bytes, just bundled inline.

## Side note — multisig research

G also commissioned a separate multisig research pass this turn. The
report at `RESEARCH-multisig.md` recommends BIP-342 tapscript m-of-n
via `@scure/btc-signer`'s existing `p2tr_ns`/`p2tr_ms` helpers (zero
new deps), offline PSBT coordination Sparrow-style, and Gnosis-Safe
signer mode on the Ethereum side. Out of scope for v0.1.17 but
flagged for v0.2.0 planning.
