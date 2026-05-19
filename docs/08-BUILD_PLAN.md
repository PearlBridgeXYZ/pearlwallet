# 08 — Build Plan

## Team shape (assumed)

A 2-person core build team:
- **Lead engineer** — architecture, crypto, bridge integration, code review.
- **Frontend engineer** — UI, state, UX implementation, accessibility.

Supplemented by:
- **Designer** — Figma wireframes, brand polish. Part-time, ~10 hrs/week.
- **Security auditor** — external firm engaged at M5. ~4 weeks of audit time.

If only 1 engineer is available, double every timebox.

## Timeline (9 weeks calendar to beta launch)

```
Week 1   ████████      M1 — Project scaffold, onboarding, address derivation
Week 2   ████████      M1 (cont.) + design Figma freeze
Week 3   ████████      M2 — Send PRL (testnet) + RPC proxy live
Week 4   ████████      M3 — Send WPRL + dashboard with both balances
Week 5   ████████      M4 — Bridge PRL→WPRL (testnet end-to-end)
Week 6   ████████      M4 — Bridge WPRL→PRL (testnet end-to-end) + status tracker
Week 7   ████████      M5 — Security hardening, audit firm engaged
Week 8   ████████      M5 — Audit fix cycle
Week 9   ████████      M6 — Mainnet beta launch (capped TVL)
```

## Milestones — definition of done

### M1 — Skeleton + onboarding (weeks 1-2)
**Done when:**
- [ ] Repo created, CI green on `main` (lint + typecheck + unit tests + Lighthouse).
- [ ] Vite + React + TS + Tailwind + shadcn boilerplate.
- [ ] Web Worker for crypto wired up with verb-based RPC.
- [ ] BIP-39 generate + restore + validate.
- [ ] BIP-32 / BIP-86 derivation for Pearl, BIP-44 for Eth.
- [ ] Bech32m encode/decode for HRP `prl`.
- [ ] Pearl address derived correctly, verified against `@scure/btc-signer` test vectors.
- [ ] Eth address derived correctly, verified against ethers test vectors.
- [ ] PBKDF2 + AES-GCM keystore encrypt/decrypt round-trip with stored params.
- [ ] IndexedDB schema v1 in place via Dexie.
- [ ] Create wallet → verify mnemonic → set password → see addresses flow works end-to-end.
- [ ] Unlock with password works; wrong password rejects with backoff.
- [ ] All onboarding screens match design.
- [ ] WCAG AA on onboarding screens (axe-core CI check).

**Dependencies for next:** Figma design ready; Pearl testnet RPC proxy provisioned.

### M2 — Send PRL on testnet (week 3)
**Done when:**
- [ ] Pearl RPC proxy live at `https://testnet-rpc.pearlwallet.xyz` proxying to a testnet pearld instance.
- [ ] Esplora-like indexer live at `https://testnet-idx.pearlwallet.xyz`.
- [ ] Wallet shows PRL balance fetched from indexer.
- [ ] Send PRL flow: input → preview → password → broadcast → confirmed.
- [ ] Fee tier picker shows live estimates from `estimatesmartfee`.
- [ ] Coin selection produces valid txs across N edge cases (single UTXO, multiple, dust avoidance, max-send-with-fee).
- [ ] Taproot Schnorr signature validates on chain.
- [ ] Tx appears in history after broadcast.
- [ ] All happy-path tests pass on Pearl testnet.
- [ ] Address book MVP: save/label/use.

### M3 — Send WPRL + combined dashboard (week 4)
**Done when:**
- [ ] viem set up for Eth Sepolia with fallback transport.
- [ ] WPRL contract address loaded from `bridge/contracts.ts`.
- [ ] Wallet shows WPRL balance via `balanceOf`.
- [ ] Dashboard renders both PRL and WPRL with USD-equivalent (CoinGecko or mock if PRL not listed).
- [ ] Send WPRL flow: input → preview → password → broadcast → confirmed.
- [ ] Gas tier picker with live base fee + priority suggestions.
- [ ] Tx history shows both chains, filterable.
- [ ] Receive screen with QR + copy works for both PRL and WPRL.

### M4 — Bridge integration (weeks 5-6)
**Done when:**
- [ ] PearlBridge testnet/Sepolia contract addresses confirmed and loaded.
- [ ] EIP-712 domain & types match PearlBridge spec; signed payload verified against relayer reference.
- [ ] SDI v2 builder produces canonical JSON matching conformance hash `f23284f95d099135c80bf151e3ce3892290b68044d523164403eedd29daf5645`.
- [ ] BIP-322 signature on SDI verifies against PearlBridge relay.
- [ ] PRL → WPRL flow end-to-end on testnet/sepolia: amount → preview (fee disclosure) → sign SDI → broadcast Pearl deposit → poll for confirmations → fetch relayer mint sig → submit mint to Sepolia → confirmed.
- [ ] WPRL → PRL flow end-to-end on Sepolia/testnet: amount → preview → optional approve → burn → poll for relayer release → confirmed.
- [ ] Bridge status tracker persists across reloads.
- [ ] Daily limits / TVL cap pre-flight checks block over-limit attempts cleanly.
- [ ] Failure modes (relayer down, dest gas spike) handled per UX doc.
- [ ] e2e tests for both bridge directions on testnet.

### M5 — Security hardening + audit (weeks 7-8)
**Done when:**
- [ ] CSP, COOP, COEP, X-Frame-Options, Referrer-Policy, Permissions-Policy headers configured in Cloudflare Pages.
- [ ] `securityheaders.com` grade A+.
- [ ] SRI on `index.html` script tags.
- [ ] Reproducible build verified: SHA256 of build artifacts matches between 2 machines.
- [ ] `build-info.json` published with git SHA + asset hashes.
- [ ] `npm audit` clean (no high/critical).
- [ ] All deps pinned exactly (no `^` in production deps).
- [ ] Phishing-defense lookalike domains registered + 301 forwarded.
- [ ] Audit firm engaged (TOB / OZ / Cure53).
- [ ] All audit findings triaged.
- [ ] Critical + high findings resolved.
- [ ] Audit report PDF added to repo (`/audit/2026-MM-DD-firm-name.pdf`).

### M6 — Mainnet beta launch (week 9)
**Done when:**
- [ ] Mainnet contract addresses loaded.
- [ ] Mainnet Pearl RPC proxy live with monitoring.
- [ ] Lighthouse score ≥ 90 Performance, ≥ 95 Accessibility, 100 Best Practices.
- [ ] Status page (`https://status.pearlwallet.xyz`) live, monitoring RPC + relayer + indexer.
- [ ] Launch blog post drafted, audit report linked.
- [ ] Initial bridge TVL cap set conservatively (e.g. $100k mainnet) — adjustable later.
- [ ] G's sign-off recorded.
- [ ] DNS pointing to Cloudflare Pages.

## Audit gate (HARD)

No mainnet bridge integration ships without an external audit. Audit must cover:
- Crypto (mnemonic, derivation, signing, encryption).
- Bridge (SDI build, EIP-712, relayer trust).
- Web sec (CSP, headers, supply chain).
- UX (phishing, address poisoning, irreversibility messaging).

Pre-mainnet checklist:
- [ ] Zero critical findings open.
- [ ] Zero high findings open.
- [ ] All mediums triaged; G signs off on any deferrals.

## Post-launch (out of this plan, but worth noting)

- Week 10-12: monitor, fix issues, iterate.
- v1.5: HD addresses, address book improvements.
- v2: hardware wallet support, browser extension, mobile native.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Pearl coin type / derivation path not finalized | Medium | High (interop breaks) | Resolve in week 1 with Pearl chain leads |
| `@scure/btc-signer` doesn't handle Pearl network params cleanly | Medium | Medium | Fork & maintain a thin Pearl-network-params wrapper |
| Audit firm not available in time | Medium | High | Engage 4 weeks in advance; have backup firm queued |
| PearlBridge mainnet contracts unstable | Low | High | Delay M4 to ride PearlBridge stable tag |
| RPC proxy can't handle launch load | Low | Medium | Load test in M5; oversize Cloudflare Worker / pearld fleet |
| WPRL not yet listed on price oracles | High | Low | Self-hosted oracle.json fallback |
| Domain registration blocked at Namecheap | **Confirmed** | Low | Use Porkbun or CF Registrar instead |

## Cost estimate

| Item | Cost |
|------|------|
| 2 engineers × 9 weeks | (G's call) |
| Designer × ~20 hrs total | (G's call) |
| Security audit (TOB/OZ/Cure53 web-wallet engagement) | $30k - $80k |
| Domain registrations (canonical + 4 defensive) | ~$25/yr |
| small VPS (pearld + esplora) | €10/mo |
| Cloudflare Pages + Worker | Free tier sufficient |
| Cloudflare DNS | Free |
| **Operating cost / yr (excluding labor + audit)** | **~$160/yr** |
