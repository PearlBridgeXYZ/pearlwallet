# Audit — v0.1.18 (multisig primitives, off-by-default)

**Auditor:** Opus 4.7 (single pass).
**Date:** 2026-05-20.
**Scope:** v0.1.17 → v0.1.18 diff. Adjacent code in scope only as the
diff touches it.

## What changed

User ask: ship multisig as an opt-in experimental feature in Settings,
default off, and run the test/audit/increment/fix loop until it's
clean. Per the research pass last release (`RESEARCH-multisig.md`)
this lands the on-chain primitives first — the user flows (create
vault, exchange descriptors, draft/co-sign PSBTs) follow in v0.1.19+.

### Files

- `src/state/ui-store.ts`. New `multisigEnabled: boolean` (default
  `false`), `setMultisigEnabled` action. Persisted to localStorage.
  Bumped `STORAGE_KEY` from `pearl-wallet-ui-v3` → `pearl-wallet-ui-v4`
  so a stale persisted blob from v0.1.17 (which had no `multisigEnabled`
  field) doesn't carry forward into the new shape. `loadUI` merges
  with `DEFAULT_UI` and re-validates the RPC override.
- `src/crypto/hd.ts`. New `PEARL_MULTISIG_ACCOUNT_PREFIX = 100` and
  `pearlMultisigPath(vaultAccount, index)` returning
  `m/86'/808276'/100'/{account}'/{index}`. Bounds-checked: integer,
  non-negative, ≤ 2^31-1 on each component. Kept in a dedicated
  hardened account (`100'`) so multisig cosigner derivations cannot
  collide with the singlesig `RECEIVE_GAP_LIMIT` walk and an observer
  who learns one cosigner pubkey cannot link it back to the user's
  singlesig receive pool.
- `src/chains/pearl/multisig.ts` (NEW). The core vault-address builder.
  - `VaultDescriptor` shape: threshold, total, BIP-67-sorted pubkeys,
    bech32m address, 34-byte output script, 32-byte output key,
    tapleaf script, leaf version, internal key (NUMS), network.
  - `sortPubkeysBip67(pubkeys)`. Pure byte-lex sort returning a new
    array. Source order is never mutated.
  - `vaultDescriptorFromPubkeys(threshold, pubkeys, params)`. Validates
    threshold (integer, ≥ 1, ≤ n), cosigner count (1 ≤ n ≤ 15),
    pubkey shape (each 32 bytes), and duplicate-pubkey rejection.
    Calls `p2tr(TAPROOT_UNSPENDABLE_KEY, p2tr_ms(threshold, sorted), undefined, false)`
    — the NUMS internal key is passed explicitly (not defaulted) so
    the test suite can pin the binding. Extracts `leafScript` and
    `leafVersion = 0xc0` from `tr.tapLeafScript[0]` (the last byte of
    `script || leafVersion` is the version per the BIP-371 PSBT shape
    btc-signer hands back).
  - `vaultAddressFromPubkeys(...)` convenience wrapper.
  - `PEARL_MULTISIG_NUMS_INTERNAL_KEY` exported constant — same bytes
    as `@scure/btc-signer`'s `TAPROOT_UNSPENDABLE_KEY`, but importable
    without reaching into that package.
- `src/crypto/descriptor.ts` (NEW). The cosigner pubkey descriptor —
  what one user hands another to enrol in a vault.
  - JSON-with-frontmatter shape: `{ version: 1, type: "pearl-multisig-pubkey",
    network: "mainnet", xOnlyPubkey: <64-hex>, originPath: <BIP-86 path>,
    label: <1-64 chars> }`.
  - `encodePubkeyDescriptor` validates pubkey length, path regex,
    label length. Pretty-prints (two-space indent) — descriptors are
    read by humans before they're parsed by the import path.
  - `parsePubkeyDescriptor` is strict: bad JSON, wrong shape (array
    or non-object), wrong version, wrong type tag, wrong network, bad
    hex, bad path, bad label all throw distinct `E_DESCRIPTOR_*`
    errors. No partial parse — a silently-truncated descriptor risks
    funding the wrong vault.
- `src/ui/pages/Vaults.tsx` (NEW). Stub page gated by `multisigEnabled`.
  Self-bouncing: if rendered with the toggle off (deep link, stale
  bookmark) it redirects to `/dashboard`. Explains what primitives ship
  in v0.1.18 and what's coming. Links to GitHub.
- `src/ui/pages/Settings.tsx`. New "Experimental: multisig vaults"
  card with the on/off checkbox and the in-development warning.
- `src/ui/pages/Dashboard.tsx`. Conditional `Vaults` link, only
  rendered when the toggle is on. Labelled `(experimental)`.
- `src/App.tsx`. New `/vaults` route.
- `package.json`. Version 0.1.17 → 0.1.18.

### Tests (new)

- `tests/hd-multisig.test.ts` (10 tests). Bounds rejection (non-int,
  negative, overflow on both components), shape pinning
  (`m/86'/808276'/100'/{v}'/{i}`), prefix pin (`100`), non-collision
  with the singlesig receive path, determinism, real-seed derivation
  yields 33-byte compressed → 32-byte x-only, distinct (v, i) yields
  distinct pubkeys.
- `tests/pearl-multisig.test.ts` (20 tests). Uses real x-only pubkeys
  derived from the BIP-39 vector-1 seed under the multisig account
  (the cached `realPubkeys(n)` helper). Asserts: builds a valid Pearl
  bech32m P2TR for 2-of-3; internal key is NUMS (pinned against
  `TAPROOT_UNSPENDABLE_KEY`); address is order-independent (BIP-67);
  threshold change moves the address; output script is 34 bytes
  starting with `OP_1 0x20`; output key round-trips through
  `decodeTaprootAddress`; leaf version is `0xc0`; `sortedPubkeys` is
  identical regardless of input order; duplicate / threshold < 1 /
  non-integer threshold / threshold > n / empty set / > 15 cosigners /
  short pubkey are all rejected; 1-of-1 and 15-of-15 are accepted;
  golden vector snapshot for 2-of-3 of canonical pubkeys.
- `tests/descriptor.test.ts` (24 tests). Hex helpers (lowercase,
  fixed length, reject uppercase / wrong length / non-hex);
  encode round-trip; pretty-print; label trim; reject wrong-length
  pubkey / bad path / empty label / oversized label; parser strict
  on non-JSON / non-object / array / wrong version / wrong type /
  wrong network / bad pubkey hex / non-string pubkey / bad path /
  empty-after-trim label / oversized label / non-string label.

Full suite: **286 passed / 4 skipped** (the 4 skipped are
network-gated `pearl-rpc-live.test.ts` cases, same as v0.1.17).

## Findings

### Critical: 0

### High: 0

### Medium: 0

### Low: 0

## Notes & defence-in-depth observations

These aren't findings — just things the auditor wants on the record
so the next review pass has them.

**N1. NUMS internal key is the single most important footgun-prevention
in this construction.** If any future refactor sets the internal key
to a real cosigner pubkey (e.g. by accident defaulting to one of the
sorted pubkeys), any single holder of that pubkey could drain the
vault via key-path and bypass m-of-n entirely. The test
`internal key is the BIP-341 NUMS point (key-path spend disabled)`
locks this. Do not relax that test.

**N2. BIP-67 sort is what lets cosigners independently verify the
vault address.** Two cosigners with the same pubkey set and threshold
must compute the same address; otherwise a malicious originator can
hand each cosigner a different set, and they cannot detect it before
funding. The `address is independent of input order` test locks this.

**N3. Duplicate-pubkey rejection silently prevents a 2-of-3 from
collapsing into 2-of-2.** If two of the three "cosigners" are the
same key, the real key holder unilaterally satisfies the threshold.
The error is loud (`E_MULTISIG_DUPLICATE_PUBKEY`) and intentional.

**N4. The toggle is off by default and gates *only* the surface, not
the build.** The primitives compile in regardless. This is on purpose:
audits run against the same bytes that ship, and a future bug class
that requires the primitives to be loaded (e.g. memory disclosure
through worker init) wouldn't be masked by the toggle. The cost is
roughly +5 kB of compressed JS for users who never turn the surface
on — acceptable.

**N5. `STORAGE_KEY` bump from v3 → v4.** A user upgrading from
v0.1.17 loses any persisted UI state on first load — they get the
defaults (theme=system, rpc override empty, tip on, multisig off).
This is consistent with how every previous shape change was handled
in this codebase. RPC override is the only field a user might
notice; they will need to re-enter it.

**N6. The Vaults stub is intentionally non-functional.** No
`createVault`, no `signPearlPsbt`, no `signSafeTx` — just an explainer
+ link. A user who toggles the surface on and lands on `/vaults`
sees a clear "in development" banner and a description of what
primitives compile in. The audit window for the spendable surfaces
is therefore separate from this audit window for the primitives.

**N7. Vaults route is self-bouncing.** If `multisigEnabled` is false
when `/vaults` is rendered, the page issues `navigate("/dashboard",
{ replace: true })` from `useEffect`. A deep link from a stale
bookmark cannot present the surface to a user who turned the toggle
off.

### Open carried items

| Finding                                   | Status                  |
| ----------------------------------------- | ----------------------- |
| O1-H-2 (signature freshness via Eth time) | Open — UX only, deferred|
| O2-H-2 (chainId binding from RPC)         | Open — defense-in-depth |

No regressions on any previously fixed item.

## Verdict

**Ship.** Lands the BIP-342 tapscript m-of-n primitives behind an
opt-in toggle, default off. 54 new tests cover derivation, address
construction, NUMS binding, BIP-67 determinism, descriptor format,
strict parser. No new dependencies (uses `@scure/btc-signer`'s
existing `p2tr` / `p2tr_ms` / `TAPROOT_UNSPENDABLE_KEY`). Surface
is non-functional by design — only primitives ship for audit. User
flows land in v0.1.19+.

## Coming up (v0.1.19 punch list)

Per `RESEARCH-multisig.md` §6:

1. `services/pearl-multisig.ts` — vault registry persisted to Dexie.
2. `state/multisig-store.ts` — vault CRUD + cached UTXO list per vault.
3. `worker.ts.signPearlPsbt` — Schnorr-sign a tapscript leaf in the
   worker (key never leaves the worker).
4. `services/safe-client.ts` — Gnosis Safe Transaction Service
   read/draft for the Ethereum side.
5. `worker.ts.signSafeTx` — EIP-712 SafeTx signature.
6. UI pages: `CreateVault`, `JoinVault`, `Vault` (balance + queue),
   `SendFromVault`, `SignQueuedTx`, `SignSafeTx`.

Each lands in its own audit cycle.
