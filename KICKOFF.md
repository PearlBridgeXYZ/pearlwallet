# KICKOFF — Pearl Web Wallet

One-page TL;DR for the build team. Read this, then read `README.md`.

## What
A non-custodial browser wallet at `wallet.pearlbridge.xyz` for retail PRL holders. Holds PRL (Pearl L1) and WPRL (Ethereum ERC-20), bridges between them natively via PearlBridge.

## Constraints (non-negotiable)
- **Non-custodial.** Keys never leave the browser.
- **Pure web.** Single-page app. No backend that handles keys.
- **Retail.** Not for institutions, miners, or power users (v1).
- **Native bridge.** PearlBridge integrated inline, not via redirect.

## Stack
React 18 + Vite + TS + Tailwind + shadcn. viem for Eth. @noble/curves + @scure/btc-signer for Pearl. Dexie for encrypted IndexedDB storage. Web Worker for all crypto.

## Hosting
Cloudflare Pages SPA + Cloudflare Worker RPC proxy + small VPS for pearld/esplora indexer.

## Timeline
9 weeks to mainnet beta. Audit gate at week 7.

## Repo
`PearlBridgeXYZ/pearlwallet` (private until first audit).

## First steps for the team

**Day 1:**
1. Read `README.md` and `docs/11-OPEN_QUESTIONS.md`.
2. Get answers to **Q1** (SLIP-44 coin type) and **Q2** (testnet HRP) from the Pearl chain leads.
3. Stand up the repo with the boilerplate described in `docs/02-ARCHITECTURE.md`.
4. Provision a small VPS for testnet pearld + esplora.

**Week 1:**
- Onboarding screens (create / restore / unlock) implemented per `docs/04-UX.md`.
- Web Worker with verb-based RPC scaffolded per `docs/06-CRYPTO.md`.
- BIP-39/32/86 derivation + Pearl bech32m address gen working with test vectors.

**Audit firm:** start procurement TODAY. 4-week lead time for TOB / Cure53.

## Who to contact
- **Product / approvals:** PearlBridge core team.
- **Infra / context:** Bridge Developer (`bridgedev@mailbox.org`).
- **PearlBridge contracts / relayer:** PearlBridge team (Bridge Developer can route).

## Definition of "good"
You'd put your own keys in it. If you wouldn't, fix the thing that scares you before shipping.
