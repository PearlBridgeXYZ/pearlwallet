# PearlWallet v0.1.5 — Independent Second-Pass Audit

**Date:** 2026-05-20
**Auditor:** Claude (second independent pass)
**Scope:** crypto, state, bridge, RPC, UI fund-loss footguns, v0.1.5 additions, deps.
**Method:** code read top-down, first audit file deliberately not opened until the end.

---

## Executive Summary

One Critical, one High, three Medium, five Low, several Info. The Critical is a stale on-chain contract mapping — every WPRL balance read and every bridge fee read targets contracts decommissioned 2026-05-19. The High is the relayer mint-signature verifier signing off on any RELAYER-role-bearing payload without binding it to what the user actually submitted. The Mediums are a wallet-overwrite footgun reachable from a normal locked state, a `cryptoWorker.reset()` that strands every in-flight promise, and a CSP `connect-src` mismatch with the user-overridable RPC setting. Lows are smaller UX/safety issues. Overall: do not ship to retail without fixing the Critical; the High is forward-looking (no broadcast caller today) but the gap exists in exported code.

---

## CRITICAL

### C1. Contract addresses are RC3, not RC5
**File:** `src/chains/ethereum/network.ts:21-29`

```ts
WPRL_ADDRESS.mainnet           = "0xbE0DDDD4d064Ae941EA379b651fEF0317af5387e"   // RC3
BRIDGE_ROUTER_ADDRESS.mainnet  = "0x5b2C49f1B253dFbD404CeEe2843979a977ba4009"   // RC3
```

Per the RC5 redeploy on 2026-05-19 the canonical mainnet WPRL proxy is `0x07696DcaB55…` and BridgeController is `0xA6571B73…`. Every Dashboard load calls `readWprlBalance` against the dead WPRL proxy (`balances.ts:73` → `bridge.ts:133-139`), and every Bridge page mount calls `mintFeeBps()/burnFeeBps()` against the dead controller (`Bridge.tsx:29-35` → `bridge.ts:114-130`). After RC3 is paused / drained per the decommission plan, balances will read `0` and fee reads will silently fall back to `MINT_FEE_BPS_DEFAULT/BURN_FEE_BPS_DEFAULT` via the try/catch in `readBridgeFees`. A user who genuinely holds WPRL on RC5 sees "0 WPRL" in their wallet and believes their funds are gone.

**Fix:** swap both addresses to RC5; verify the EIP-712 `domain.version` in `bridge.ts:67` against the live `BridgeController.eip712Domain()` (currently hardcoded `"2"` — could be `"5"` under RC5). Add a `eth_getCode` sanity check on Dashboard mount and surface a banner if it returns `0x`.

---

## HIGH

### H1. `verifyRelayerMintSig` doesn't bind payload to user intent
**File:** `src/services/bridge.ts:57-83, 170-177`

The verifier recovers the EIP-712 signer and checks `hasRole(RELAYER_ROLE, signer)` — that's it. `payload.recipient`, `payload.amount`, `payload.sdiHash`, and `payload.deadline` are never compared against the user's own deposit intent. The function's own docstring asserts the wallet "MUST" do this comparison before broadcasting; nobody does.

Today this is forward-looking — `Bridge.tsx:56-60` short-circuits broadcast — but `getMintSignature()` is the trust gate for v0.2, and the gap is easy to miss when the broadcast path lands. A relayer with leaked keys, or a relay HTTP backend MITM'd between SDI submit and signature fetch, can swap `recipient` to their own address and the wallet would broadcast a mint to the attacker.

**Fix:** change the signature to take expected payload fields and assert equality before role check; reject if `deadline < now`. Add a unit test that feeds a role-valid but recipient-swapped payload and asserts `E_PAYLOAD_RECIPIENT_MISMATCH`. Zero tests currently exercise `verifyRelayerMintSig`, `getMintSignature`, or `postSdiIntent`.

---

## MEDIUM

### M1. Locked-wallet Onboarding overwrites the keystore
**Files:** `src/App.tsx:55-68`, `src/ui/pages/Splash.tsx:18-22`, `src/ui/pages/Unlock.tsx:50-52`, `src/state/wallet-store.ts:117-146`

`App.tsx` redirects all non-`/unlock` paths to `/unlock` when status is `locked`, but explicitly *excludes* `/onboarding/*`. From the Unlock page there's a prominent link to `/onboarding/restore` ("Wrong password? Restore from recovery phrase"). A locked user who fat-fingers a 12-word phrase that happens to be valid BIP-39 (anybody's recovery phrase is, by definition, a valid grid of bip39 words) calls `restoreWallet()` → `saveKeystore(rec)` → `db.keystore.put(rec)` and the previous encrypted blob is overwritten. No prompt. No backup. If the user didn't write the original mnemonic down — and the fact they forgot the password suggests they may not have — the old wallet is permanently gone.

Same path exists from Splash via "Create a new wallet" / "Restore from recovery phrase" when status happens to be `locked` and the user reaches `/` before redirect (or types the URL manually).

**Fix:** in `OnboardingCreate.submit()` and `OnboardingRestore.submit()`, refuse to proceed if `loadKeystore()` returns a record, unless the user has just typed an explicit "replace my wallet" confirmation. Cleanest: route those flows back to `/unlock` whenever `status !== "no-wallet"`, and require the explicit `Settings → Wipe` typed-confirmation before allowing creation/restore.

### M2. `cryptoWorker.reset()` strands every in-flight promise
**File:** `src/crypto/worker-client.ts:43-49`

```ts
reset(): void {
  if (this.worker) { this.worker.terminate(); this.worker = null; }
  this.inflight.clear();
}
```

The map is cleared without resolving or rejecting the pending promises. Any `await cryptoWorker.call(...)` in flight when `lock()` or `wipe()` fires hangs forever. In `OnboardingCreate.submit()` (`OnboardingCreate.tsx:83`) this means the spinner spins to tab-close while `busy` stays true. Worse: it can mask a real failure during create — the user thinks the worker is still working when in fact the worker is gone.

**Fix:** iterate `this.inflight.values()` and reject each with `new Error("E_WORKER_RESET")` before clearing.

### M3. Custom RPC override is blocked by CSP — silent UX failure
**Files:** `src/state/ui-store.ts:58-61`, `src/ui/pages/Settings.tsx:124-146`, `public/_headers:2`

Settings lets the user paste any `https://` URL as a Pearl RPC override. The CSP `connect-src` only whitelists `'self' rpc.pearlwallet.xyz ethereum-rpc.publicnode.com eth.drpc.org pearlbridge.xyz`. Any other RPC the user enters will be CSP-rejected at fetch time. The user gets no feedback in Settings ("Using custom: https://my-node.example/" is printed cheerfully) and balance lookups then silently break (caught by the per-page try/catch and surfaced as "error" later).

The CSP behavior is actually the security-correct outcome (an attacker can't trick a user into routing balance queries through their server). The bug is that the wallet *advertises* a feature that the CSP forbids.

**Fix:** either drop the custom-RPC feature from Settings, or remove `connect-src` from the static `_headers` and emit it per-request from a service worker that knows the override. The first is simpler and matches the threat model the rest of the app assumes.

---

## LOW

### L1. Locked-state "Wipe this wallet" link goes nowhere
**File:** `src/ui/pages/Unlock.tsx:53-55`

`/settings` is redirected to `/unlock` in the locked state. A user who's forgotten the password and clicks "Wipe this wallet" lands back on the same page with no visible change.

**Fix:** render a minimal wipe section directly on Unlock (typed "wipe my wallet" + button), or whitelist `/settings` when locked and have Settings hide every section except Wipe.

### L2. `lastActivity` never advanced — auto-lock is a fixed 5-min timer, not idle
**Files:** `src/state/wallet-store.ts:55, 212-214`, `src/App.tsx:43-52`, all UI pages

`touch()` is declared on the store but never called by any UI surface. `lastActivity` is updated only on `unlock/createWallet/restoreWallet`. So the auto-lock is a hard 5-minute timer from unlock, not idle-based. The TopBar countdown literally says "Lock in 5:00" and counts down regardless of whether the user is interacting. The user may believe interaction extends the timer (most wallets work that way) and walk away surprised when their active session locks.

This is more secure than true idle-based locking (a phone left unlocked still locks within 5 min) but the UX label is misleading.

**Fix:** either wire `touch()` to `mousemove/keydown/touchstart` listeners on `<body>` to match the displayed intent, or relabel "Lock in 5:00" to "Auto-lock in 5:00" and document the hard-timer behavior.

### L3. Tip floor exceeds principal for sub-1-PRL sends
**File:** `src/chains/pearl/tip.ts:24-30`

`TIP_MIN_GRAINS = 1 PRL`. Sending 0.5 PRL with tipping on adds a 1 PRL tip — 200% of principal — and there's no preview-time warning. Settings copy says "10 bps with a 1 PRL floor for small transactions" which is technically true but the floor's percentage impact isn't called out at the per-send confirm step. Tip is opt-in, so this is consent-by-default; still, the user paying 3× their send because they overlooked the floor is a real fund-loss UX.

**Fix:** cap the tip at min(floor, send * 0.1) or warn in `SendPRL.tsx` preview when `tipGrains > sendGrains * 0.1`.

### L4. `parseDecimal` accepts negative numbers
**File:** `src/lib/format.ts:29-41`

The regex `^-?\d*(\.\d*)?$` lets through `"-1.5"` → `-150000000n`. `SendPRL` and `SendWPRL` catch this with `if (grains <= 0n)` checks. `Bridge.tsx:46-54` computes preview math on the returned bigint without a `< 0` guard, so a user typing a negative amount sees a "preview" with negative fee/recv. Not exploitable (Bridge.broadcast is stubbed) but should be tightened before v0.2.

**Fix:** in `parseDecimal`, throw when the leading `-` is present, or filter at the call sites. Negative crypto amounts are nonsense.

### L5. Clipboard copy doesn't surface which receive index it copied
**File:** `src/ui/pages/Receive.tsx:29-37, 104-122`

After switching pool index via `setPrlIndex(i)` and pressing "Copy address", the toast says only "Copied!" — not which index. A user toggling indexes to try them out can lose track. Funds sent to a derived index in the pool ARE recoverable via the seed (same wallet sees them), but appear "missing" to the sender until they look at the aggregated pool balance. Combine with a clipboard manager and the user sends to the wrong derivation, then panics.

**Fix:** include the index in the toast ("Copied #3 of 19"); optionally re-write the clipboard with the canonical address on copy-toast clear.

---

## INFO

### I1. v0.1.5 mnemonic auto-wipe — partial state-leak on timeout
**File:** `src/ui/pages/Settings.tsx:60-86`

When the 60s timer fires, the body sets `mnemonicValue=null` and clears `pwExport` but leaves `showMnemonic === true`. The result is an open card showing "Hidden. Re-enter your password above to reveal again." That's fine UX-wise, but `clearMnemonicTimer()` is also called inside the same branch — fine — and the `useEffect` cleanup at line 92-96 only calls `clearMnemonicTimer()`, not `setMnemonicValue(null)`. When the component unmounts mid-reveal React's GC drops the state anyway, so the in-DOM mnemonic does clear. No leak. Considered and dismissed.

### I2. v0.1.5 TopBar countdown — clean
1Hz `setInterval` gated on `status === "unlocked"`, cleanup correct, single source of truth via `AUTO_LOCK_MS` export. Considered and dismissed (apart from L2 above, which is about `touch()` not being wired — orthogonal to the countdown itself).

### I3. BIP-86 tweak math
`address.ts:46-59` constructs the internal point with hardcoded `0x02` (even-y) parity prefix and adds `tweak * G`. This matches BIP-86 / BIP-340 lift_x semantics (even-y is canonical). `bytesToBigInt(tweak)` is unsigned big-endian; `tweak >= n` is statistically negligible and `G.multiply` reduces mod n internally in @noble/curves. Considered and dismissed.

### I4. AES-GCM keystore
`keystore.ts` derives a fresh 128-bit salt and 96-bit IV from `crypto.getRandomValues` per encryption; 600k PBKDF2-SHA256 iterations; AAD = constant `"pearl-web-wallet-v1"`. Auth-tag failures map to `E_PASSWORD_WRONG`. The catch wraps only `subtle.decrypt`, not `deriveKey` — if `deriveKey` throws (eg. WebCrypto missing) the raw error propagates, but that's noise, not a key-material leak. Considered and dismissed.

### I5. Worker key wipe
`worker.ts:37-42` zeroes each `privKey.fill(0)` and nulls the session before the worker terminates on `reset()`. The terminate is the real cleanup; the explicit zero is belt-and-braces against V8 reference retention. Correct. Considered and dismissed.

### I6. Pearl RPC pagination — same concern as the first pass would likely flag
`pearl-rpc.ts:95-131` walks `searchrawtransactions` and folds vouts/vins into a UTXO map. Correctness assumes vin appears on a same-or-later page than its referenced funding vout. If the sentry ever returns results in any other order (newest-first; sharded reassembly), spent outputs would never be deleted and balance would over-report. btcd's documented behavior is oldest-first chain order which makes the algorithm correct against the canonical server; if the public sentry is replaced by a non-btcd shim the assumption breaks silently. A second pass (build UTXO set first, then mark-spent) would be order-agnostic. Considered — would mark Medium if shipped without a server-side guarantee, but the current sentry is canonical btcd-derived.

### I7. Dependency snapshot
viem 2.21.19, @noble/curves 1.6.0, @noble/hashes 1.5.0, @scure/base 1.1.9, @scure/bip32 1.5.0, @scure/bip39 1.4.0, @scure/btc-signer 1.4.0, dexie 4.4.2. As of January 2026 no public CVEs against these exact versions. Pinned-exact for crypto deps (good), caret-pinned for non-crypto (acceptable). `package-lock.json` integrity hashes present.

### I8. CSP `script-src 'self'`, no `unsafe-eval`, no inline
Confirmed in `public/_headers`. `worker-src 'self' blob:` — the `blob:` is required for Vite's worker bundling. No third-party origins in script-src. Good.

### I9. Cross-tab race
Two tabs of the wallet open simultaneously: tab A creates a wallet, tab B sees stale `status === "no-wallet"` until `init()` is re-run on focus (never — `refetchOnWindowFocus: false`). Tab B's Splash would happily restart onboarding and overwrite. Same root cause as M1; the tab-isolation makes the race exploitable without the user even visiting Splash explicitly.

### I10. `Number(bigint) / 1e8` precision
`Dashboard.tsx:19, 34, 43`. For PRL > ~90M grains-as-PRL, JS Number precision loses sub-grain digits. Only used for USD display, never tx construction. Not a fund-loss vector. Considered and dismissed.

### I11. `setError(String(e))` patterns
Sampled across `OnboardingCreate/Restore`, `Settings`, `Unlock`: error messages come from `E_PASSWORD_WRONG`, `E_INVALID_MNEMONIC`, or HD-derivation errors like "HD derivation failed at pearl receive index N". No key material, no paths. Considered and dismissed.

### I12. The `wipe()` → `saveKeystore()` race
`wallet-store.ts:181-185`: `cryptoWorker.reset()` then `await wipeKeystore()`. If `wipe()` is invoked concurrently with `createWallet()` that has already returned from the worker but hasn't yet hit `saveKeystore(rec)`, the wipe's `db.keystore.delete("primary")` could run before, and then the `put` lands on the now-clean store — restoring the wallet despite the user pressing Wipe. The UI doesn't expose both buttons simultaneously (Splash hides "Create" UX under "Settings → Wipe" flow), but the race is reachable if a Lock fires mid-create. Low-impact; mention here so a future v0.2 with parallel flows knows to serialize via a store-level mutex.

---

## Compliance quick-check

| Item | Status |
| - | - |
| PBKDF2 ≥ 600k | PASS |
| AES-GCM fresh IV per encrypt | PASS |
| WebCrypto-required gate | PASS |
| HD coin_type 808276 | PASS |
| Mnemonic auto-wipe + countdown | PASS |
| Contract addresses canonical | **FAIL** (C1) |
| Relayer sig binds to intent | **FAIL** (H1) |
| Custom RPC respected by CSP | **FAIL** (M3) |
| In-flight worker promises drained | **FAIL** (M2) |
| Existing keystore protected from accidental overwrite | **FAIL** (M1) |
| Auto-lock matches advertised behavior | partial — see L2 |

---

## Overlap with first pass

Read `AUDIT-v0.1.5.md` after writing the above.

**Agree (both passes):**
- Critical: stale RC3 contract addresses — both passes identical conclusion and fix.
- High: relayer sig payload not bound to intent — same finding, same fix sketch (compare recipient/amount/sdiHash; add deadline check).
- M1 (onboarding overwrite) — first pass calls this Medium; same root cause and fix.
- M2 (worker reset drops promises) — first pass calls this Low #2; same finding, same fix. I rated higher because of the `OnboardingCreate.submit()` user-stuck path; first pass downplayed it as "UX glitch." Either rating defensible.
- Pearl RPC page-order assumption — first pass Medium #2; I'd put it in Info absent evidence the sentry diverges from btcd ordering. First pass is more conservative; reasonable disagreement.
- L1 (Unlock → /settings dead link) — match.
- L3 (tip floor for small sends) — match.
- L5 (clipboard copy index) — match.
- Worker key disposal / AES-GCM correctness / BIP-86 tweak / deps snapshot — both passes dismissed as clean.

**Conflict / disagreement:**
- I rate M3 (custom-RPC blocked by CSP) Medium; first pass marks the CSP as "aligned with code" (Info #4) and doesn't flag the override mismatch. Worth re-checking — Settings allows `https://*` but CSP rejects anything outside the whitelist. Either the override feature should be removed or the CSP needs dynamic handling.
- I flag L2 (`touch()` never called → auto-lock is fixed-timer not idle) as Low. First pass dismisses TopBar/auto-lock as "clean" (Info #1) without checking whether `touch()` is wired. This is a real UX-vs-advertised behavior gap, not a security hole, but worth fixing before retail.
- I flag L4 (parseDecimal allows negatives) as Low; first pass doesn't mention it. Currently caught at SendPRL/SendWPRL but slips through Bridge preview. Tighten before v0.2.
- I flag I12 (wipe vs saveKeystore race) as Info; first pass doesn't mention it.

**Unique to this pass:**
- M3 (CSP vs custom-RPC mismatch).
- L2 (`touch()` not wired, auto-lock is timer-from-unlock not idle).
- L4 (negative-amount parser leak into Bridge preview).
- I9 (cross-tab onboarding race shares M1's root cause).
- I12 (`wipe()` racing concurrent `saveKeystore()`).

**Unique to first pass:**
- Compliance checklist style summary table (more thorough than mine).
- Info #7 server-side concern about `prl-price` function quantity-weighting (out of my scope; I didn't open `functions/`).
- Info #8 explicit confirmation that mock-mode is gone (I didn't grep for it).
- Info #9 single-string `pearlAddrs` legacy path (I noticed but didn't write up).

**Net:** Critical and High match exactly. Mediums overlap on M1/M2; first pass missed M3. The Lows I added (L2, L4) are real and worth fixing. The first pass's Medium-rated RPC page-order finding I'd downgrade to Info absent a confirmed non-btcd sentry. Both passes recommend the same blocker before retail: fix the contract addresses, then close the payload-binding gap before v0.2 broadcast.
