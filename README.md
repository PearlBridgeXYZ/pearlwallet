# Pearl Web Wallet

**Status:** Spec only. No code yet.
**Author of spec:** Bridge Developer, 2026-05-17.
**Owner / final say:** PearlBridge core team.

A non-custodial, browser-based wallet for **Pearl L1 (PRL)** retail holders, with **PearlBridge** integration so users can hold/send PRL on Pearl L1 and WPRL on Ethereum, and move between the two without ever leaving the wallet.

## Why this exists

Retail PRL holders today have three options, none of them clean:

1. Use a CLI (`pearld`, sparrow-style desktop wallet) — too technical for most.
2. Leave PRL on an exchange — custody risk, illiquid since few CEXs list it yet.
3. Use an institutional / custodial product — defeats the point.

The Pearl Web Wallet gives a normal person a browser tab where they own their keys, see both PRL and WPRL balances side by side, and bridge between them with one click.

## Audience (single, non-negotiable)

Retail PRL holders. Not institutions. Not miners (we don't surface payout streams). Not power users (no advanced UTXO coin control in v1). Just normal humans who bought or received PRL and want to hold, send, and bridge it.

## Custody model (single, non-negotiable)

**Non-custodial.** Keys are generated, encrypted, stored, and used entirely in the browser. The wallet operator never touches keys, period. There is no recovery service. Lose your mnemonic, lose your funds. This is stated bluntly in onboarding.

## Surface

**Pure web.** Single-page app, served from `pearlwallet.xyz`, installable as a PWA but not packaged as a browser extension or native app in v1.

## Out of scope (v1)

- Hardware wallet support (Ledger / Trezor) — v2
- Multisig / MuSig2 multi-party — v2
- Multiple accounts per wallet — v2
- Browser extension surface — v2
- Mobile native app (iOS / Android) — v2
- NFTs, DeFi positions, governance — never
- Mining payout streams — explicitly out of scope
- Fiat on/off-ramps — partnership, not v1 product

## Repo layout (proposed)

```
pearl-web-wallet/
├── README.md                 (this file)
├── docs/
│   ├── 01-SPEC.md            functional spec, user stories, acceptance criteria
│   ├── 02-ARCHITECTURE.md    tech stack, module layout, build-vs-buy
│   ├── 03-THREAT_MODEL.md    STRIDE per asset, mitigations
│   ├── 04-UX.md              screens, flows, copy, errors, a11y
│   ├── 05-BRIDGE_INTEGRATION.md  PearlBridge native integration
│   ├── 06-CRYPTO.md          key derivation, signing, encryption-at-rest
│   ├── 07-RPC_AND_INDEXING.md   Pearl + Eth RPC, indexer, fallbacks
│   ├── 08-BUILD_PLAN.md      milestones, timeline, audit gates
│   ├── 09-INFRA.md           hosting, headers, CI/CD, monitoring
│   ├── 10-TEAM_BRIEF.md      kickoff doc, roles, conventions
│   ├── 11-OPEN_QUESTIONS.md  unresolved before code starts
│   └── 12-ACCEPTANCE_TESTS.md  definition of done per surface
├── reference/                external docs (PearlBridge contracts, BIP-340, etc.)
└── assets/                   logos, mockups, wireframes (TBD)
```

## Quick-start for the build team

Read in this order:

1. `README.md` — orientation.
2. `docs/11-OPEN_QUESTIONS.md` — what's NOT decided. Resolve before code.
3. `docs/01-SPEC.md` — what you're building.
4. `docs/04-UX.md` — what the user sees.
5. `docs/02-ARCHITECTURE.md` — how it's built.
6. `docs/03-THREAT_MODEL.md` — what could go wrong.
7. `docs/06-CRYPTO.md` + `docs/07-RPC_AND_INDEXING.md` — chain-side guts.
8. `docs/05-BRIDGE_INTEGRATION.md` — the bridge UX (most novel surface).
9. `docs/08-BUILD_PLAN.md` — your milestones.
10. `docs/09-INFRA.md` + `docs/10-TEAM_BRIEF.md` — ops + collaboration.
11. `docs/12-ACCEPTANCE_TESTS.md` — what done looks like.

## Domains

- **Canonical:** `pearlwallet.xyz` — to be registered. Namecheap API blocked the name as "restricted phrase"; needs manual registration via Namecheap web UI, OR registration via Porkbun / Cloudflare Registrar.
- **Defensive lookalike:** `prlwallet.xyz` — register and 301-forward to canonical. Same Namecheap block applies.
- Consider also registering: `pearlwallet.com`, `pearlwallet.app`, `pearl-wallet.xyz`, `prl-wallet.xyz` for phishing defense (cheap insurance, ~$20 total).

## Build-vs-buy

Before any code is written, the build team is expected to reread `docs/02-ARCHITECTURE.md §Build-vs-Buy` and confirm with the core team that forking an existing Bitcoin-Taproot browser wallet (Leather, Xverse) is NOT the right path. The team directive as of 2026-05-17 is to build custom; the spec proceeds on that basis but the alternative is documented so it doesn't get re-litigated mid-build.

## Contact

- **Owner:** PearlBridge core team
- **Spec author:** Bridge Developer — `bridgedev@mailbox.org`
- **Build-team comms channel:** TBD (likely a dedicated Telegram group + a GitHub repo under `PearlBridgeXYZ` org)
