# 03 — Threat Model

## Assets we protect

| Asset | Sensitivity | Where it lives |
|-------|-------------|----------------|
| User's BIP-39 mnemonic | **Critical** | Worker memory (when unlocked) + AES-GCM ciphertext in IndexedDB (always) |
| User's derived private keys | **Critical** | Worker memory (when unlocked), never written to disk |
| User's password | **Critical** | Worker memory (during unlock); used to derive KEK via PBKDF2; never stored |
| User's addresses | Medium | Plaintext in IndexedDB, plaintext in UI |
| Address book | Low | Plaintext in IndexedDB |
| Tx history cache | Low | Plaintext in IndexedDB |

## Threats (STRIDE-ish)

### T1. Network attacker reads keys in transit
- **Vector:** Wallet sends keys or signed payloads over insecure channel.
- **Reality:** Keys NEVER leave the browser. Only signed-and-broadcast txs go on the wire.
- **Mitigation:** Code review enforces no `fetch`/`postMessage` carries key bytes. Worker contract is verb-based, not key-based.

### T2. Browser supply-chain compromise (malicious npm dep)
- **Vector:** A transitive dep gets compromised, exfiltrates mnemonic via `fetch` from inside the bundle.
- **Likelihood:** Real. Happened to event-stream, ua-parser-js, etc.
- **Mitigation:**
  - Minimize deps. `@noble`/`@scure` family preferred (dep-free, audited).
  - Lockfile committed, `npm ci` in CI, no caret ranges (`"^"`) in production deps; only pinned versions.
  - `npm audit --omit=dev` runs in CI; high/critical blocks merge.
  - Renovate PRs require manual approval; no auto-merge.
  - **CSP `connect-src` allowlist** limits where the bundle can `fetch` to: own RPC proxy, public Eth RPCs, price oracle. A malicious dep that tries to exfiltrate to `attacker.com` gets blocked by CSP.
  - Sub-Resource Integrity (SRI) on the served `index.html`'s script tags. If the deployed bundle is tampered with post-build, browsers refuse to load it.
  - Reproducible builds + signed bundle hash announced on `pearlwallet.xyz/build-info` so the user (or a watcher) can verify what's served matches the git tag.

### T3. XSS / DOM injection
- **Vector:** A bug lets attacker inject JS that reads worker bridge or hijacks the password field.
- **Mitigation:**
  - React's default escaping. Zero `dangerouslySetInnerHTML`.
  - Strict CSP: `script-src 'self'`, no `'unsafe-inline'`, no `'unsafe-eval'`.
  - No user-controllable content rendered as HTML.
  - Address inputs sanitized (regex match) before display; no rich text anywhere.
  - All form inputs use controlled components.

### T4. Phishing via lookalike domain
- **Vector:** User types `pearlwailet.xyz` or `pearl-wallet.com`, signs a real tx into attacker's clone.
- **Mitigation:**
  - Register obvious lookalikes defensively: `prlwallet.xyz`, `pearlwallet.com`, `pearlwallet.app`, `pearl-wallet.xyz`. All 301 to canonical.
  - Domain monitoring (e.g. dnstwist run weekly via cron) to detect new lookalikes.
  - On-app warning: "Always check the address bar says `pearlwallet.xyz` with the correct TLD before entering your password." Shown on unlock screen.
  - DNS CAA records prevent rogue CA issuance.
  - Optional: register on safelists like MetaMask phishing detector (out of v1 scope).

### T5. Address poisoning / clipboard hijack
- **Vector:** Attacker controls user's clipboard or has poisoned the user's tx history with a similar-looking address; user pastes attacker's address.
- **Mitigation:**
  - Never auto-fill destination from clipboard.
  - When user pastes an address, show first 6 / last 6 chars in large monospace + a derived 4-color identicon. User must check it matches their intent.
  - Address book: user can save trusted addresses with a label; saved addresses show their label in the preview.
  - If the destination is a known bridge address, label it as such.
  - Warn if destination differs from previously-sent address by only a few chars.

### T6. Malicious browser extension reading our DOM
- **Vector:** User has installed a wallet-stealer extension; it reads the unlock password as it's typed.
- **Reality:** This is fundamentally hard to defend against in a browser. Best we can do is detect & warn.
- **Mitigation:**
  - Detect if known wallet extensions are present (`window.ethereum`, `window.bitcoin`, etc.) and warn that *another* wallet is injecting into the page.
  - Don't ask user to type mnemonic into a single text field. Use 12/24 separate inputs, autocomplete=off, paste handled per-word.
  - Document in "How this works" page that browser-level compromise is out of our control. Recommend installing on a clean profile or using a dedicated browser.

### T7. Server-side compromise of pearlwallet.xyz
- **Vector:** Attacker gains push access to GitHub or Cloudflare and ships a malicious bundle.
- **Mitigation:**
  - Branch protection on `main`: 2 approvals + signed commits required.
  - Cloudflare Pages deploys only from a specific branch via GitHub Action with limited scope.
  - GitHub Actions secrets scoped per env; no shared `CF_API_TOKEN` with write access to anything but the wallet project.
  - Published `build-info.json` includes git SHA + SHA256 of every served asset. Optional watcher cron compares served bundle against the published hash and alerts on divergence.
  - Subresource Integrity in `index.html` (served by CF Pages from build output) means even a Cloudflare-side asset swap (without HTML update) breaks loading.

### T8. Side-channel via shared state
- **Vector:** Service Worker caches a signed tx; another tab reads it.
- **Mitigation:**
  - Service Worker scoped narrowly. No keys or signed payloads in SW cache.
  - `crossOriginIsolated` via COOP/COEP headers, so high-precision timers and SharedArrayBuffer are gated.
  - Worker memory is zeroed on lock.

### T9. Bridge relayer compromise
- **Vector:** PearlBridge relayer is compromised; signs malicious mint payloads.
- **Reality:** This is PearlBridge's problem, not the wallet's. Wallet trusts relayer EIP-712 sigs the same way the contract does.
- **Mitigation:**
  - Wallet shows relayer fee + amount before user signs anything user-side.
  - Wallet caps WPRL transfer/mint amounts via the contract's daily limits (visible in UI).
  - Wallet does NOT pre-approve unlimited WPRL allowances; uses exact-amount approve per bridge action.

### T10. RPC injection / fake balance
- **Vector:** Attacker MITMs RPC and reports a fake balance, tricking user into "spending" funds they don't have, or showing zero balance to scare them.
- **Mitigation:**
  - HTTPS pinning where browsers allow (DNS over HTTPS for RPC hostname).
  - Use 2 RPCs for Eth (publicnode + drpc) and cross-check critical reads (balance, gas price) — flag divergence to user.
  - For Pearl, own RPC proxy is the trust root; serve TLS via Let's Encrypt + HSTS + CAA.

### T11. Forgotten password / lost mnemonic
- **Vector:** Not a security threat to the wallet, but a UX/recovery failure.
- **Reality:** Non-custodial = no recovery. Documented bluntly.
- **Mitigation:**
  - During onboarding, force user to type back 4 random words from their 12-word mnemonic before they can proceed.
  - "Skip backup" option requires typing "I understand I will lose my funds if I lose my mnemonic and password" into a confirmation field.
  - In settings, "export mnemonic" reminds the user to write it down somewhere safe.

### T12. Clickjacking
- **Vector:** Wallet loaded in an iframe on attacker's page, attacker overlays UI to trick clicks.
- **Mitigation:**
  - `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`.

### T13. Insufficient entropy
- **Vector:** Browser RNG (`crypto.getRandomValues`) compromised on user's machine — generates predictable mnemonic.
- **Mitigation:**
  - Use WebCrypto `crypto.getRandomValues` (DOM standard, CSPRNG-backed).
  - Optionally mix in user-supplied entropy (mouse movements) for paranoid mode.
  - Refuse to operate if `crypto.subtle` is unavailable (very old browsers).

### T14. Cold-boot / memory-dump after lock
- **Vector:** Attacker dumps browser process memory after lock; finds residual key bytes.
- **Mitigation:**
  - Best-effort `array.fill(0)` on private key buffers after use.
  - Don't store the password anywhere; re-prompt for it on every signature (the unlock step IS the auth).
  - Worker is restarted (terminated + respawned) on lock to free GC-managed memory.

## Out-of-scope threats

- **OS-level keylogger.** We can't help.
- **Physical access to unlocked browser.** Auto-lock helps, but a determined attacker with hands on an unlocked machine wins.
- **State-level adversary doing TLS interception via rogue CA in trust store.** CAA + monitoring help, but ultimate trust is in the user's CA bundle.
- **User loses their mnemonic AND password.** Funds are gone. Non-custodial means non-custodial.

## Audit gate

Before mainnet bridge integration ships, an external audit is required, scoped to:
1. Crypto: mnemonic generation, key derivation, signing paths.
2. Encryption-at-rest: PBKDF2 params, AES-GCM IV usage, key zeroing.
3. Bridge: SDI v2 build, EIP-712 typed-data correctness, relayer trust assumptions.
4. Web security: CSP, headers, supply chain.
5. UX: phishing resistance, address poisoning, copy clarity on irreversibility.

Preferred firms: Trail of Bits, OpenZeppelin, Cure53 (web-focused).

Zero critical and zero high findings open = launch gate. Mediums require core team sign-off.
