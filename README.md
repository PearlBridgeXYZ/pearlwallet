# Pearl Web Wallet

**A non-custodial, pure-web wallet for Pearl L1 (PRL) and Wrapped PRL (WPRL) on Ethereum, with native PearlBridge integration.**

🔗 **Live:** [pearlwallet.xyz](https://pearlwallet.xyz) · Mirror: [pearlwallet.xyz](https://pearlwallet.xyz)
📦 **Releases:** [github.com/PearlBridgeXYZ/pearlwallet/releases](https://github.com/PearlBridgeXYZ/pearlwallet/releases) — every tag ships a single-file offline HTML for air-gapped use.
🛠 **Status:** Shipping. Currently at `v0.1.18`. Pre-`v1.0` — flagged experimental until the public audit lands.

---

## Why use it

**Hold your own keys.** Most "wallets" today are either custodial websites (where someone else holds your funds) or browser-extension black boxes you can't easily inspect. The Pearl Web Wallet is a single-page web app you load from a URL or run from a single offline HTML file. Your seed phrase is generated in your browser, encrypted with your password, and never leaves your device.

**Hold PRL on Pearl L1 *and* WPRL on Ethereum, side by side.** Most PRL holders today have to juggle two different wallets, two different mnemonics, and a brittle manual bridge dance. This wallet derives both addresses from one BIP-39 seed (BIP-86 Taproot for Pearl, BIP-44 for Ethereum), shows both balances on one screen, and integrates the [PearlBridge](https://pearlbridge.xyz) contracts so moving value between the two chains is a one-click operation.

**Run it from a USB stick on an air-gapped machine.** Every release tag ships a `pearlwallet-offline-vX.Y.Z.html` build — one self-contained HTML file, no network fetches, no `<script src="...">`, worker bundled in as a data URI. Open it in a browser on a laptop that has never seen the internet, generate a wallet, sign a transaction, walk the signed bytes back via QR or USB. The same code path that runs at `pearlwallet.xyz` runs offline.

---

## What's good about it

### Auditable

- **100% open source TypeScript / React / Vite.** No minified blobs in the supply chain.
- **Pinned dependencies.** Crypto comes from [`@scure/bip32`](https://github.com/paulmillr/scure-bip32), [`@scure/bip39`](https://github.com/paulmillr/scure-bip39), [`@scure/btc-signer`](https://github.com/paulmillr/scure-btc-signer), [`@noble/curves`](https://github.com/paulmillr/noble-curves), [`@noble/hashes`](https://github.com/paulmillr/noble-hashes), and [`viem`](https://viem.sh) — the same primitives that back most serious wallets today.
- **27 public audit reports in this repo** as of `v0.1.18`, covering every release back to `v0.1.0`. Each one names the auditor, lists findings by severity (Critical / High / Medium / Low), and either fixes the finding before the release or carries it forward with a public status note. See `AUDIT-v*.md` at the repo root.
- **Reproducible build.** `git clone`, `npm install`, `npm run build` — the bundle hashes in the GitHub Release notes are what you should see locally.
- **Pinned address derivation.** The test suite proves that the BIP-39 vector-1 mnemonic, fed through this wallet, produces the same five Pearl L1 addresses as `btcd-oyster` (the canonical Pearl L1 reference wallet) byte-for-byte. If derivation ever regresses, the test suite refuses to ship.

### Defensible (threat model)

The wallet is built assuming the network is hostile, the host browser is partially hostile, and an attacker may have local-tab JavaScript injection capability or shoulder-surf access to the screen.

- **Strict Content Security Policy.** `connect-src` is allowlisted to a small set of trusted RPC hosts (PearlBridge sentry RPC, [publicnode.com](https://publicnode.com) Ethereum RPC, [drpc.org](https://drpc.org)). A custom RPC override is also constrained to that allowlist at the store boundary so a stray bookmarklet can't redirect price queries to an attacker.
- **WebWorker-isolated crypto.** Signing, key derivation, and password-derived AES-GCM decryption all happen inside a `?worker` whose only message contract is `(intent, public inputs) → (signed bytes)`. The main thread sees neither the seed nor the private keys at any point after unlock.
- **PBKDF2-600k AES-256-GCM keystore.** Encrypted blob is stored in IndexedDB (via Dexie). Random salt + IV per encryption. AAD binds the ciphertext to a wallet ID so a swapped ciphertext from a different keystore can't decrypt under the same password.
- **60-second clipboard auto-clear.** Copy your address → 60s later the clipboard is wiped (best-effort under browser permissions).
- **Auto-lock with activity tracking.** A monotonic-clock timer locks the wallet on idle. Visibility-change handling closes the gap where a backgrounded tab's `setInterval` is throttled. Tab-switch immediately hides any revealed seed phrase.
- **Sign-what-you-saw.** The transaction preview the user approves is the exact byte-for-byte payload sent to the worker. A malicious main-thread script cannot mutate the tx between approval and signing.
- **No telemetry, no analytics, no third-party fonts, no CDN.** Every asset is local. The wallet operator cannot see who's using the wallet or what they're doing.

### Honest

- **Pre-1.0.** The wallet is shipping and people use it, but it has not yet been through a paid third-party audit. Treat balances above what you'd carry as cash with appropriate caution until the `v1.0` audit ships.
- **Mainnet only.** Pearl has no testnet. The wallet refuses any non-mainnet HRP at the address codec to make sure a future testnet vector can't silently load into your real keystore.
- **Lose your mnemonic, lose your funds.** There is no recovery service. No password reset. No "contact support." This is stated bluntly in onboarding because it's the truth.

---

## Features

### Today (`v0.1.18`)

- ✅ Create a fresh wallet (12-word BIP-39 mnemonic, generated in-browser).
- ✅ Restore from an existing 12 or 24-word mnemonic. Whitespace-tolerant — paste from anywhere.
- ✅ Hold + send **PRL** on Pearl L1 (Taproot P2TR).
- ✅ Hold + send **WPRL** on Ethereum (EIP-1559).
- ✅ Hold + send **ETH** for gas.
- ✅ **Bridge** PRL ↔ WPRL via the PearlBridge contracts — both directions, with on-screen previews.
- ✅ Real-time **balances** aggregated across the receive pool (BIP-86 gap-limit walk of 20 addresses).
- ✅ **Recent activity** scanner — pulls confirmed sends/receives from the Pearl sentry RPC + Ethereum, with explorer links.
- ✅ **Receive** view with QR + copy-to-clipboard.
- ✅ **Optional dev tip** (10 bps / 1 PRL floor, opt-out, defaults on) — keeps the project funded without anyone owing anyone anything.
- ✅ **Custom RPC endpoint** for users running their own Pearl node.
- ✅ **Light / dark / system theme.**
- ✅ **Single-file offline HTML release** attached to every tag for air-gapped use.
- ✅ **PWA install** — pin it to your dock and run it like a native app (still 100% in-browser, no native code).
- ✅ **Settings**: lock now, change password, export recovery phrase (60s auto-hide), wipe wallet from device.

### In development

- 🚧 **Multisig vaults.** The on-chain primitives ship in `v0.1.18` behind an opt-in Settings toggle (default off). When enabled, the wallet exposes a `Vaults` surface that documents the construction so it can be independently audited:
  - BIP-342 tapscript m-of-n under a P2TR output
  - Internal key bound to the BIP-341 NUMS point (key-path spend provably disabled)
  - BIP-67-sorted cosigner pubkeys (deterministic address reconstruction)
  - Dedicated derivation path `m/86'/808276'/100'/{account}'/{i}` kept apart from the singlesig receive pool
  - JSON cosigner descriptor format for safe copy-paste cosigner enrolment

  The user-facing flows — create vault, exchange cosigner descriptors, draft and co-sign transactions, optional Gnosis-Safe signer mode for the WPRL/ETH side — land in `v0.1.19+`. **Don't move funds into a vault yet — there's no spend flow.** Turn the surface off in Settings if you'd rather not see it.

### Future

- Hardware wallet support (Ledger / Trezor)
- Multiple accounts per mnemonic
- Browser-extension surface for dApp connectivity
- Mobile native app

---

## Try it

**Easiest:** open [pearlwallet.xyz](https://pearlwallet.xyz) and click *Create new wallet*. Write down the 12 words. Set a password. Done.

**Air-gapped:** grab `pearlwallet-offline-v0.1.18.html` from the [latest release](https://github.com/PearlBridgeXYZ/pearlwallet/releases/latest), move it to an offline machine, and open it in a browser. The whole wallet runs from `file://`.

**From source:**

```bash
git clone https://github.com/PearlBridgeXYZ/pearlwallet.git
cd pearlwallet
npm install
npm test                # full suite — 286 tests, ~10s
npm run build           # production bundle → dist/
npm run build:offline   # single-file HTML → dist-offline/pearlwallet-offline-vX.Y.Z.html
```

---

## How it's built

### Stack

- **Vite 5 + React 18 + TypeScript (strict).** No global state framework, [Zustand](https://github.com/pmndrs/zustand) for the small amount that's needed.
- **Tailwind 3.4** for styling. No design framework, no CSS-in-JS, no runtime tokens.
- **Dexie 4** wraps IndexedDB for the encrypted keystore + activity cache.
- **viem 2** for Ethereum interactions (balance reads, EIP-1559 sends, ERC-20 calls).
- **@scure/btc-signer** for Pearl L1 — Taproot encoding, P2TR derivation, multisig leaves.
- **@scure/bip32 + @scure/bip39 + @noble/hashes + @noble/curves** for the crypto primitives.

### Layout

```
src/
├── chains/
│   ├── pearl/           Pearl L1: address codec, multisig, network params, RPC
│   └── eth/             Ethereum: WPRL contract, gas estimator, send flows
├── crypto/              BIP-39 mnemonic, BIP-32 HD, descriptor format, keystore
├── lib/                 small utilities (format, validate, monotonic clock)
├── services/            higher-level: balances, prices, activity, bridge, tx-sim
├── state/               Zustand stores (wallet, UI)
├── storage/             Dexie schema
├── ui/                  React components + page-level views
├── worker.ts            Web Worker for crypto isolation
└── App.tsx              routing + auto-lock
tests/                   Vitest suite, 286 tests
docs/                    spec docs, threat model, architecture notes
AUDIT-v*.md              public audit reports, one per release
```

### Release cycle

Each release follows the same loop:

1. **Implement** the smallest meaningful change.
2. **Test** — add tests for the new behavior, run the full suite.
3. **Audit** — independent review pass, written up as `AUDIT-vX.Y.Z-*.md`, severity-classified.
4. **Fix** anything the audit surfaces.
5. **Build, deploy, tag, release** — bundle hashes published in the GitHub Release notes.

The loop runs until the audit is `0/0/0/0`. Then we ship.

---

## Contact

- **Maintainer:** Bridge Developer — `bridgedev@mailbox.org`
- **Bridge project:** [PearlBridge](https://pearlbridge.xyz)
- **Repo:** [github.com/PearlBridgeXYZ/pearlwallet](https://github.com/PearlBridgeXYZ/pearlwallet)
- **Issues / PRs welcome.** Please don't open issues with private vulnerability details — email `bridgedev@mailbox.org` first.

---

## License

MIT. See [LICENSE](./LICENSE).
