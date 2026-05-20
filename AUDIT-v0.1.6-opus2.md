# Pearl Web Wallet v0.1.6 — Independent Adversarial Review (opus2)

**Scope:** v0.1.6 (commit `5cab336`), focus on the eight question areas in the brief.
**Method:** read-only; no prior v0.1.5/v0.1.6 audit reviewed.
**Verdict (one line):** v0.1.6 closed the H1 payload-binding gap correctly in shape but left the binding **opt-in**; the new BroadcastChannel layer introduces two reachable footguns; broadcast is still unimplemented but the previews mislead the user about totals; clock-skew on deadline is a real (small) attack window. No loss-of-funds primitive in shipped code (broadcast() is a no-op) but several time-bombs for v0.2.

---

## H — High

### H1. `verifyRelayerMintSig.expected` is OPTIONAL — same gap, new flag

`src/services/bridge.ts:71-115` accepts `expected?: IntentExpectation`. If a caller omits it, the lines 90-100 binding checks are skipped, and we fall straight through to the role check — which is exactly the pre-fix behavior the audit added this struct to prevent.

`getMintSignature` (line 205-216) **also** declares `expected?` optional and passes it through verbatim. So:

```ts
await getMintSignature(network, intentId);   // compiles, runs, BINDS NOTHING
```

There is currently **zero** in-wallet caller of either function (only the export sites). `Bridge.tsx:56-60` short-circuits broadcast. So no live exploit today. But the v0.1.5 audit's stated remedy was "extend the verifier to take expected payload and assert equality before role check" — shipping it as `?` re-introduces the exact bug as a forgetfulness-class regression. The first v0.2 broadcast wire-up that types `await getMintSignature(net, id)` because TypeScript lets them will run with a role-valid but recipient-swapped payload.

**Fix:** make `expected` required on both function signatures. Provide a separate `verifyRelayerMintSig_NO_BINDING(...)` (named to scream) for diagnostic/testing tools that explicitly want to skip. Add a unit test that calls `verifyRelayerMintSig(sig, "mainnet")` (no `expected`) and asserts compile error / runtime throw. Today there is no test that exercises either function at all (grep `verifyRelayerMintSig` in `tests/` returns nothing).

### H2. Cross-tab race: unlock-vs-wipe corrupts Tab A state

`src/state/wallet-store.ts:208-233` + `src/state/wallet-store.ts:112-127`.

Sequence:
1. Tab A: user submits unlock. `cryptoWorker.call("unlock", …)` is in flight.
2. Tab B: user wipes. `broadcastKeystoreEvent({type:"wiped"})` fires.
3. Tab A `onmessage` runs `cryptoWorker.reset()` and `set({status:"no-wallet", blob:null, addresses:null})`. The reset rejects Tab A's inflight unlock with `E_WORKER_RESET`. So far OK.
4. **But** if the inflight unlock completes a microtask BEFORE the broadcast `onmessage` handler runs (timing-dependent — Promise resolution vs MessageEvent dispatch order), Tab A reaches line 219 `await loadKeystore()`. Now Tab B's wipe has deleted the row → `rec === undefined`. Tab A skips the `if (rec)` block and falls through to `set({status:"unlocked", addresses: out.addresses, lastActivity})` at line 231.
5. Final Tab A state: `status="unlocked"`, `addresses` set, `blob = null` (cleared by step 3). On next render, App.tsx routes to /dashboard. The wallet shows balances and addresses. The user clicks Send → broadcast no-op (today) — but in v0.2, the worker session is still live and would happily sign. On refresh: `init()` calls `loadKeystore()` → undefined → `status="no-wallet"`, blob stays null, addresses cleared. Mnemonic that was just exfilable via Settings (status was "unlocked", so the wipe required no password to re-export) is now lost.

**Fix:** when `blob-updated` or `wiped` arrives, take an explicit lock against in-flight `unlock`/`createWallet`/`restoreWallet`/`changePassword`. Simplest: an `AsyncLock` in `wallet-store` that wraps all state-mutating store methods; broadcast handlers grab the same lock before applying.

### H3. Cross-tab race: changePassword-vs-wipe loses the new blob

`src/state/wallet-store.ts:268-287`.

1. Tab A: `changePassword(old, new)`. `cryptoWorker.call("changePassword", …)` returns `{blob: newBlob}`.
2. Before line 275 `await loadKeystore()`, Tab B wipes.
3. Tab A: `rec = await loadKeystore()` → undefined. `if (rec)` false → skip `db.keystore.put`. Line 280: `set({blob: out.blob})`. Tab A's in-memory store now has `status` (unchanged from prior — could be "unlocked"), `blob = newBlob`, but **disk is empty**.
4. Tab A broadcasts `blob-updated` → Tab B's handler reloads, gets undefined, no-ops.
5. Tab A continues to function until refresh. On refresh, `init()` finds no keystore → `status="no-wallet"`, blob discarded. Mnemonic is lost (encrypted-at-rest only existed in the volatile in-memory `blob` field).

**Fix:** in `changePassword`, after `loadKeystore` returns undefined, `set({status:"no-wallet", blob:null, addresses:null})` (treat as wiped). Same lock as H2 also closes this.

---

## M — Medium

### M1. Clock skew → accept truly-expired relayer signatures

`src/services/bridge.ts:86-89`. Deadline is checked against `Date.now()` with no skew tolerance and no server time fetch. A user with a slow system clock (NTP not running on a fresh VM, manually-set Windows time, mobile that lost time over a long airplane mode session, deliberate JS spoofing via Date override in a malicious extension) will accept signatures the relayer/contract consider expired.

Concrete: clock 10 min slow. Relayer issued sig at `T_real`, `deadline = T_real + 5min`. User opens wallet at `T_real + 8min`. User's `Date.now()/1000 = T_real - 2min`. `deadline (T_real+5m) > nowSec (T_real-2m)` → accepted. Real-time it's already 3 min past expiry. If the contract enforces deadline strictly, this is a contained DoS (broadcast reverts, gas lost). If the contract's deadline window is generous OR the relayer's `deadline` was set narrow to bound a replay window THEY know about, the wallet has accepted a payload that should be considered invalid for replay/withdrawal-of-consent reasons.

Inverse risk (clock fast → reject valid sigs) is just UX friction.

**Fix:** fetch trusted time from the RPC (`eth_getBlockByNumber("latest")` → `timestamp`) on bridge open; reject sig if `deadline - blockTimestamp < 60s`; warn user if `|Date.now()/1000 - blockTimestamp| > 120s`. Document the contract's expected deadline window.

### M2. SendPRL "Total" line previews a tx that cannot be broadcast

`src/ui/pages/SendPRL.tsx:113-114` shows a `font-medium` "Total" with grain math. Line 54-59 `broadcast()` returns a setError("...broadcast UI lands in v0.2..."). The Bridge page has the same shape (`Bridge.tsx:104-156`).

A user who clicks Review, enters their password, clicks Send, and gets the inline error has reasonable grounds to believe the preview reflects a real outgoing tx. It doesn't — there's no fee model, no UTXO selection, no input set, no change output. The "Fee (normal): 0.00005 PRL" is a placeholder constant (`FEE_BY_TIER`, line 12-16). The actual broadcast in v0.2 will need a coin-selector + fee estimator that will not produce that "Total".

**Misleads the user about**: (a) the fee amount, (b) total spend, (c) the fact that this *could* execute. The password input + "Send" button is a UI commitment the wallet doesn't honor.

**Fix:** until broadcast lands, replace the password field + "Send" button on PRL/WPRL/Bridge previews with a disabled banner "Sends from this UI ship in v0.2 — use https://pearlbridge.xyz". Or remove the password field entirely and gate the preview behind a "Coming in v0.2" stub. Today the UI shape is itself a UX bug: it lies about being a wallet you can spend from.

### M3. Hostile sentry can under-report balance via fake vin

`src/services/pearl-rpc.ts:131-134`. The walk deletes `utxo.delete(`${vin.txid}:${vin.vout}`)` for every vin in every tx returned by `searchrawtransactions(address)`. A hostile sentry can include a synthetic tx in its response whose `vin` points at a real UTXO of ours (`txid:vout`) without that tx actually existing on chain. We delete the credit. User sees zero balance.

Not loss-of-funds (chain state is intact; switching to a clean RPC restores the view). But it's a DoS the user can't diagnose without comparing against a second RPC. The `Settings → Pearl RPC override` UI helps mitigate but only if the user already suspects the default RPC.

**Fix:** before deleting a UTXO on a vin, require that the same tx ALSO has the spending tx's txid on chain (`getrawtransaction(tx.txid)` round-trip), OR that the tx in question is one whose outputs we credited (i.e., `tx.txid` was a producer txid in our walk). Better: get-utxo-set RPC if the sentry exposes one. Today the wallet trusts the sentry to send only well-formed history.

### M4. Hostile sentry can over-report balance via duplicate first-seen credit

`src/services/pearl-rpc.ts:127-129`. First-seen wins on `seenOutputs`. If the sentry returns a vout for `(txid:vout)` with `value=1000` on page 1, then the real tx with `value=1` on page 2, we credit 1000. UI shows inflated balance; user attempts to spend; broadcast fails (no such UTXO). Confidence-only DoS, but combined with the "preview misleads" pattern (M2), increases the surface area for "the wallet showed me 1000 PRL".

**Fix:** verify each credited UTXO via `gettxout(txid, vout, true)` (mempool+chain) before committing it to the total. Or pin to a fresh hash-checked block height between pages so a hostile sentry can't backfill different histories.

---

## L — Low

### L1. AAD label binds version only, not derivation context

`src/crypto/keystore.ts:7` — `AAD = TextEncoder().encode("pearl-web-wallet-v1")`. The constant only authenticates the version string. It does NOT bind to: KDF iterations, salt, IV, network selection, or any wallet identity. Two pearl-web-wallet v1 blobs encrypted with different passwords from different users with different mnemonics are AAD-interchangeable — an attacker who can swap a stored blob (compromised browser sync, malicious extension with IndexedDB access, restored backup from a different user) doesn't get any AAD-mediated rejection. They still need the password to decrypt, so this is not a loss-of-funds primitive — but the AAD comment in the code implies stronger context binding than `"pearl-web-wallet-v1"` provides.

**Fix:** include `version || kdf || kdfIterations || network` in AAD (e.g. `JSON.stringify({v:1, kdf:"PBKDF2", iter:600000})`). Reject blob if reconstructed AAD doesn't match. Cost: zero. Today's AAD is performative.

### L2. BIP-39 passphrase support absent — silent restore-mismatch risk

`src/crypto/mnemonic.ts:18-20` calls `bip39.mnemonicToSeed(phrase, "")` with empty passphrase, hardcoded. Two failure modes:
- User generated mnemonic in pearl-web-wallet, tries to restore in another wallet that DOES support BIP-39 passphrase (e.g., Sparrow, Trezor Suite). If they happen to fat-finger a passphrase, they get a "valid" but different wallet — silently. Recoverable since they can re-restore empty here.
- User generated mnemonic in a wallet that USES a passphrase ("hidden wallet" feature), restores here. The wallet computes a DIFFERENT seed and shows different addresses with zero balance. The user's funds are not on these addresses; they may panic and try to re-restore, exposing the mnemonic more times.

**Fix:** either add an optional passphrase field on restore (with explicit warning that mismatch = different wallet), or document in OnboardingRestore.tsx that this wallet doesn't support BIP-39 passphrases — restore here only if you generated here OR you didn't use a passphrase.

### L3. Splash flash-of-wrong-content during init

`src/App.tsx:81-98` route guard runs as a `[status]` effect. Initial Zustand state is `status:"no-wallet"` (`wallet-store.ts:82`). `init()` is fired in a separate `useEffect`. There's a measurable window — typically <50ms but unbounded by IndexedDB latency — where a returning user with an existing keystore sees the Splash page with "Create a new wallet" / "Restore from recovery phrase" buttons before being redirected to /unlock. The buttons are clickable; if the user clicks "Create a new wallet" in that window, they land on `/onboarding/create`, and on submit `createWallet` throws `E_WALLET_EXISTS` (line 141) — UX hiccup, not a footgun. But the perceived correctness of the splash flash is poor on a slow disk.

**Fix:** initialize `status: "initializing"` in the store, treat as a third state in App.tsx that renders a loading splinter, transition out only after `init()` completes.

### L4. SendPRL `validate()` called inside render path

`src/ui/pages/SendPRL.tsx:83`. When `stage === "preview"`, the render body calls `const v = validate();` at line 83. `validate()` calls `setError` (line 36, 41, 45, 47). React forbids state updates during render — this is "Cannot update a component while rendering a different component" territory. In practice React batches the next update so it appears to work, but it logs warnings in strict mode and is a future-React-version time bomb. Not a security issue, but it's the kind of code that breaks under react@19 concurrent rendering.

**Fix:** validate in a `useMemo` that doesn't call `setError`, or compute the validated values in a separate pure helper.

---

## I — Informational

### I1. CSP looks correct for the stated threat model.

`public/_headers:2` — no `unsafe-inline` on script-src, no `unsafe-eval`, no wasm-eval, no `data:` in script-src. `worker-src 'self' blob:` is needed for Vite bundled workers; `blob:` only loads code that was generated from a same-origin Blob, not attacker-controlled. `connect-src` is the user-configurable RPC's choke point and works (the in-UI warning at `Settings.tsx:283-288` already explains this). Settings.tsx warns about override RPC blocking — that's correct behavior; the user cannot exfiltrate the wallet to a hostile RPC by typing one in unless they go run-from-source.

One nit: `style-src 'self' 'unsafe-inline'` permits inline style tags. Tailwind's runtime is JIT/build-time so this isn't strictly required; tightening to `'self'` would slightly raise the bar against a stored-XSS-in-react-component vector, but the rest of the CSP makes that essentially unreachable. Not worth the engineering today.

### I2. Lock timeout vs activity coupling is correct.

`src/App.tsx:46-78`. Activity listeners are throttled to 1s; auto-lock poll uses `useWallet.getState().lastActivity` each tick rather than re-binding the effect. Clean.

### I3. HD paths and address derivation look right.

`src/crypto/hd.ts:13-14` — BIP-86 P2TR with coin_type 808276 for Pearl, BIP-44 for Eth. `RECEIVE_GAP_LIMIT = 20` matches BIP-44 convention. Worker derives all 20 addresses on unlock/create/restore (`worker.ts:101-111`). Indices 0..19 only — a wallet that received funds on index 20+ via the oyster reference wallet's continued advancement WILL miss balance. That's a known limitation, not a bug — but worth noting that "gap limit 20" is wallet-conventional, not a chain-enforced bound. Power user who externally derived index 25 would be silently empty here.

### I4. `wipe()` correctly password-gates and resets worker.

`src/state/wallet-store.ts:241-256`. The `if (blob)` test means a wallet in `status="no-wallet"` skips the password gate — that's expected (nothing to wipe). The `cryptoWorker.reset()` before `wipeKeystore()` guarantees in-memory keys are dropped even if the IDB delete is slow. Good.

### I5. Test coverage gap.

`tests/` contains `format.test.ts` and `tip.test.ts`. Zero tests for `verifyRelayerMintSig`, `getMintSignature`, `fetchPrlBalanceGrains` (UTXO walker — critical surface), keystore encrypt/decrypt round-trip, hd derivation against published BIP-86 test vectors, or any of the cross-tab broadcast paths. The wallet has tested the two safest surfaces and untested the eight scariest. Pre-launch this is the single biggest investment-to-risk-reduction lever.

---

## Summary

Three real findings worth blocking on:
- **H1**: keep the binding required, not opt-in. One line in `bridge.ts`.
- **H2/H3**: serialize cross-tab state mutations behind a single lock; current BroadcastChannel layer creates two reachable "wallet looks fine, mnemonic lost on refresh" sequences.

Three worth fixing before v0.2 broadcast lands:
- **M1** clock skew on deadlines
- **M2** preview UI implies broadcast capability the wallet doesn't have — UX-as-security-bug
- **M3/M4** sentry-trust gaps (DoS-only today, but the wallet's display is the user's only source of truth for "how much do I have")

Low-priority cleanups: AAD context binding (L1), BIP-39 passphrase doc (L2), init splash flash (L3), validate-in-render (L4).

Closing thought: the AUDIT-v0.1.5-opus2.md finding remediation took the shape of the fix but not the substance — `expected?` is the same gap with a TypeScript shrug attached. That's the pattern to watch for in the next pass: did the reviewer mark "done" because the symbol exists, or because the caller is forced to use it?
