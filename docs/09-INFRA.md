# 09 — Infrastructure & Deployment

## Hosting topology

```
            ┌───────────────────────────────────┐
            │ Cloudflare DNS                    │
            │ wallet.pearlbridge.xyz (A/AAAA → CF)     │
            │ prlwallet.xyz (CNAME → canonical) │
            └─────────────┬─────────────────────┘
                          │
            ┌─────────────▼─────────────────────┐
            │ Cloudflare Pages                  │
            │ • Serves static SPA bundle        │
            │ • CSP/COOP/COEP/etc headers       │
            │ • Custom domain wallet.pearlbridge.xyz   │
            │ • Build = github → CF on tag      │
            └─────────────┬─────────────────────┘
                          │
   ┌──────────────────────┼────────────────────────┐
   │                      │                        │
   ▼                      ▼                        ▼
┌──────────┐    ┌─────────────────┐    ┌─────────────────────┐
│ Public   │    │ rpc.pearlwallet │    │ idx.wallet.pearlbridge.xyz │
│ Eth RPCs │    │ .xyz            │    │ (esplora)           │
│ (no auth)│    │ (Cloudflare     │    │ (small VPS)         │
└──────────┘    │  Worker)        │    └─────────┬───────────┘
                └────────┬────────┘              │
                         │                       │
                         ▼                       ▼
                  ┌──────────────────────────────────┐
                  │ Small VPS                         │
                  │  • pearld (mainnet)              │
                  │  • esplora indexer               │
                  │  • Watchtower / restart policy   │
                  └──────────────────────────────────┘
```

## Hosting choice

**Cloudflare Pages** for the static SPA:
- Free, fast CDN globally.
- Custom headers via `_headers` file.
- Atomic deploys from GitHub Action.
- Preview deploys per PR (auth-gated).

**Cloudflare Worker** for `rpc.pearlbridge.xyz`:
- Edge proxy = fast.
- Free tier easily handles wallet load.
- Easy method allowlist + rate limit.

**Small VPS** (~€10/mo) for pearld + esplora:
- Geographic redundancy: a second small VPS in another region as failover (~€10/mo).

**Status page** at `status.wallet.pearlbridge.xyz`: a simple static page reading from a JSON file updated by a healthcheck cron. Or use `instatus.com` free tier.

## DNS records

```
;; wallet.pearlbridge.xyz
@                       A      → Cloudflare IPs (via CF proxy ON)
@                       AAAA   → Cloudflare IPs (via CF proxy ON)
www                     CNAME  → wallet.pearlbridge.xyz (CF proxy ON)
rpc                     A      → CF Worker (via CF proxy ON)
idx                     A      → indexer VPS IP (CF proxy ON)
testnet-rpc             A      → CF Worker (testnet)
testnet-idx             A      → testnet indexer VPS (CF proxy ON)
status                  CNAME  → instatus or static page (CF proxy ON)

;; CAA: only Let's Encrypt + Google Trust Services allowed
@                       CAA    0 issue "letsencrypt.org"
@                       CAA    0 issue "pki.goog"
@                       CAA    0 iodef "mailto:bridgedev@mailbox.org"

;; SPF / DMARC (no email from this domain)
@                       TXT    "v=spf1 -all"
_dmarc                  TXT    "v=DMARC1; p=reject; rua=mailto:bridgedev@mailbox.org"

;; prlwallet.xyz
@                       A      → Cloudflare IPs (with Page Rule: 301 → wallet.pearlbridge.xyz)
www                     CNAME  → prlwallet.xyz
```

## HTTP headers (Cloudflare Pages `_headers`)

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'sha256-...'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://rpc.pearlbridge.xyz https://idx.wallet.pearlbridge.xyz https://ethereum-rpc.publicnode.com https://eth.drpc.org https://api.coingecko.com https://api.etherscan.io; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  Cache-Control: public, max-age=300, must-revalidate

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/build-info.json
  Cache-Control: public, max-age=60
```

Adjust `script-src` if Vite emits a small inline runtime; prefer `sha256-...` hash over `'unsafe-inline'`.

## Build-info.json

Published at `/build-info.json`:
```json
{
  "version": "1.0.0",
  "gitSha": "abc1234...",
  "buildTime": "2026-08-15T12:34:56Z",
  "assets": {
    "index.html":  "sha256-XXXX",
    "assets/main-abc123.js": "sha256-YYYY",
    "assets/main-abc123.css": "sha256-ZZZZ"
  },
  "auditReport": "https://github.com/.../audits/2026-08-foo.pdf"
}
```

A user (or a third-party watcher) can `curl https://wallet.pearlbridge.xyz/build-info.json` and verify it matches what they expected for a tagged release.

## CI/CD (GitHub Actions)

### On PR
```yaml
name: PR Checks
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:unit
      - run: npm run build
      - run: npm run test:e2e:headless
      - run: npm audit --omit=dev
      - name: Lighthouse CI
        run: npm run lighthouse-ci
```

### On tag (deploy)
```yaml
name: Deploy
on:
  push:
    tags: [ 'v*.*.*' ]
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - name: Generate build-info.json
        run: node scripts/build-info.mjs > dist/build-info.json
      - name: Verify reproducible build (optional second run)
        run: |
          mv dist dist-1
          npm run build
          diff -r dist dist-1
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN_PAGES_DEPLOY }}
          command: pages deploy dist --project-name=pearl-web-wallet
```

### Secrets policy
- `CF_API_TOKEN_PAGES_DEPLOY` — scoped to ONLY pearl-web-wallet Pages project. No DNS write, no Worker write, no other Pages projects.
- Rotated quarterly.
- Stored in vault `APIs/Cloudflare - Pearl Wallet Deploy`.

## Branch protection

On `main`:
- 2 approving reviews required.
- Signed commits required.
- All status checks must pass.
- No force push.
- Branch deletion disabled.
- Linear history (squash or rebase only).

## Monitoring

### Wallet status page
At `status.wallet.pearlbridge.xyz`. Reads JSON updated by a cron on the indexer VPS:
- Pearl RPC health (last successful `getblockchaininfo` < 60s ago)
- Pearl indexer health
- Eth RPC health (both endpoints)
- PearlBridge relayer reachable
- Bundle hash matches latest tagged release

### Alerts
- Pearl RPC down 5min → Telegram alert via existing `tg-send-logged.sh` wrapper.
- Bundle hash drift → CRITICAL alert (possible compromise).
- npm audit high/critical opened on a dep → notice via Renovate PR notifications.

### Privacy
- No third-party analytics.
- Cloudflare's edge analytics (server-side only, no JS, no cookies) — acceptable.
- Errors caught client-side go to a self-hosted endpoint behind opt-in toggle (default OFF). Never auto-collect.

## Backup & recovery

- Repo on GitHub (primary) + mirrored to a private gitea/forgejo on the indexer VPS (warm backup).
- Built artifacts retained for last 50 tags in Cloudflare Pages.
- pearld data dirs snapshotted nightly to provider backup storage.
- Deployment config (Cloudflare Worker source, DNS zone file, Pages settings) in repo under `infra/` so it's recoverable from git alone.

## Disaster recovery

| Scenario | Recovery |
|----------|----------|
| Cloudflare Pages outage | Worst-case 1-2hr; users can't reach wallet. Funds safe. |
| Cloudflare account compromised | Out-of-band recovery; could push malicious bundle. Mitigation: branch protection + signed commits + 2FA on CF account + bundle-hash watcher. |
| Primary pearld dies | Failover to second pearld in another region; restart via systemd. |
| Custom domain hijacked | DNSSEC + CAA make this hard. If it happens: users on stale DNS may sign into attacker page; warn via Telegram + Twitter announcement. |
| Audit firm goes bankrupt mid-engagement | Hand over to backup firm (queued in advance). |
| WPRL contract hack | Wallet UX shows safe-mode banner; bridge button disabled. Doesn't affect user PRL on Pearl L1. |
| Pearl L1 chain halt | Wallet shows degraded banner; bridge button disabled. |

## Self-hosting story

The wallet is open source and a power user can self-host:
- `npm install && npm run build` produces a `dist/` they can serve from anywhere.
- They can run their own pearld + esplora + RPC proxy.
- They can fork and remove our brand if they want.

This is a **first-class commitment**, not an afterthought. Documented in `README.md` of the public repo.
