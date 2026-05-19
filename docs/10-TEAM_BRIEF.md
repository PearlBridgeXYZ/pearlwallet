# 10 — Team Brief

This is the kickoff document for the engineers, designer, and auditor who'll build the Pearl Web Wallet. Read this first.

## You're building

A non-custodial web wallet for Pearl L1 (PRL) and the wrapped Ethereum version (WPRL), with the PearlBridge bridge integrated natively. Read `README.md` and `docs/01-SPEC.md` for the full picture. **The wallet operator (us) never touches a user key.** That constraint shapes every decision.

## Why this matters

PRL holders currently have no good retail wallet. The bridge exists but lives at a separate URL. Combining them with one password and one balance view is the product. If we can't ship a calm, trustworthy, non-custodial flow, retail users stay on exchanges or stay offline — and the chain doesn't grow.

## Who's on the team

| Role | Responsibilities |
|------|------------------|
| **Lead engineer** | Architecture (`docs/02-ARCHITECTURE.md`), crypto (`docs/06-CRYPTO.md`), bridge integration (`docs/05-BRIDGE_INTEGRATION.md`), code review, audit liaison |
| **Frontend engineer** | UI (`docs/04-UX.md`), state management, a11y, tx flows |
| **Designer** | Figma file (linked from `assets/`), brand polish, microcopy review |
| **Auditor** | External firm (TOB / OZ / Cure53), engaged at M5 — see `docs/12-ACCEPTANCE_TESTS.md` |
| **Core team** | Approvals, scope changes, audit gate sign-off |
| **Bridge Developer** | Spec author + ongoing context bridge to Pearl fleet, PearlBridge contracts, and infra |

## Repo

- **Org:** `PearlBridgeXYZ`
- **Name:** `pearlwallet`
- **Visibility:** **PRIVATE** until first audit ships; open-sourced at launch.
- **License at open-source:** MIT (proposed; core team to confirm).

## Conventions

### Code style
- **TypeScript strict mode.** No `any` outside an `// @ts-expect-error` with reasoning.
- **ESLint + Prettier** with the configs in this repo. CI fails on lint errors.
- **Function components only.** No class components.
- **Hooks discipline.** Custom hooks for reused logic. No effect-soup.
- **No barrel files** (`index.ts` re-exports) — Vite tree-shakes better without them.
- **Imports:** absolute via `@/` alias, sorted (eslint-plugin-import).
- **Naming:**
  - Files: `kebab-case.ts` for utils, `PascalCase.tsx` for components.
  - Components: PascalCase. Hooks: `useFoo`. Types: `Foo`.
  - Crypto code: spell out abbreviations on first use (`KeyEncryptionKey (KEK)`).

### Git
- **Branching:** trunk-based. Short-lived feature branches off `main`. No long-lived `develop`.
- **Commit messages:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- **PRs:** must reference a milestone / issue, must include test coverage, must update docs if behavior changes.
- **Required trailers:** `Co-Authored-By: Claude <model>` for any AI-assisted PR.
- **Signed commits required** on `main`.

### Testing
- **Vitest** for unit tests. Aim for ≥80% coverage on `src/crypto/`, `src/chains/`, `src/bridge/`. UI coverage less strict (~60%).
- **Playwright** for e2e against Pearl testnet + Eth Sepolia.
- **fast-check** for property tests on crypto.
- Test files colocated with source: `foo.ts` + `foo.test.ts`.
- e2e tests in `e2e/` directory.

### Comments
- Default to none.
- Write a comment only when the **why** is non-obvious.
- Don't explain what well-named code already says.
- Don't reference issue numbers in code — those go in commit messages.

### Dependencies
- Run `npm audit --omit=dev` before adding any new dep; review CVE history.
- Every new dep needs a one-line justification in the PR description.
- No deps with < 100 weekly downloads unless justified.
- Crypto-touching deps require Lead approval.

## Process

### Weekly sync (30 min)
- Demo progress.
- Surface blockers.
- Review burn vs. milestone.

### Async daily
- Standup notes in a dedicated Telegram group or in repo's `STANDUP.md` (append-only log).

### Code review SLA
- Reviewers respond within 1 business day.
- Author addresses comments within 1 business day.
- Stale PRs (no activity > 5 days) get nagged.

### Decision log
- Architecture/scope decisions go in `docs/decisions/YYYY-MM-DD-<topic>.md` (ADR format).
- Open questions live in `docs/11-OPEN_QUESTIONS.md` until resolved, then move to a decision record.

## Hand-off context

Working context available from the Bridge Developer:
- PearlBridge — relay, contracts, audit reports.
- Pearl fleet — pearld nodes available for wallet RPC.
- Vault / secrets patterns for ops.
- Telegram-based status alerts.
- Cloudflare DNS templates for the wallet domain.

The Bridge Developer is available to:
- Walk through PearlBridge contracts and relayer API.
- Provision Pearl RPC proxy + indexer on a VPS.
- Set up DNS / Cloudflare Pages.
- Register domains once a path around the Namecheap "wallet" block is chosen.
- Review code (security-focused, not style-focused).

Reach out via `bridgedev@mailbox.org` or the team Telegram group.

## What you should NOT build

- Backend that holds user keys. Hard line.
- Recovery service. The non-custodial promise is the product.
- KYC. Not happening.
- A "watch-only" mode that requires emailing us. If we add watch-only, it's local-only.
- An ad surface. Wallets that show ads are not wallets, they're surveillance.

## Audit posture

We engage an external firm at M5. **Do not consider the wallet shippable to mainnet without their sign-off.** The audit reports become public artifacts in `/audit/`.

Build with the audit in mind from day one:
- Small, reviewable PRs.
- Pure functions in `crypto/` and `chains/` so they're testable in isolation.
- Worker contract clearly documented.
- No "TODO: fix before launch" left in the code at M5 — those become audit findings.

## When in doubt

- For product decisions: ask the core team.
- For technical decisions: discuss in PR, escalate to Lead.
- For crypto-correctness questions: check `@scure`/`@noble` test vectors; if uncertain, post in the team channel.
- For audit-touching questions: post AND wait for Lead before merging.

Welcome to the build. Move carefully. Ship something we'd trust with our own keys — because we will.
