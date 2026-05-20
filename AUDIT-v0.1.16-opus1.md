# Audit — v0.1.16 (single-pass focused reaudit)

**Auditor:** Opus 4.7 (single pass).
**Date:** 2026-05-20.
**Scope:** v0.1.15 → v0.1.16 diff only. Adjacent code in scope only as
the diff touches it.

## What changed

User report (2026-05-20): a contact had trouble importing a seed phrase
into the wallet. Investigation through a new derivation-import test
suite surfaced the cause: the mnemonic normalizer in
`src/crypto/mnemonic.ts` only ran `.trim().toLowerCase()` — it did not
collapse internal whitespace runs. A user pasting a 12-word phrase with
double-spaces between words (PDF backups, autoformatters that introduce
non-breaking spaces, smart-quote editors, hand-typed phrases with extra
spaces) would see "Invalid recovery phrase" even though every word was
on the BIP-39 list. Other reference wallets (Trezor Suite, Sparrow,
btcd-oyster, Electrum) all normalize internal whitespace before
validating. We did not.

- `src/crypto/mnemonic.ts`. New private `normalize()` helper that does
  `.trim().toLowerCase().replace(/\s+/g, " ")` and is the single
  entry point for every mnemonic-consuming export. `validateMnemonic`,
  `mnemonicWords`, and `mnemonicToSeed` now route through it. No
  public-surface API change — same function signatures, same return
  types, strictly more inputs accepted.
- `tests/derivation-import.test.ts` (NEW, 18 tests). Import-side
  conformance suite. Covers:
  - normalization is invisible to derivation (whitespace / case
    variants → same Pearl address)
  - 12 / 15 / 18 / 21 / 24-word mnemonics all derive deterministically
  - 24-word canonical BIP-39 Trezor vector
  - 12-word ≠ 24-word (different entropy → different wallet)
  - invalid mnemonics (typo, off-wordlist, wrong length, wrong
    checksum, empty, non-English) all surface as `false`
  - pool of `RECEIVE_GAP_LIMIT` Pearl addresses is bit-stable across
    repeated derivations
  - a freshly-generated mnemonic round-trips through the importer
    with a noisy uppercase/whitespace variant
  - Eth uses BIP-44 `m/44'/60'/0'/0/0` and is a distinct branch from
    Pearl's BIP-86 `m/86'/808276'/0'/0/0`
- `package.json`. Version 0.1.15 → 0.1.16.

The btcd-oyster bit-exact 12-word pin in `tests/derivation.test.ts`
remains untouched — that's the cross-implementation bedrock and v0.1.16
inherits it.

## Findings

**0 Critical, 0 High, 0 Medium, 0 new Low.**

### Considered and rejected

- **L (rejected): could the new normalization accept phrases that the
  user actually mistyped — masking a typo that the old strict check
  would have caught?** No. The normalizer only touches whitespace and
  case. The checksum verification inside `bip39.validateMnemonic` is
  unchanged and still rejects any phrase whose word list / checksum
  doesn't line up — that's tested by six negative cases in the new
  suite (single misspell, off-wordlist English, wrong length × 2,
  wrong checksum, non-English). A user who pastes "abondon abandon …"
  still sees "Invalid recovery phrase", just as before. The bug we
  fixed was strictly the opposite class: a *valid* phrase that was
  being rejected for cosmetic whitespace.

- **L (rejected): does Unicode normalization (NFKD/NFC) need to be
  added too, per BIP-39 §"Wordlist"?** The English wordlist contains
  only ASCII tokens, and `@scure/bip39` already applies NFKD to the
  phrase + passphrase inside `mnemonicToSeed` before PBKDF2. Adding a
  redundant `normalize("NFKD")` call client-side would be a no-op for
  ASCII and could mask a future wordlist change. Out of scope.

- **L (rejected): does collapsing internal whitespace open a
  homoglyph / zero-width-space attack where an attacker convinces the
  user to import a phrase with a hidden non-word separator?** `\s+`
  matches tab, newline, form-feed, carriage return, vertical-tab, and
  most Unicode whitespace including NBSP and zero-width-space-as-space.
  The collapsed token stream is then hashed by BIP-39 PBKDF2 with the
  canonical single-space separator — identical to what every
  reference wallet does. No attack surface change relative to a
  user typing the phrase fresh.

- **L (rejected): could the new tests run flaky because of
  `bip39.generateMnemonic` returning a phrase whose first Pearl child
  has a non-`prl1p` prefix?** No. P2TR taproot v1 outputs encode to
  bech32m with witness version 1, which in our HRP-`prl` scheme always
  produces `prl1p…`. The address generator is deterministic from the
  pubkey and the witness version, not from any entropy in the seed.
  20 randomized rounds across 5 entropy strengths × 1 each is enough
  signal — a regression in the encoder would fire on the very first
  case.

- **L (rejected): does the import path differ from create path in any
  meaningful way (different code path = different address)?** No —
  asserted directly by the pool round-trip test and the
  freshly-generated-mnemonic test. `restoreWallet` and `createWallet`
  in `src/crypto/worker.ts` both pass through `seedFromMnemonic` →
  `masterFromSeed` → identical `pearlReceivePath(i)` and
  `DEFAULT_ETH_PATH` derivations. Symmetry is now machine-checked.

### Carried Highs (status table)

| Finding                                   | Status                  |
| ----------------------------------------- | ----------------------- |
| O1-H-1 (insane baseFee DoS)               | FIXED v0.1.9            |
| O2-H-1 ≡ M2-H-2 (sign-what-you-saw)       | FIXED v0.1.9            |
| O1-H-2 (signature freshness via Eth time) | Open — UX only, deferred|
| O2-H-2 (chainId binding from RPC)         | Open — defense-in-depth |
| M2-H-1 (auto-lock countdown UX)           | FIXED v0.1.5            |

No regression on any of the above.

## Verdict

**Ship.** Closes a real, reported import failure caused by overly
strict whitespace handling in the mnemonic normalizer. Adds 18 new
derivation-conformance tests that machine-check the import path
against the create path and against BIP-39 reference vectors.
232/236 tests pass (4 skipped live-RPC).
