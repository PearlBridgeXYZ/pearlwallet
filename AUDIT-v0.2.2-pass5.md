# Audit pass 5 — Pearl multisig v0.2.2 (convergence check)

## Summary

Pass 5 is the post-pass-4 convergence check. The three pass-4 fixes
(H1 dust-coalesce fee, L1 cross-vault URL binding, L2 origin-path bounds)
hold up under adversarial review. No new findings at Critical, High,
or Medium severity. Two Low/Note items remain advisory (already flagged
in pass 4) and one minor test-coverage gap was opened by the new
defenses. Build, typecheck, and test all clean.

- `npm run typecheck` — clean (0 errors)
- `npm test` — 347 passed / 4 skipped (24 files, 1 skipped)
- `npm run build` — clean (vite build, 4.75s)

The multisig surface is now defended by three concentric layers (UI →
service → worker) and every adversarial scenario I retraced from
passes 1–4 lands at one of those layers. The H1 fix's algebra is
correct in every branch I exercised (change == 0, change just under
dust, change at dust threshold, change > dust, amount > sum). The L1
guard does not regress legitimate routing. The L2 path cap
(≤128 chars, ≤12 separators) accommodates the worst legitimate
`pearlMultisigPath` output (~45 chars, 5 separators) with room to
spare.

## Critical

None.

## High

None.

## Medium

None.

## Low

None new at v0.2.2. Pass-4 advisory items remain (see Notes 1–3
inherited from pass 4 below).

## Notes

### N1. Pass-4 H1 fix algebra is correct in all branches I checked

`src/services/multisig.ts:336-350`. The fix changes the dust-coalesce
branch from `fee = estimateMultisigFee(.., numOutputs=1, ..)` to
`fee = sum - opts.amountGrains`. I retraced every branch:

- `change >= DUST_LIMIT_GRAINS` (no coalesce): `fee` keeps its 2-output
  estimate. PSBT has dest + change, actual fee = `sum - amount - change
  = sum - amount - (sum - amount - fee_2out) = fee_2out`. ✓ matches.
- `change == 0` exactly (`sum == amount + fee_2out`): coalesce fires
  (0 < 546). `fee = sum - amount = fee_2out`. PSBT has 1 output worth
  `amount`, actual fee = `sum - amount = fee_2out`. ✓ matches.
- `0 < change < 546`: coalesce fires. `fee = sum - amount` (includes the
  saved 86 vbytes + the dust). PSBT has 1 output, actual fee =
  `sum - amount`. ✓ matches.
- `amount > sum`: short-circuited at line 334 (`E_INSUFFICIENT_FUNDS`)
  before reaching coalesce. The recomputed-1-output guard at line 347
  is unreachable in normal flow (since `fee_1out < fee_2out` and we
  already passed the `fee_2out` guard) but is harmless belt-and-braces.

`assertPsbtMatchesPreview` now passes the originator's own draft in
the coalesce regime, confirmed by the regression test added at
`tests/v020-multisig-flows.test.ts:847+`. Pass-3 defense + pass-4 fix
co-exist correctly.

### N2. Pass-4 L1 fix doesn't break legitimate routing

`src/ui/pages/VaultPendingTxDetail.tsx:56-60`. The new guard
`if (p && v && p.vaultId !== v.id) { setVault(null); setPending(null); }`
fires only when BOTH records are present and disagree. Legitimate
flow (`/vaults/A/tx/pendingForA`): vault A and pending-A load,
`pending.vaultId === A.id`, guard skipped, normal render. ✓

Edge cases:
- URL points at a non-existent vault → `getVault` returns `undefined`,
  guard skipped, "Vault not found" branch renders. ✓
- URL points at a non-existent pending → same shape, "Draft not found"
  renders. ✓
- Tampered URL `/vaults/A/tx/pendingForB` → both load, mismatch fires,
  both set to null, "Draft not found" renders. The worker's
  `signPearlMultisigPsbt` would also refuse (via `outputScript`
  binding) if the user clicked Sign — but the UI never reaches that
  click because the action panel is gated on `pending !== null`. ✓
- Same vault, stale pending id (deleted on another device): pending
  is undefined after fetch → `p && v` is false → guard skipped, "Draft
  not found" branch renders. ✓

I also confirmed `VaultDetail`'s PendingRow generates links from
`listPendingTxs(vault.id)` so the list view's links are inherently
vault-scoped and won't surface cross-vault entries.

### N3. Pass-4 L2 bounds are loose enough for legitimate paths

`src/crypto/descriptor.ts:33-48`. `isValidOriginPath` adds
`length ≤ 128` and `depth ≤ 12` on top of the existing
`PATH_RE = /^m(\/\d+'?)+$/` check. The only legitimate producer is
`pearlMultisigPath(vaultAccount, keyIndex)` (worker.ts:552, :662)
which formats as `m/86'/808276'/100'/{vaultAccount}'/{keyIndex}`.
Worst-case length is `m/86'/808276'/100'/2147483647'/2147483647` ≈
45 chars with 5 separators — well inside both caps. No upstream
caller can produce a legit path that would be silently rejected.

Importing a peer's descriptor (`importCosignerDescriptor` →
`parsePubkeyDescriptor`) is the only place a path coming from outside
this wallet enters the bounds check. A hostile descriptor with a
deeply-nested path now fails fast on `E_DESCRIPTOR_BAD_PATH`, which is
the intended behavior — the pubkey would still be validated separately,
but the wizard's address-verification panel won't render a misleading
path.

### N4. Test-coverage gaps opened by pass-4 fixes (minor)

- No unit test exercises the new `PATH_MAX_LEN=128` / `PATH_MAX_DEPTH=12`
  bounds on `isValidOriginPath`. `tests/descriptor.test.ts` has a
  "malformed origin path" case for `not/a/path` but nothing for the
  bounded-regex cases (e.g. `m/86'/808276'/100'/0'/` + extra deep
  segments, or a 200-char path). Cheap to add; current state is correct
  but uncovered.
- No test exercises the new `VaultPendingTxDetail` cross-vault URL
  guard at the UI layer (the page is React, and `tests/` is node-only
  vitest, so this would need a jsdom harness — already a pre-existing
  test-scope limitation, not a regression).
- The H1 regression test at `tests/v020-multisig-flows.test.ts:862+`
  is pure-algebra (PSBT composed inline, no `composeVaultSend` round-trip
  through the worker). The contract is correct — but a future change
  to `composeVaultSend` could drift if the actual function isn't
  exercised. Not blocking; would catch a regression in the wrong
  module instead of the originating one.

### N5. Pass-4 advisory items unchanged (still advisory)

These are inherited from pass 4 and remain non-correctness:

- **Threshold=1 UX caveat** (pass-4 Note 1): `CreateVault` still
  accepts `threshold === 1` silently. Not a fund-safety issue —
  the on-chain primitive is fine — but UX would benefit from a
  warning when `threshold === 1 && total > 1`.
- **`persistComposedAsPending` outputScript binding** (pass-4 Note 2):
  The only callsite (`SendFromVault.saveDraft`) passes a worker-
  composed PSBT that's already vault-bound, so production is safe.
  Defense-in-depth parity with `signPendingTx`/`broadcastPendingTx`
  would harden future callers.
- **`inspectPsbt` reports `witnessScriptHex` from input 0 only**
  (pass-4 Note 3): All compose paths produce homogeneous inputs;
  the worker re-checks every input at sign time. Future cross-vault
  / coinjoin-style PSBTs would need a multi-input report.

### N6. Cross-check of prior-pass defenses (re-verified)

All three defensive layers still intact, none re-broken by the pass-4
edits:

- **Worker per-input vault binding** (`src/crypto/worker.ts:696-703`):
  every input's `witnessUtxo.script` must equal `vault.outputScript`.
- **Worker BIP-67 pubkey sort defense** (`worker.ts:585-589`): refuses
  un-canonicalised pubkey order.
- **NUMS internal-key pin** (`chains/pearl/multisig.ts`): unchanged.
- **`signPendingTx` invariants** (`multisig.ts:800-815`): inspect →
  `assertPsbtMatchesPreview` → foreign-signer check → idempotency
  short-circuit. ✓
- **`broadcastPendingTx` invariants** (`multisig.ts:843-853`):
  inspect → `assertPsbtMatchesPreview` → foreign-signer check →
  threshold check. ✓
- **`createVault` re-derive guard** (`multisig.ts:167-176`):
  worker re-derives the pubkey at the requested `(vaultAccount,
  keyIndex)` and throws `E_VAULT_PUBKEY_PATH_MISMATCH` on
  disagreement. ✓
- **CreateVault stale-write guard** (`CreateVault.tsx:128-142`):
  captures indices at call time and refuses to commit a derived
  result whose slot the user has since changed. ✓
- **`feeSuspiciousReason`** (`multisig.ts:610-621`): blind-fee
  refuse + 20% threshold flag. Unchanged. ✓
- **Paste-back validator** (`VaultPendingTxDetail.applyPaste`,
  `:110-175`): five-check rejection (witnessScriptHex non-empty +
  equal, input count, output-set equality, no foreign signers).
  Unchanged. ✓
- **`OutputsPreview` + foreign-signer banner + suspicious-fee banner
  in `SignMultisigPsbt`**: unchanged. Sign button still disabled on
  `foreignSignersHex.length > 0 || feeSuspiciousReason(info) !==
  null`. ✓

## Build / test / typecheck

```
$ npm run typecheck
> tsc --noEmit
(0 errors)

$ npm test -- --run
Test Files  24 passed | 1 skipped (25)
Tests       347 passed | 4 skipped (351)
Duration    7.72s

$ npm run build
> tsc --noEmit && vite build
✓ 972 modules transformed.
dist/index.html                   2.88 kB │ gzip:   1.39 kB
dist/assets/worker-C2mYp-n_.js  184.43 kB
dist/assets/index-CSKZltxz.css   23.88 kB │ gzip:   4.77 kB
dist/assets/ccip-Da-dFiEA.js      2.47 kB │ gzip:   1.19 kB
dist/assets/index-BELiczCV.js   732.46 kB │ gzip: 226.33 kB
✓ built in 4.75s
```

The 500 kB chunk-size warning on `index-*.js` is pre-existing
(bundled cryptography + React + Dexie), not introduced by v0.2.2.

---

VERDICT: CLEAN — ready to ship
