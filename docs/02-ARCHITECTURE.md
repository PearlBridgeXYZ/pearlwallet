# 02 — Architecture

## Build-vs-Buy (READ FIRST)

Team directive (2026-05-17) is to build custom. The build team should still pressure-test this before writing code:

### Option A: Build custom (chosen)
- **Pro:** full control of UX, branding, bridge integration, dependency tree.
- **Pro:** no inherited tech debt; can audit every line.
- **Con:** ~9 dev-weeks for a 2-person team to reach beta. Reinventing well-known wheels (BIP-39/32, fee estimation, UTXO selection).
- **Con:** we own the security perimeter; first bug is our bug.

### Option B: Fork an existing Bitcoin-Taproot browser wallet
- **Leather (formerly Hiro):** open source, Stacks-focused, has Taproot, has browser extension surface — too coupled to Stacks for clean Pearl extraction (~6 weeks of removal work before adding Pearl).
- **Xverse:** Bitcoin/Ordinals/Stacks browser extension wallet, Taproot-native. Closed source mostly. Not viable.
- **Sparrow (desktop):** best-in-class Bitcoin Taproot wallet but JVM desktop, not browser. Not viable.
- **rabby / metamask fork:** EVM-only. Not viable for Pearl L1.
- **Verdict:** no clean fork target for a pure-web Pearl wallet. Custom build is justified.

### Option C: Use a wallet abstraction layer (Privy, Dynamic, Lit Protocol)
- These give "wallet in 10 lines" but introduce **MPC custody or hosted key material** — violates the non-custodial directive. Rejected.

**Conclusion:** build custom is the right call given the non-custodial + pure-web + native bridge constraints. Documented so this question doesn't keep coming up.

## High-level architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Browser (user's machine)                    │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                  Pearl Web Wallet SPA                       │  │
│  │                                                             │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │  │
│  │  │   UI     │  │  State   │  │  Chain   │  │   Crypto   │ │  │
│  │  │  React + │  │ Zustand  │  │  layer   │  │  worker    │ │  │
│  │  │ shadcn   │◄─►          │◄─►          │◄─►            │ │  │
│  │  └──────────┘  │ TanStack │  │ Pearl +  │  │ @noble/*   │ │  │
│  │                │  Query   │  │ viem     │  │ @scure/*   │ │  │
│  │                └──────────┘  └──────────┘  └────────────┘ │  │
│  │       ▲                            │              ▲         │  │
│  │       │                            │              │         │  │
│  │  ┌────┴──────────────────┐  ┌─────┴──────────┐ ┌─┴───────┐ │  │
│  │  │ Encrypted IndexedDB   │  │ HTTPS to RPC   │ │ WebCrypto│ │  │
│  │  │ (Dexie + AES-GCM)     │  │ proxies (own + │ │ SubtleAPI│ │  │
│  │  │  • mnemonic ciphertext│  │ public Eth)    │ │          │ │  │
│  │  │  • address book       │  └────────────────┘ └──────────┘ │  │
│  │  │  • tx cache           │                                  │  │
│  │  └──────────────────────┘                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                   │                                  │
                   │ Pearl JSON-RPC                   │ Eth JSON-RPC
                   ▼                                  ▼
        ┌─────────────────────┐         ┌────────────────────────┐
        │ Pearl RPC proxy     │         │ ethereum-rpc.publicnode│
        │ (VPS / CF Worker    │         │ .com (primary)         │
        │  in front of pearld)│         │ eth.drpc.org (fallback)│
        │ + CORS + rate limit │         └────────────────────────┘
        └─────────────────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │ pearld nodes        │
        │ (existing fleet)    │
        └─────────────────────┘

        ┌─────────────────────────────────────────┐
        │ PearlBridge relayer (existing)          │
        │ • Watches Pearl lock address            │
        │ • Signs EIP-712 mint payloads (WPRL)    │
        │ • Watches WPRL burn events              │
        │ • Signs Pearl release txs               │
        │ Wallet posts deposit intents here +     │
        │ polls for mint/release status.          │
        └─────────────────────────────────────────┘
```

## Tech stack

### Languages & frameworks
- **TypeScript 5.x** strict mode, no `any` outside explicit `// @ts-expect-error` lines.
- **React 18** with concurrent features.
- **Vite 5** for build.
- **Tailwind 3** + **shadcn/ui** for components.

### State
- **Zustand** for client UI state.
- **TanStack Query (React Query) v5** for chain state, with strict cache-invalidation rules.

### Chain libs
- **Ethereum:** `viem` v2 (modern, tree-shakeable, replaces ethers v6).
- **Pearl L1:** Combination of
  - `@noble/curves` — Schnorr / secp256k1 primitives (already in PearlBridge relay deps).
  - `@scure/btc-signer` — UTXO tx construction (Bitcoin-format, works for Pearl with custom network params).
  - `@scure/bip32` — HD key derivation.
  - `@scure/bip39` — mnemonic.
  - Custom thin wrapper (`src/chains/pearl/`) for HRP `prl`, bech32m, network magic.

### Storage
- **Dexie** (IndexedDB wrapper) for the encrypted keystore + cache.
- Schema versioned, with migration support from v1.

### Crypto
- **WebCrypto SubtleCrypto** for AES-GCM and PBKDF2.
- All key derivation and signing runs in a **dedicated Web Worker** so the UI thread never holds private key bytes longer than needed.

### Testing
- **Vitest** for unit tests.
- **Playwright** for end-to-end (against testnet).
- **fast-check** for property-based / fuzz tests on crypto.

### Lint / format
- **ESLint** + **@typescript-eslint** + **eslint-plugin-react-hooks** + **eslint-plugin-security**.
- **Prettier** for formatting.

## Module structure

```
src/
├── main.tsx                  Vite entry
├── App.tsx                   router shell
├── chains/
│   ├── pearl/
│   │   ├── network.ts        mainnet / testnet params (HRP, magic, decimals)
│   │   ├── address.ts        bech32m encode/decode, validate
│   │   ├── tx.ts             coin selection, fee calc, tx build
│   │   ├── sign.ts           Schnorr key-path Taproot signing
│   │   ├── rpc.ts            JSON-RPC client (pearld methods)
│   │   └── indexer.ts        wraps RPC to give tx history view
│   └── ethereum/
│       ├── network.ts        mainnet / sepolia
│       ├── rpc.ts            viem PublicClient setup with fallback
│       ├── wprl.ts           WPRL ERC-20 ABI + helpers
│       └── tx.ts             tx send + watch
├── crypto/
│   ├── mnemonic.ts           BIP-39 generate, validate, entropy
│   ├── hd.ts                 BIP-32 derivation paths
│   ├── keystore.ts           AES-GCM + PBKDF2 encrypt/decrypt
│   ├── worker.ts             Web Worker entry; all signing happens here
│   └── worker-client.ts      main-thread RPC to worker (postMessage wrapper)
├── bridge/
│   ├── sdi.ts                SDI v2 build + sign (BIP-322 for Pearl side)
│   ├── eip712.ts             EIP-712 mint domain/types for WPRL
│   ├── relayer.ts            HTTP client to PearlBridge relayer
│   ├── status.ts             unified status tracker for both directions
│   └── contracts.ts          mainnet/sepolia contract addresses
├── services/
│   ├── prices.ts             USD price oracle (CoinGecko / chain-link fallback)
│   ├── fees.ts               fee tier suggestions for Pearl + Eth
│   └── health.ts             RPC health probe + banner data
├── storage/
│   ├── db.ts                 Dexie schema, migrations
│   ├── address-book.ts       saved recipients
│   └── tx-cache.ts           local tx history cache
├── state/
│   ├── wallet-store.ts       Zustand: locked/unlocked, current account
│   ├── ui-store.ts           Zustand: theme, network, modals
│   └── queries.ts            TanStack Query keys + invalidation
├── ui/
│   ├── pages/
│   │   ├── Onboarding.tsx
│   │   ├── Unlock.tsx
│   │   ├── Dashboard.tsx
│   │   ├── Send.tsx
│   │   ├── Receive.tsx
│   │   ├── Bridge.tsx
│   │   ├── History.tsx
│   │   └── Settings.tsx
│   ├── components/           shadcn-derived primitives, app-specific compounds
│   └── copy/                 i18n strings, error catalog
└── lib/
    ├── format.ts             number formatting (grains, wei, USD)
    ├── qr.ts                 QR rendering
    └── validate.ts           input validation
```

## State model

```
┌─────────────────────────────────────────────────────────────┐
│ Wallet lifecycle                                            │
│                                                             │
│  ┌──────────┐    create / restore     ┌─────────────────┐  │
│  │ no       │ ───────────────────────►│ provisioning    │  │
│  │ wallet   │                          │ (mnemonic in   │  │
│  └──────────┘                          │  worker memory)│  │
│       ▲                                 └────────┬───────┘  │
│       │                                          │ encrypt  │
│       │ wipe                                     ▼          │
│       │                                ┌─────────────────┐  │
│       │                                │ locked          │  │
│       └────────────────────────────────│ (ciphertext in │  │
│                                        │  IndexedDB)    │  │
│                                        └────────┬───────┘  │
│                                                 │ password  │
│                                                 ▼          │
│                                        ┌─────────────────┐  │
│                                        │ unlocked        │  │
│                                        │ (keys in worker │  │
│                                        │  only)         │  │
│                                        └─────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Key invariants:
- **Main thread never holds raw private keys.** All key material lives in the Web Worker, which the main thread talks to via `postMessage`. The worker exposes verbs like `signPearlTx`, `signEthTx`, `signBridgeIntent`, `derivePearlAddress`, never `getPrivateKey`.
- **Locked state is the default after 5 min idle.** Configurable in settings (1 / 5 / 15 / 60 min / never).
- **The worker is wiped on lock**, so unlock re-runs PBKDF2 decryption. Tradeoff: ~300ms unlock vs holding keys in memory longer.

## Build-time guarantees

- **Reproducible build:** lockfile committed, Vite config sets deterministic output filenames (`assetFileNames: '[name]-[hash][extname]'`), `npm ci` in CI.
- **Source maps published** with bundle for transparency (SRI hash of source map also published).
- **SRI on the entry HTML:** the served `index.html` includes integrity hashes for every script tag.
- **No CDN dependencies** for fonts, icons, or scripts. Everything bundled.

## Dependency policy

- Every direct dep gets a security review before adoption.
- `npm audit` runs in CI; high or critical CVEs block merge.
- Renovate-bot configured for **manual approval** on all PRs (no auto-merge ever for a wallet).
- `@noble/*` and `@scure/*` preferred over `tiny-secp256k1` / `bitcoinjs-lib` for crypto, because they are audit-friendly, dep-free, and used by the PearlBridge relay (consistent supply chain).

## Performance budget

| Asset | Budget |
|-------|--------|
| Initial JS bundle (gzipped) | 500 KB |
| Initial CSS bundle (gzipped) | 30 KB |
| Largest contentful paint (4G) | 2.5 s |
| Time to interactive (4G) | 2.5 s |
| First input delay | 100 ms |
| Wallet unlock | 500 ms |
| Pearl address derivation | 50 ms |

Enforced via Lighthouse CI on every PR.
