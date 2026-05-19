# 12 — Acceptance Tests & Definition of Done

## What "done" means at each milestone

A milestone is done when:
1. Every checkbox in `docs/08-BUILD_PLAN.md` for that milestone is checked.
2. All tests in this document for that milestone pass.
3. CI green on `main` after the milestone PR(s) merge.
4. Core team or Lead signs off.

## Test categories

### Unit tests (Vitest)
Per-module, mostly pure functions. Coverage targets:
- `src/crypto/` — ≥90%
- `src/chains/` — ≥85%
- `src/bridge/` — ≥85%
- `src/services/` — ≥75%
- `src/ui/` — ≥60% (focus on logic, not snapshot churn)

### Integration tests (Vitest with mocked RPC)
- Send flows: build → sign → broadcast (broadcast mocked).
- Bridge flows: full state machine transitions with mocked relayer.
- Storage: encryption round-trips, schema migrations.

### Property / fuzz tests (fast-check)
- 10k random mnemonics: derive Pearl + Eth addresses; cross-check against `@scure/btc-signer` + `viem` reference implementations.
- 10k random PRL amounts + UTXO sets: coin selector produces valid tx (sum_inputs ≥ sum_outputs + fee, all outputs > dust).
- 10k random bech32m strings: decoder either decodes correctly or rejects with a typed error (never crashes).

### End-to-end (Playwright on Pearl testnet + Eth Sepolia)
- Full user flows against live testnets.

### Manual / human acceptance (Core team or Lead)
- Onboarding feels right.
- Copy reads well.
- No surprising motion.

## Per-milestone tests

### M1 — Onboarding

**Unit:**
- BIP-39 generate (12 + 24) → entropy bytes correct length, words in BIP-39 wordlist.
- BIP-39 validate: known-good passes, single-word-changed fails.
- BIP-32 derive matches BIP-32 test vectors (RFC).
- BIP-86 derive matches BIP-86 test vectors.
- Bech32m encode/decode round-trip for HRP `prl` + 1000 random 32-byte payloads.
- PBKDF2 + AES-GCM round-trip: encrypt with password X, decrypt with X succeeds; with Y fails with the expected `OperationError`.
- Worker contract: every cmd has a unit test covering happy path + 1 error path.

**E2E:**
- Create wallet flow on a fresh browser: appears in dashboard with PRL = 0, WPRL = 0.
- Restore from a known mnemonic (test fixture) → shows expected address.
- Unlock with wrong password 5 times → lockout banner appears.
- Wipe wallet → dashboard inaccessible → splash shown again.

**Audit-style:**
- Lighthouse Accessibility ≥ 95 on onboarding screens.
- No `console.log` in production bundle (lint rule).

### M2 — Send PRL

**Unit:**
- Coin selection: 100 hand-crafted test cases covering:
  - Exact-fit
  - With change
  - Insufficient funds
  - Dust avoidance
  - Multi-input
  - Single-large-input
- Fee estimation: with mocked `estimatesmartfee` returns, three tiers compute correctly.
- Taproot key-path sign produces valid Schnorr sig per BIP-340 verify.

**Integration:**
- `sendrawtransaction` mocked: tx hex is well-formed PSBT-equivalent.

**E2E (Pearl testnet):**
- Faucet 0.1 PRL → wallet → balance updates.
- Send 0.05 PRL back to faucet → tx confirms → balance decreases by 0.05 + fee.
- Send max → balance = 0, fee subtracted correctly.
- Send to invalid address → input shows error, broadcast blocked.

### M3 — WPRL + Dashboard

**Unit:**
- WPRL `balanceOf` parsing.
- EIP-1559 fee tiers compute correctly given a base fee.
- USD formatting: 100 PRL × $5.20 = "$520.00".

**E2E (Sepolia):**
- Sepolia faucet ETH → wallet shows balance.
- Mint mock WPRL to wallet (via test-only mint) → wallet shows WPRL balance.
- Send 1 WPRL to another test address → tx confirms → balance updates.
- Insufficient ETH for gas → preview blocks send with clear error.

### M4 — Bridge

**Unit:**
- SDI v2 canonical JSON of a fixture matches conformance hash.
- EIP-712 typed data hash matches reference (use viem `hashTypedData` and a known-good fixture).
- Relayer signature recovery matches a known relayer test address.

**Integration:**
- Bridge state machine: all transitions exercised with mocked external state.

**E2E (Pearl testnet ↔ Sepolia):**
- PRL → WPRL 0.05: end-to-end, status updates correctly through each stage, WPRL appears on Sepolia.
- WPRL → PRL 0.05: end-to-end, PRL released to specified address.
- Bridge with daily limit exceeded → blocked at preview with clear error.
- Bridge with relayer mocked-down → status stays at "relayer-signing", banner appears.
- Reload during bridge → status persists, polling resumes.

### M5 — Security hardening

**Audit-style:**
- `securityheaders.com` grade = A+.
- Hardcodes scanner (e.g. `truffleHog`, `gitleaks`) clean.
- `npm audit --omit=dev` clean (0 high, 0 critical).
- All deps pinned exactly (no `^`, `~`, `*`) in production deps — lint via custom script.
- Reproducible build: build twice in clean environments, SHA256 of every artifact identical.
- SRI: every `<script>` in served `index.html` has a matching `integrity` attribute.
- CSP report-only run for 1 week shows no violations in normal use.

**Penetration tests (auditor):**
- XSS attempts: no injection succeeds.
- Phishing simulation: spoofed `pearlwailet.xyz` → user warning helps.
- Address poisoning attempt → wallet flags similar-but-different.
- Clipboard hijack simulated → wallet does NOT auto-fill from clipboard.
- Extension wallet (e.g. MetaMask) simulated → warning shown about another wallet detected.

**Crypto correctness (auditor):**
- 1000 random mnemonics: derived addresses cross-check against reference impls.
- Encryption: known KAT vectors for PBKDF2 + AES-GCM.
- BIP-322 signature verifies against bitcoin-core.

### M6 — Launch

**Operational:**
- DNS resolves correctly from multiple regions (test via `dig @1.1.1.1` and similar).
- TLS A+ on SSL Labs.
- Status page live + accurate.
- Build-info.json matches deployed bundle SHAs.
- Auto-lock fires at configured timeout in long-idle test.
- Mobile Safari + Mobile Chrome smoke test passes (manual + Playwright mobile viewports).

**Lighthouse:**
- Performance ≥ 90
- Accessibility ≥ 95
- Best Practices = 100
- SEO ≥ 90

**Smoke test (manual, by Core team or Lead):**
- Create wallet, receive mainnet PRL from a known source, send 0.01 PRL, bridge 0.01 PRL → WPRL, bridge WPRL → PRL. Whole flow in < 15 min on a phone.

## Regression tests (every PR)

- All unit tests pass.
- Lint clean.
- Typecheck clean.
- Lighthouse CI: no degradation > 5 points from baseline.
- Bundle size: no increase > 10 KB without justification in PR description.
- `npm audit --omit=dev` clean.

## Performance test

Run before each release:
```
ARTILLERY load test against rpc.pearlwallet.xyz:
- Ramp: 0 → 50 req/s over 60s, hold 5 min.
- Mix: 70% getblockchaininfo, 20% listunspent, 10% sendrawtransaction (rejected via mocked node).
- Success criteria: p95 latency < 500ms, error rate < 0.1%.
```

If the proxy can't handle 50 req/s sustained, scale pearld + indexer before launch.

## Security regression — bundle audit

Monthly (post-launch):
- `npm audit --omit=dev`
- `npm outdated` review of every dep
- Manual diff of any minor/major version bumps to crypto-touching deps
- SRI hashes verified to match build artifacts
- DNS + CAA records re-verified
- Cloudflare Pages access logs reviewed for anomalies

## Audit report archival

Every audit (initial M5, plus annual or post-major-version) produces a public PDF stored at:
```
audit/
├── 2026-MM-DD-firm-name-v1.0.0.pdf
├── 2027-MM-DD-firm-name-v1.5.0.pdf
└── ...
```

Linked from `/about` in the wallet and `README.md` of the repo.

## Bug bounty (post-launch)

- Scope: the wallet (web app + RPC proxy + indexer).
- Out of scope: PearlBridge contracts (they have their own bounty), pearld upstream, browsers.
- Severity / payout schedule TBD with the core team; modeled on Immunefi templates.
- Reported via `bridgedev@mailbox.org` PGP-signed or via a secure submission form at `/security`.

## Sunset criteria

We sunset the wallet only if:
- PearlBridge is sunset.
- A clearly better OSS Pearl wallet emerges and the core team blesses migration.
- Active vulnerability we can't patch within a quarter.

If sunset: announce 3 months in advance; export tool for users to extract their data; redirect to chosen replacement.
