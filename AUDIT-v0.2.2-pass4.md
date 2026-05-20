# Audit pass 4 — Pearl multisig v0.2.2

## Verdict

**1 H / 0 M / 2 L / 3 Note. Ship-blocker: YES (H1).**

Passes 1–3 hold up under adversarial review. The witness-script binding, output-mutation defense, foreign-signer partition, blind-fee refusal, CreateVault path-vs-pubkey re-derivation, and service-level `assertPsbtMatchesPreview` are all present and correctly wired. The codebase is at the point where every remaining attack I tried got caught by at least one of the three concentric defenses (UI → service → worker).

However, the v0.2.2 defense-in-depth (`assertPsbtMatchesPreview`) interacts pathologically with the existing dust-coalesce branch in `composeVaultSend`: the originator's own draft is rejected by their own wallet whenever a send happens to land in the dust window. That is reproducible, easy to hit, and locks the user out of their own pending tx. Ship-blocker until fixed.

---

## Findings

### H1. Dust-coalesced sends fail `assertPsbtMatchesPreview` on the originator's own draft

- **Severity:** High (functional regression introduced by pass 3 L1, manifest in every send that lands in the dust-coalesce branch).
- **File:** `src/services/multisig.ts:313-386` (`composeVaultSend`), `src/services/multisig.ts:628-680` (`assertPsbtMatchesPreview`), interacting with `src/services/multisig.ts:790-826` (`signPendingTx`).
- **Threat / repro:**
  `composeVaultSend` does two-pass fee planning. When initial `change = sum − amount − fee_2out < DUST_LIMIT_GRAINS (546)`, it drops the change output and *recomputes the fee for 1 output*: `fee_1out = fee_2out − PER_P2TR_OUTPUT_VBYTES × feerate = fee_2out − 86` (at the default 2 sat/vb). It then returns `feeGrains: fee_1out, changeGrains: 0n`, and the PSBT has a single destination output.
  But the on-wire fee of that PSBT is `sum − amount`, not `fee_1out`. Algebraically:
  `PSBT_fee − preview.feeGrains = (sum − amount) − fee_1out = change_2out + 86 ≥ 86`.
  So the originator's PSBT *always* over-pays by at least 86 grains in the coalesce branch, and the stored preview understates the fee by the same amount.
  `SendFromVault.saveDraft` writes that preview verbatim, then immediately calls `signPendingTx`, which runs `assertPsbtMatchesPreview(pre, pending.preview, vault.pearlAddress)` and throws `E_MULTISIG_OUTPUT_MISMATCH: fee is X grains (expected Y)`. Even if `signImmediately=false`, opening the draft later triggers the same assertion (UI banner + disabled Sign/Broadcast buttons).

  Repro: any 2-of-3 vault with UTXOs sized such that the largest one slightly exceeds `amount + fee_2out` but the leftover is < 546 grains. E.g., vault has one 1_000_000-grain UTXO, user sends 999_500 grains: change_2out = 1_000_000 − 999_500 − fee_2out, with fee_2out ≈ 314 grains → change_2out ≈ 186 grains → coalesce fires → preview.fee = fee_1out = 228 → PSBT_fee = 500 → mismatch.

- **Fix:** In the dust-coalesce branch, set `fee = sum - opts.amountGrains` so the preview matches what the PSBT actually pays:
  ```ts
  if (change < DUST_LIMIT_GRAINS) {
    numOutputs -= 1;
    const recomputed = estimateMultisigFee(picked.length, numOutputs, feerate);
    if (sum < opts.amountGrains + recomputed) throw new Error("E_INSUFFICIENT_FUNDS");
    fee = sum - opts.amountGrains; // actual fee = excess goes to miners
    change = 0n;
  }
  ```
  Add a regression test in `tests/v020-multisig-flows.test.ts` that simulates a dust-coalesce compose end-to-end through `assertPsbtMatchesPreview`. Bonus: fix the same shape in `src/services/pearl-tx.ts` (singlesig has the same drift; it just doesn't manifest because singlesig has no preview-vs-PSBT assertion).

---

### L1. `VaultPendingTxDetail` doesn't bind URL `:id` to `pending.vaultId`

- **Severity:** Low (worker catches the unsafe case; UX surface is misleading until then).
- **File:** `src/ui/pages/VaultPendingTxDetail.tsx:25-57`.
- **Threat / repro:**
  The page loads `vault = getVault(urlVaultId)` and `pending = getPendingTx(urlPendingId)` independently and never asserts `pending.vaultId === urlVaultId`. A user opening a phishy deep link like `/vaults/<vaultA>/tx/<pendingFromVaultX>` will see:
  - the page header labeled with vault A,
  - the preview from pending X (destination, amount, fee),
  - `inspectPsbt(X.psbt, A.threshold, A.sortedPubkeysHex)` reporting every signer (if any) as "foreign" — but if the draft has zero sigs, no foreign-signer banner appears,
  - `assertPsbtMatchesPreview` may pass or fail depending on whether X's change output (decoded from PSBT) happens to equal A's `pearlAddress`. If X has `changeGrains == 0`, the change check is skipped, dest/amount/fee come from X and match X's preview → all three UI gates green.
  Clicking "Sign with my key" then enters the worker (`signPearlMultisigPsbt`), which re-derives A's `outputScript` and bounces with `E_MULTISIG_PSBT_FOREIGN_INPUT` because input 0's `witnessUtxo.script` matches X, not A. So no actual key compromise — but the user has been led through a fake "this is your vault A draft" UI all the way to the error toast, which is a credible setup for phishing patience-bombs ("just click again, try once more").
- **Fix:** In `VaultPendingTxDetail.tsx`, after `setVault`/`setPending`, add an explicit guard:
  ```ts
  if (p && v && p.vaultId !== v.id) {
    setPending(null); // render the "draft not found" branch
  }
  ```
  Same pattern in `VaultDetail.tsx`'s `PendingRow` if you want belt-and-braces on the list view, though the list is generated from `listPendingTxs(vault.id)` so the binding is enforced by the query.

---

### L2. `PATH_RE` in descriptor parser has no depth/length cap

- **Severity:** Low (display / phishing-via-misleading-origin; no signing-time impact).
- **File:** `src/crypto/descriptor.ts:34` (`PATH_RE = /^m(\/\d+'?)+$/`).
- **Threat / repro:**
  A pasted descriptor with `originPath` set to `m/0/0/0/.../0` (10 KB worth of segments) or `m/86'/808276'/100'/0'/0/0/0` (legit-looking with extra depth) passes the regex. The pubkey is still validated separately, so funds aren't at risk — but the `CreateVault` Confirm panel displays the path verbatim, which is the only signal a careful user has that the cosigner's claimed slot is sane. An attacker who controls a cosigner-side wallet can supply a path that *looks* canonical except for a trailing segment, sowing confusion.
- **Fix:** Cap depth to ~10 segments and total length to ~120 chars; reject `\d+` with > 10 digits. e.g. replace with `/^m(?:\/[0-9]{1,10}'?){0,10}$/` and pre-check `originPath.length <= 128`. Apply both in `encodePubkeyDescriptor` and `parsePubkeyDescriptor`.

---

### Note 1. `MULTISIG_MIN_THRESHOLD = 1` with no UX caveat

`CreateVault` accepts `threshold = 1` silently. A 1-of-N vault means any cosigner can drain, which is rarely what a user picking "multisig" actually wants. The on-chain primitive is fine; the wizard just doesn't warn. Add a non-blocking advisory below the threshold field when `threshold === 1 && total > 1`: "Any single cosigner can spend this vault on their own."

### Note 2. Originator's `persistComposedAsPending` doesn't bind PSBT to vault by `outputScript`

`persistComposedAsPending` (`src/services/multisig.ts:754`) trusts the caller to pass a PSBT composed against the given vault. The only callsite, `SendFromVault.saveDraft`, gets the PSBT from `composeVaultSend` → worker → guaranteed-bound, so production is safe. But the function is exported and is a tempting target for a future caller (CLI, devtools snippet) that wouldn't realize the binding isn't asserted here. Add `if (info.witnessScriptHex !== bytesToHex(descriptorFromRecord(opts.vault).outputScript)) throw new Error("E_MULTISIG_UTXO_NOT_VAULT")` for parity with `signPendingTx`/`broadcastPendingTx`.

### Note 3. `inspectPsbt` reports `witnessScriptHex` from input 0 only

For multi-input PSBTs the inspector treats input 0 as representative. The compose path always produces homogeneous inputs (all from the same vault), and the worker's `signPearlMultisigPsbt` re-checks every input. So this is fine in practice — but if a future feature ever consumes externally-composed multi-input PSBTs (cross-vault sweep, coinjoin-like merge), `inspectPsbt`'s single-input report becomes inadequate. Add a sanity check that all inputs share the same `witnessUtxo.script` or expose the set.

---

## Already-defended cross-check

All three prior-pass fixes are intact:

- **Pass 1 (paste-back validator):** `VaultPendingTxDetail.applyPaste` at `:100-165` checks (1) `witnessScriptHex` non-empty, (2) equal `witnessScriptHex`, (3) `inputCount` unchanged, (4) `psbtOutputsEqual`, (5) no foreign signers. Confirmed.
- **Pass 2 (output mutation defense + foreign-signer partition):** `inspectPsbt` returns `outputs[]` with `address`/`amountGrains`/`scriptHex` (`:557-569`) and partitions signers via `validPubkeysHex` (`:539-552`). `psbtOutputsEqual` helper (`:688-695`) is correct. UI calls in both `VaultPendingTxDetail` (paste-back) and `SignMultisigPsbt` (block on `foreignSignersHex.length > 0`, `:219-224`, `:248`). Confirmed.
- **Pass 3 (blind-fee + CreateVault race + service defense):**
  - `feeSuspiciousReason` (`:604-616`) treats `feeUnknown` as refuse-to-sign, flags fee > 20% of inputs. `SignMultisigPsbt` displays fee/inputs prominently and disables Sign on `feeSuspiciousReason !== null` (`:249`, `:272`). `VaultPendingTxDetail` shows live fee vs preview (`:266-279`).
  - `createVault` (`:127-195`) re-derives pubkey via worker at `(myVaultAccount, myKeyIndex)` and throws `E_VAULT_PUBKEY_PATH_MISMATCH` on mismatch (`:167-176`). `CreateVault.tsx` captures indices at call time and refuses stale results (`:122-149`).
  - `signPendingTx` and `broadcastPendingTx` (`:790-870`) both call `assertPsbtMatchesPreview` and enforce `foreignSignersHex.length === 0`. Confirmed — except that the new assertion fires on the wallet's own legitimate draft in the dust-coalesce branch (H1).

Worker's vault-binding refusal (`signPearlMultisigPsbt`, `worker.ts:696-703`) per-input `witnessUtxo.script === vault.outputScript` check is intact and catches cross-vault PSBTs, mixed-input PSBTs, and substituted prevouts. NUMS internal-key pin (`chains/pearl/multisig.ts:130`) and BIP-67 sort (`:124`) are unchanged.

---

## Test gaps

- **Dust-coalesce end-to-end:** no test composes a real PSBT through the dust-coalesce branch and runs it back through `assertPsbtMatchesPreview`. Adding this test catches H1 immediately and prevents regression.
- **Cross-vault URL:** no test exercises `getPendingTx(idFromVaultX)` against `vault = vaultA`. Easy to add at the service layer.
- **`derivePearlMultisigPubkey` bounds:** worker handler validates `vaultAccount`/`keyIndex` ∈ [0, 0x7fffffff] but no test confirms the throw on `2**31` or negative.
- **Descriptor path with extreme depth/length:** no test pastes a 5 KB `originPath` to see whether the wizard renders / truncates / rejects.
- **Worker origin guard:** the `ev.origin && expected && ev.origin !== expected` check is uncovered; no test confirms a cross-origin postMessage is dropped (admittedly hard outside a real browser).
- **Idempotent sign-twice path through the service:** `signPendingTx` skip-when-already-signed branch (`:809-811`) is asserted only indirectly by the "inspectPsbt is a safe idempotency probe" test; a direct test of `signPendingTx` short-circuiting would harden the contract.
- **Mainnet-only assumption:** every `inspectPsbt` call hardcodes `"mainnet"` in the address decoder (`:564`). The codebase has only one network so this is correct, but no test asserts that `info.network === "mainnet"` is the only legal value. If a future testnet is added, this is the line that will silently mis-decode.

---

End of pass 4.

---

## Post-audit fixes shipped (same session, 2026-05-20)

Per project rule "found bugs get fixed, not flagged" — the three actionable findings were applied immediately. `tsc --noEmit` clean. Full test suite 347/347 (was 346/346; +1 regression test for H1).

- **H1 (composeVaultSend dust-coalesce fee mismatch)** — `src/services/multisig.ts:336-348`. In the dust-coalesce branch the recomputed 1-output fee estimate is no longer stored as `preview.feeGrains`; instead `fee = sum - opts.amountGrains` is stored, matching the on-wire PSBT's actual fee. `assertPsbtMatchesPreview` now passes the originator's own draft. Pre-existing `E_INSUFFICIENT_FUNDS` guard preserved (now keyed off the recomputed 1-output estimate).
- **H1 regression test** — `tests/v020-multisig-flows.test.ts:847+`. Asserts that in the dust-coalesce regime: (a) a preview with `feeGrains = sum - amount, change = 0` passes `assertPsbtMatchesPreview`, and (b) a preview with the buggy `fee_1out` value throws `E_MULTISIG_OUTPUT_MISMATCH: fee...`. Pure algebra; needs no IndexedDB or worker.
- **L1 (cross-vault URL no binding)** — `src/ui/pages/VaultPendingTxDetail.tsx:45-65`. After loading vault and pending in parallel, `pending.vaultId !== vault.id` is rejected (sets both to null → "not found" branch renders). Worker still refuses to sign on `outputScript` mismatch; this prevents the misleading UI state where pending P for vault B would appear under vault A's header.
- **L2 (PATH_RE unbounded)** — `src/crypto/descriptor.ts:33-49`. `isValidOriginPath` adds `≤128 chars` and `≤12 separators` caps in addition to the regex. Both `encodePubkeyDescriptor` and `parsePubkeyDescriptor` route through it.

Note 1/2/3 remain advisory and unchanged — UX warning for threshold=1, `persistComposedAsPending` outputScript-binding parity, and multi-input `inspectPsbt`. None are correctness or fund-safety issues at v0.2.2.
