# 01 — Functional Spec

## Product summary

A single-page web wallet that lets a normal retail user:
1. Create or restore a Pearl-compatible wallet in their browser.
2. See their PRL (Pearl L1) and WPRL (Ethereum ERC-20) balances on one screen.
3. Send and receive PRL and WPRL.
4. Bridge between PRL and WPRL via PearlBridge, inline.

That's the whole product. Everything else is v2 or out of scope.

## User stories

### Onboarding
- **U1.** As a new user, I can create a fresh wallet in under 60 seconds, with the app forcing me to back up my mnemonic.
- **U2.** As an existing PRL holder, I can restore my wallet from a 12- or 24-word BIP-39 mnemonic.
- **U3.** As a returning user, I can unlock my wallet with a password I set during onboarding.
- **U4.** As any user, I can verify the wallet domain is `pearlwallet.xyz` and view a fingerprint of the served bundle (SRI / build hash) before trusting it with my keys.

### Holding & viewing
- **U5.** As a user, I see my PRL and WPRL balances on one dashboard, in both native units and USD-equivalent (USD value from an oracle, clearly labeled "approx, not for tax").
- **U6.** As a user, I can view my receive addresses for Pearl L1 and Ethereum, copy them, or show a QR code.
- **U7.** As a user, I can view my transaction history for both chains (last 50 txs, paginated).

### Sending
- **U8.** As a user, I can send PRL to any valid Pearl L1 bech32m address (HRP `prl`), choosing a fee tier (low / normal / high).
- **U9.** As a user, I can send WPRL to any valid Ethereum address, choosing a gas tier (low / normal / high).
- **U10.** Before broadcasting, I always see a preview screen: destination, amount, fee in native + USD, total deducted. I must re-enter or confirm my password to broadcast.

### Bridging (native)
- **U11.** As a user, I can bridge PRL → WPRL: I specify amount, the wallet builds and signs the SDI v2 deposit intent, broadcasts the Pearl-side deposit, and watches for relayer mint on the Eth side. I see live status: pending → confirmed → mint pending → minted.
- **U12.** As a user, I can bridge WPRL → PRL: I approve the burn (or use permit if WPRL supports EIP-2612), submit the burn tx, the wallet watches for relayer release on the Pearl side.
- **U13.** Before either bridge action, I see a clear fee breakdown: bridge fee (mintFeeBps / burnFeeBps), gas, expected received amount.

### Settings
- **U14.** As a user, I can change my unlock password.
- **U15.** As a user, I can export my mnemonic after re-authenticating with my password (with a warning modal).
- **U16.** As a user, I can wipe my wallet from this browser (with double-confirm).
- **U17.** As a user, I can switch between mainnet and testnet (so I can try it risk-free first).

### Help & trust signals
- **U18.** As a user, I can read a "How this works" page explaining custody, what can go wrong, what to do if I lose access, and what the wallet does NOT do (no recovery, no support tickets that can move funds, no remote unlock).
- **U19.** As a user, I can see the GitHub commit / build hash of the version I'm running.
- **U20.** As a user, I can see a banner if the bridge or chain RPC is degraded.

## Features matrix

| # | Feature | v1 must | v1 nice | v2 |
|---|---------|---------|---------|-----|
| F1 | BIP-39 mnemonic create (12 + 24 word) | ✅ | | |
| F2 | BIP-39 mnemonic restore | ✅ | | |
| F3 | Password-encrypted keystore in IndexedDB | ✅ | | |
| F4 | Pearl L1 receive (single address) | ✅ | | |
| F5 | Pearl L1 HD receive (rotating addresses) | | ✅ | |
| F6 | Pearl L1 send with 3 fee tiers | ✅ | | |
| F7 | Pearl L1 advanced (manual UTXO selection) | | | ✅ |
| F8 | Eth WPRL receive | ✅ | | |
| F9 | Eth WPRL send with 3 gas tiers | ✅ | | |
| F10 | Combined dashboard (PRL + WPRL + USD est) | ✅ | | |
| F11 | Tx history (last 50, both chains) | ✅ | | |
| F12 | Bridge PRL → WPRL inline | ✅ | | |
| F13 | Bridge WPRL → PRL inline | ✅ | | |
| F14 | Bridge live status tracker | ✅ | | |
| F15 | Mainnet / testnet toggle | ✅ | | |
| F16 | Password change | ✅ | | |
| F17 | Mnemonic export (post-auth) | ✅ | | |
| F18 | Wallet wipe | ✅ | | |
| F19 | Dark mode | ✅ | | |
| F20 | i18n (en first, fr/es/zh later) | | ✅ | |
| F21 | Hardware wallet (Ledger Bitcoin app) | | | ✅ |
| F22 | Multisig (MuSig2) | | | ✅ |
| F23 | Multiple accounts | | | ✅ |
| F24 | Browser extension | | | ✅ |
| F25 | Mobile native | | | ✅ |
| F26 | NFTs / DeFi / governance | | | ❌ never |
| F27 | Mining payout view | | | ❌ never |
| F28 | Fiat on/off-ramp | | | ✅ (partner) |

## Supported networks

| Network | Chain | Role | RPC |
|---------|-------|------|-----|
| Pearl L1 mainnet | Pearl (btcd-fork) | Native PRL hold/send/bridge-source | Own proxy |
| Pearl L1 testnet | Pearl testnet | Pre-mainnet user testing | Own proxy |
| Ethereum mainnet | EVM chainId 1 | WPRL hold/send/bridge-source | publicnode.com + drpc fallback |
| Ethereum Sepolia | EVM chainId 11155111 | Pre-mainnet user testing | publicnode.com |

## Acceptance criteria (top-level)

1. A new user can create a wallet, receive 0.1 PRL on testnet, send it back, and bridge 0.05 PRL → WPRL → PRL, all within 15 minutes, on a Pixel 7 mobile browser.
2. Zero critical or high findings in the pre-launch security audit (see `docs/12-ACCEPTANCE_TESTS.md`).
3. Keys never leave the browser. Network panel during a normal send shows only: RPC calls (no keys, no signed payloads beyond the broadcast), price oracle, no analytics, no third-party fonts.
4. Lighthouse score ≥ 90 on Performance, ≥ 95 on Accessibility, ≥ 100 on Best Practices.
5. CSP, COOP, COEP, X-Frame-Options DENY all enforced; verified via `securityheaders.com` grade A+.
6. Build is reproducible — same commit hash produces same bundle hash on two machines.

## Non-functional requirements

- Initial JS bundle ≤ 500 KB gzipped.
- Time-to-interactive ≤ 2.5s on 4G.
- Wallet unlock ≤ 500ms after password entry.
- No third-party trackers. No analytics in v1 (Cloudflare's edge analytics only, which doesn't load JS).
- All copy at 8th-grade reading level (Hemingway grade).
- WCAG AA accessibility (keyboard nav, screen reader labels, color contrast).
