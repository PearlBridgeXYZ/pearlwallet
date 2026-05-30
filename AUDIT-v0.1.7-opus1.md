# Pearl Web Wallet v0.1.7 — Independent Audit (opus1)

Audited against `package.json` version `0.1.7` on 2026-05-20. Independent read — prior `AUDIT-v0.1.6-*.md` consulted only for output format. v0.1.7 closed-finding list from the brief used to suppress duplicate-flagging of patched items.

Scope: src/services/{bridge,pearl-rpc,balances}.ts, src/state/wallet-store.ts, src/crypto/{keystore,worker,worker-client,hd,mnemonic}.ts, src/lib/{validate,format}.ts, src/chains/pearl/{address,network,tip}.ts, src/chains/ethereum/{network,rpc}.ts, src/ui/pages/{Splash,OnboardingCreate,OnboardingRestore,SendPRL,SendWPRL,Bridge,Receive,Settings}.tsx, src/App.tsx, src/storage/db.ts, src/state/ui-store.ts, public/_headers, index.html.

Bridge/Send broadcast paths remain stubs; findings cover code shipped, plus the verifier/normalizer surface that gets a real workout the moment broadcast lands.

---

## HIGH

None.

The v0.1.7 batch closes the H1/H2/H3 issues from v0.1.6 cleanly. `normalizeRelayerMintSig` correctly fails closed on every malformed shape I could construct (empty string, `null`, missing field, NaN, Infinity, non-finite, negative bigint, fractional Number, non-string/number/bigint type). `verifyRelayerMintSig`'s `expected` parameter is now type-required; the diagnostic-only `verifyRelayerMintSigUnbound` is loudly named and is not reachable from the broadcast path. The two-pass UTXO walk in `pearl-rpc.ts` resolves the vin-before-vout ordering issue. CSP is now mirrored in `index.html` as a `<meta>` so non-Cloudflare deployments get connect-src protection. AAD context binding in `keystore.ts` is solid for the threat it covers.

---

## MEDIUM

### M-1. `normalizeRelayerMintSig` accepts JSON `number` for uint256 fields → silent precision loss above 2^53
**File:** `src/services/bridge.ts:97-112`

`coerceUint` accepts a `number` typed field and calls `BigInt(field)`. JSON.parse decodes uint256 fields *before* `coerceUint` runs, so a JSON number larger than `Number.MAX_SAFE_INTEGER` (2^53 − 1 = 9007199254740991) is already truncated by the JSON parser. A relayer that serializes `amount`/`nonce`/`deadline` as JSON number — which JSON-RPC libraries do for any value that "fits in a double" — silently loses the trailing bits.

```ts
JSON.parse('{"amount":9007199254740993}').amount === 9007199254740992  // off by 1
JSON.parse('{"amount":1000000000000000001}').amount === 1000000000000000000
```

PRL grains are bounded (max supply × 10^8 grains is well below 2^53), so the PRL side is fine. **WPRL is not**: 1 WPRL = 10^18 wei. Any send >= 0.0091 WPRL is already past 2^53 wei and loses precision when JSON-encoded as a number. Combined with EIP-712 typed-data hashing happening over the truncated bigint, the relayer's signature is over the truncated value. `expected.amount` from `parseWPRL("1")` is a *non-truncated* 10^18n. So `sig.payload.amount !== expected.amount` → throws `E_SIGNATURE_AMOUNT_MISMATCH` — fails closed.

**But** if the relay is well-behaved and also computes its signing payload from a `Number`-typed amount on the way out the door (common Node.js bug), the *relay* signs the truncated value, the wallet's `expected` is also computed from the user's typed-string-parsed bigint, and the comparison fails closed. Same outcome. Bug is non-exploitable today.

Where it *bites*: a future relay that legitimately encodes uint256 as JSON number for a >= 2^53 value will be silently rejected as an amount mismatch, even when the user's intent matches. The error surfaces as `E_SIGNATURE_AMOUNT_MISMATCH`, which reads like a malicious relay when it's really a wire-format precision bug.

**Exploit path:** Not a fund-loss vector. Future user-confusion / bridge-wedging vector. The relay JSON contract should specify "uint256 fields MUST be encoded as decimal strings" — defensive coercion alone can't recover bits the parser already dropped.

**Fix:** Reject `number` outright for uint256 fields and require strings:
```ts
if (typeof field === "number") {
  throw new Error("E_SIGNATURE_NUMERIC_UINT256");
}
if (typeof field !== "string" && typeof field !== "bigint") {
  throw new Error("E_SIGNATURE_MALFORMED");
}
```
Add a corresponding clause to `docs/05-BRIDGE_INTEGRATION.md` so the relay team is on the same page.

### M-2. `coerceUint` silently accepts hex-encoded strings via `BigInt("0x...")`
**File:** `src/services/bridge.ts:104`

`BigInt("0x10")` returns `16n`, no error. `coerceUint` passes through any hex-prefixed string. The relay JSON contract (per `docs/05-BRIDGE_INTEGRATION.md`'s implied "decimal" convention) doesn't permit hex, but the parser quietly accepts it. Two failure modes:

1. **Inconsistency:** decimal vs hex encoding for the *same* numeric value produces the same `bigint`, so signature recovery still works. Not exploitable, but the wallet now silently sanctions an encoding the spec doesn't, and the spec drift can grow.
2. **`BigInt(" 0x10 ")` whitespace tolerance:** BigInt allows leading/trailing whitespace per spec. The empty-string check is `field.trim() === ""` — it doesn't reject `"   "` if trim returns empty (covered) but it ALSO accepts arbitrary whitespace before a hex prefix. Combined with the no-`number` fix above, the surface area is wider than the spec.

**Fix:** Constrain to a decimal-string regex before `BigInt()`:
```ts
if (typeof field === "string") {
  if (!/^\d+$/.test(field)) throw new Error("E_SIGNATURE_MALFORMED");
}
```
Tighten the docstring on the relay contract: "Decimal digits 0-9 only; no hex, no whitespace, no exponent."

### M-3. `fetchPrlBalanceGrains` throws `E_UTXO_WALK_EXCEEDED` despite comment promising partial total — hostile sentry zero-out attack
**File:** `src/services/pearl-rpc.ts:128-132, 100-101`

Code comment:
```
// Best-effort cap — return the partial total rather than hang the
// tab. Caller can surface this as a degraded-balance label later.
throw new Error("E_UTXO_WALK_EXCEEDED");
```
The comment says "return the partial total"; the code throws. That throw propagates up through `fetchPoolBalances`, which catches it as a per-address failure and counts the address as 0n. With a 20-address pool, a hostile sentry can selectively force-paginate any single address's walk to 20 full pages (page.length === PAGE per page) and that address contributes 0 — but only `failures === 1` of pool.length=20, well under the half-threshold, so `prlSource` stays `"live"` (not `"partial"`). The user sees an under-reported balance with **no warning**.

If the attacker targets the wallet's heaviest-funded address (the one with the longest tx history is also the one most likely to legitimately exceed 2000 txs, masking the attack), the resulting UI under-report is plausible and silent.

**Exploit path:** Same shape as the v0.1.6 M-4 (partial pool labeling). v0.1.7 *added* partial labeling for the pool walk failure-count case but missed the per-address page-cap case. A sentry returning `E_UTXO_WALK_EXCEEDED` for one heavy address shows live, under-reported balance. Send-PRL (when broadcast lands) would then fail at coin-selection time with "insufficient funds" — phishable into "your funds are lost, here's how to recover."

**Fix:** Honor the code comment. Convert the page-cap to a returned partial total + a "degraded" signal to the caller, so the pool walker can surface `prlSource: "partial"` even on single-address truncation:
```ts
if (pageCount >= MAX_UTXO_WALK_PAGES) {
  // Stop walking, return what we have — caller treats walk as degraded.
  return { grains: sumOf(utxo), degraded: true };
}
```
Then `fetchPoolBalances` aggregates `degraded` flags too, and any degraded address propagates `prlSource: "partial"`. Belt-and-braces: lower `MAX_UTXO_WALK_PAGES` once the wallet ships a coin-selection path that genuinely needs 2000+ tx history (currently it doesn't).

### M-4. Worker session private keys not zeroed before being replaced on create/restore/unlock
**File:** `src/crypto/worker.ts:35-42, 211-260`

`wipeSession()` exists and correctly fills(0) all `privKey` material, but it is only called from the explicit `lock` path. The `createWallet`, `restoreWallet`, and `unlock` cases all run `session = { ... new keys ... }` without first wiping the prior session. If the user unlocks, then re-unlocks (with a different password? no — same wallet — but the second unlock still derives fresh `Uint8Array` instances for every key), the *prior* `Uint8Array` private-key buffers are released to the JS garbage collector without being zeroed. They linger in worker heap memory until the GC reclaims (or compacts) those pages.

Combined with a memory-disclosure primitive (Spectre, an attacker-controlled WebAssembly module sharing the page, a developer tools heap dump on a compromised device), the un-zeroed key material is recoverable longer than the wipe path advertises.

**Exploit path:** Limited. Requires a second co-resident attacker with memory-read primitives inside the same renderer process. WebWorkers run in their own renderer-process-shared isolate, so this is harder than main-thread leakage, but the worker's heap is still exposed to any same-origin script that can spawn a sibling worker on certain browsers. Defense-in-depth violation rather than a direct funds-loss path.

**Fix:** Call `wipeSession()` at the top of `createWallet`, `restoreWallet`, and `unlock` before assigning the new `session`. Tiny patch:
```ts
case "unlock": {
  wipeSession();
  // ... existing body
}
```
Same for `createWallet`, `restoreWallet`.

### M-5. `OnboardingCreate.tsx` 5-second "Look carefully" timer leaks across unmount / strength change
**File:** `src/ui/pages/OnboardingCreate.tsx:29-51`

```tsx
useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      const out = await cryptoWorker.call(...);
      if (!cancelled) {
        setMnemonic(out.mnemonic);
        setCanContinue(false);
        const t = setTimeout(() => setCanContinue(true), 5000);
        return () => clearTimeout(t);   // ← returned to the IIFE, not useEffect
      }
    } catch (e) { setError(String(e)); }
    return undefined;
  })();
  return () => { cancelled = true; };
}, [strength]);
```

The `return () => clearTimeout(t)` is returned from the **inner async IIFE**, not the outer `useEffect` cleanup. The setTimeout id is captured by the IIFE only and never cleared. Two consequences:

1. **`strength` toggle (12 ↔ 24 words)** re-fires the effect. The previous timer continues to run. After 5 seconds, it `setCanContinue(true)` against the *new* mnemonic — which is fine semantically but happens on a different word list than the user is verifying. Cosmetic.
2. **Unmount during the 5-second window** (user clicks Back, navigates away, or auto-locks) → React fires `setCanContinue` on an unmounted component → dev-mode warning. Not exploitable, but a regression vs v0.1.6 (the prior code didn't have this timer).

**Fix:** Lift the setTimeout into the outer effect so its cleanup runs at the right level:
```tsx
useEffect(() => {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  (async () => {
    try {
      const out = await cryptoWorker.call(...);
      if (cancelled) return;
      setMnemonic(out.mnemonic);
      setCanContinue(false);
      timer = setTimeout(() => setCanContinue(true), 5000);
    } catch (e) { setError(String(e)); }
  })();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}, [strength]);
```

---

## LOW

### L-1. `passwordAcceptable` ASCII-only character class detection rejects high-entropy non-Latin passwords
**File:** `src/lib/validate.ts:52-59`

```ts
const classes =
  Number(/[a-z]/.test(password)) +
  Number(/[A-Z]/.test(password)) +
  Number(/\d/.test(password)) +
  Number(/[^A-Za-z0-9]/.test(password));
```

The lowercase/uppercase classes only match ASCII a-z / A-Z. The "symbol" class (`/[^A-Za-z0-9]/`) is a *catch-all* — any non-ASCII alphabetic counts as symbol. So:
- `"passwörd1"` → lowercase + symbol + digit → 3 classes → passes.
- `"你好世界1234"` → digit + symbol → 2 classes → passes.
- `"你好世界世界"` (high-entropy CJK passphrase, six unique-ish chars) → **only symbol class** → 1 → **rejected**.
- `"correcthorsebatterystaple"` → lowercase only → 1 → rejected (this one is the standard XKCD passphrase, with ~44 bits of entropy — significantly stronger than `Pa$$w0rd123`).

The gate is anti-entropy in two directions: legitimately-strong passphrases are rejected, and "lol1!" patterns are accepted. The fix (zxcvbn-ts) was acknowledged-and-deferred in v0.1.6 L-5; v0.1.7's `passwordAcceptable` doesn't move the ball, just shares it across create/restore/change paths.

**Fix:** Either ship a real entropy estimator (zxcvbn-ts, ~150 KB gzipped — bite the bundle bullet for a security-critical wallet), or relax the class gate to "length >= 12 OR (length >= 10 AND classes >= 2)" so a 12-char passphrase isn't rejected for being all lowercase. Document the tradeoff in `docs/06-CRYPTO.md`.

### L-2. `Settings` visibility-change handler races mnemonic export timer; reveal+background+resume within 1s shows mnemonic
**File:** `src/ui/pages/Settings.tsx:62-88, 106-113`

`doExport` sets `mnemonicValue` and starts the 1Hz countdown interval. The `visibilitychange` handler hides on `document.hidden`. Race window:

1. User clicks Show → `doExport` resolves → React schedules `setMnemonicValue(mnemonic)` and `setShowMnemonic(true)`.
2. **Before** React renders, user alt-tabs (e.g. via a malicious clipboard prompt that auto-switches tabs).
3. `visibilitychange` fires with `document.hidden === true` → `hideMnemonic()` runs → `setShowMnemonic(false)`, `setMnemonicValue(null)`. But this is a state update on a component that just queued *other* state updates.
4. React batches: the final render sees `showMnemonic=false, mnemonicValue=null` → the panel doesn't render. ✓ correct.

But: if the user is **already** backgrounded when `doExport` resolves (clicks Show then immediately switches), the `visibilitychange` handler doesn't fire again on the resolve. The mnemonic is rendered into the DOM on next visibility-change → ✓ React batching still hides it before paint? No — the visibilitychange handler only fires on *transition*. If the tab is already hidden when the async resolution lands, no transition happens until the user comes back. **By then the DOM has the mnemonic painted but the tab isn't visible, so no screen-capture from this tab is possible until the user returns** — and on return, visibilitychange fires `→ visible` (not `hidden`), so the handler `if (document.hidden) hideMnemonic()` no-ops.

**Actual exploit path is narrow:** if `doExport` is slow (decrypt + bcrypt-ish PBKDF2 = ~500ms), the mnemonic appears mid-await. Hiding then is fine. But after reveal, alt-tab + alt-back: the visibility-change handler ONLY hides on `hidden`, not on `visible`. So between alt-tab (hides) and alt-back (does nothing), the mnemonic is gone — ✓.

**The actual hole**: `setMnemonicSecondsLeft` countdown is throttled in background tabs. So if the tab is hidden DURING the reveal (between doExport.resolve and visibilitychange handler running), the countdown stalls. The visibilitychange handler does fire on the transition to hidden and clears mnemonic — ✓. **Effective coverage is correct.** Closing this as info-level rather than low.

Downgrading to **INFO**: the existing visibility handler covers the practical threat. Worth a comment in code noting "we hide on transition-to-hidden, not on transition-to-visible — paint-while-hidden is OK because screen capture requires the tab to be visible to the OS."

### L-3. Settings → "Pearl RPC endpoint" allows non-allowlisted hosts in the input but the browser blocks them at fetch — surfaces as a generic balance error
**File:** `src/ui/pages/Settings.tsx:142-164`, `public/_headers:2`, `index.html:13-16`

CSP `connect-src` is now hard-pinned in both `<meta>` and `_headers` to:
```
'self' https://rpc.pearlwallet.xyz https://ethereum-rpc.publicnode.com https://eth.drpc.org https://pearlbridge.xyz
```
A user who types `https://my-custom-sentry.com/` into the RPC override gets the URL accepted (it's `https:`, parses cleanly) and stored to localStorage. On next balance read, the browser refuses the fetch (CSP violation) and the wallet shows "error" — with no hint that *the wallet itself* blocked it. The amber warning text below the input is accurate but ambiguous: it conditions on "running from source with an adjusted CSP," but a normal user reading the input field doesn't know that.

**Exploit path:** Phishing — "Set your RPC to https://attacker.com/proxy to fix the Cloudflare outage." The user follows instructions, sees errors, blames their own wallet. The attacker doesn't get an HTTP hit (CSP blocks), but the user is now convinced the wallet is broken and is one suggestion away from doing something stupid (clone from a forked repo with CSP disabled, etc.).

**Fix:** Validate the saved URL host against the CSP `connect-src` list **at save time**. If the host isn't on the list, reject in the UI with "This host isn't on the wallet's allowlist." The list is short and known at build time.

### L-4. `parseDecimal` accepts leading zeros and produces unexpected canonical bigints
**File:** `src/lib/format.ts:29-43`

The regex `/^\d*(\.\d*)?$/` accepts `"0001"`, `"01.5"`, `".5"`, `""` (caught by separate guard). `BigInt("0001")` returns `1n`, so the math is fine, but:
- `parsePRL("00000000.00000001")` → 1n grain → smallest valid value. ✓
- `parsePRL(".5")` → trimmed `.5` IS rejected (`trimmed === "."` is checked but `".5"` passes the regex). Splits to `whole=""` and `frac="5"`. `BigInt("" || "0")` = 0n. `BigInt("50000000")` = 5e7. Result: 5e7 grains = 0.5 PRL. ✓
- `parsePRL("5.")` → splits to `whole="5"`, `frac=""`. `frac.padEnd(8, "0")` = `"00000000"`. `BigInt("00000000" || "0")` — `"00000000" || "0"` evaluates to `"00000000"` (truthy non-empty), so BigInt("00000000") = 0n. Final: 5e8 + 0 = 5e8 grains = 5 PRL. ✓
- `parsePRL("0")` → 0n grains. SendPRL.checkSend rejects `grains <= 0n`. ✓
- `parsePRL("1.")` → 1e8 grains = 1 PRL. ✓

All edge cases produce correct bigints. **Closing as no-finding** — leaving in the report so future audits see the cases checked.

### L-5. `loadKeystore`-after-Dexie-rejection in `unlock` has no timeout / retry
**File:** `src/state/wallet-store.ts:292`

If Dexie throws (storage quota exceeded, IDB corrupted, browser private-mode), `loadKeystore` rejects and propagates out of `unlock`. The user gets a raw `DexieError` string instead of "E_PASSWORD_WRONG" / "E_WALLET_WIPED". Worker session has already been mutated (unlocked) by this point, but the in-memory `addresses` haven't been set yet because the rejection happens before `set({ status: "unlocked", ... })`. So the wallet UI stays "locked" while the worker thinks it's unlocked, and a subsequent `cryptoWorker.call("deriveAddresses")` would succeed without a password.

**Exploit path:** Quota-exhaustion can be triggered by a colocated attacker writing many large keys to IndexedDB before the wallet loads. With the wallet trapped in this "worker unlocked but UI locked" state, an attacker with timing-based UI control (extension, XSS — not in threat model) could call `deriveAddresses` via the worker channel without re-prompting for a password. Bounded by the strict no-extension threat model.

**Fix:** Wrap `loadKeystore()` in a try/catch in `unlock` and `changePassword`. On reject, `cryptoWorker.reset()` (zero the worker session) and surface a clean `E_KEYSTORE_READ_FAILED` to the UI.

---

## INFO

- **AAD lacks app-identity binding.** `computeAAD(version, kdf, iter, cipher)` binds the AAD to the *crypto parameters* but not to a wallet-app name. Another web app deploying the same `JSON.stringify({v:1, kdf:"PBKDF2-SHA256", iter:600000, c:"AES-256-GCM"})` AAD with the same KDF would produce ciphertexts decryptable with the same password, IF the salts also matched (which they won't, salt is random). Defense-in-depth only — adding `"app":"pearl-wallet"` to the AAD costs nothing and forecloses cross-app ciphertext misuse.

- **`prlToGrains` parses sentry-supplied float**: `vout.value` arrives as a JSON number. `toFixed(8)` on a number > 2^53 loses precision. PRL max supply is well under 2^53 / 10^8 (~90B PRL), so practically unreachable. Future-proof: ask sentry to emit `valueSat`/`valueGrains` as a string. Tracked in `docs/SENTRY-RPC-REQUIREMENTS.md` would be the right home.

- **`fetchEthBlockTimestamp` doesn't validate plausibility.** Returns whatever `client.getBlock` says. A compromised viem fallback transport (CSP-allowed `eth.drpc.org` is a third party) could lie about the timestamp, e.g. return a near-future value so a stale signature looks fresh. The relay role check on chain via the same client would also be MITM'd in that scenario, so the net effect collapses to "trust the Eth RPC." Worth a comment that this assumption holds the entire bridge-verification chain together.

- **`postSdiIntent` casts response without shape validation.** `(await res.json()) as { id: string }` — if relay returns `{}`, `id` is undefined and downstream string usage fails late. Not security per se; consistency with `normalizeRelayerMintSig`'s shape-guarded boundary would be nice.

- **`RECEIVE_GAP_LIMIT = 20`** is hardcoded. A user who advances past 20 receive indexes on the oyster reference wallet (every `getnewaddress` advances) will silently lose visibility on funds sent to index 20+. Not new in v0.1.7; carried since v0.1.5. Worth surfacing in Settings as "Receive addresses tracked: 20 (advancing past this will hide funds until you restore)."

- **`OnboardingRestore.tsx`** renders 12/24 password-typed inputs for mnemonic words. Browsers (Chromium especially) may prompt to save *each* as a password. Spec-compliant behavior, no API to suppress beyond `autoComplete="off"` which is widely ignored. Worth a UI note ("Decline browser password-save prompts on this screen") rather than expecting users to know.

- **`coerceUint(0n)` accepts bigint zero**. The downstream checks `amount < 0n` rejects only negatives. Zero amount/nonce/deadline are syntactically valid uint256 values; `verifyRelayerMintSig` would catch `deadline === 0n` via the `deadline <= nowSec` check. `amount === 0n` would propagate; `expected.amount === 0n` is impossible to reach from `parsePRL("0")` since SendPRL.checkSend rejects `grains <= 0n` first. Consistent.

- **`init()` BroadcastChannel listener never closed in production.** `__resetWalletStoreForTests` closes it in test; production has no `dispose`. In SPA lifetime that's the right answer (the channel should live as long as the tab). Worth a doc note.

- **History.tsx, Dashboard.tsx, About.tsx** — out of audit scope per brief, not reviewed.

---

## Sections that look fine

- `src/services/bridge.ts` `normalizeRelayerMintSig` — solid boundary coercion. The `coerceUint` helper rejects every malformed input shape I could construct (modulo the encoding-format quibbles in M-1/M-2). Domain separation via the typed-data domain object is correct; `recoverTypedDataAddress` is the right viem primitive.

- `src/services/bridge.ts` `verifyRelayerMintSig` — `expected` required at the type level closes the v0.1.6 H-2 hole. `nowSecOverride` lets the caller substitute a trusted block timestamp; `getMintSignature` doesn't *use* it by default but the optionality is the right shape (default to local clock is acceptable when the deadline is checked again on-chain by the bridge contract).

- `src/services/pearl-rpc.ts` two-pass walk — vouts credited fully before any vin debit. Closes v0.1.6 M-3 cleanly. `MAX_UTXO_WALK_PAGES = 20` is a reasonable cap; only complaint is the comment/code mismatch in M-3 above.

- `src/state/wallet-store.ts` `makeAsyncLock` — correctly serializes via promise-chain. The `try { await prev } catch {}` is the right idiom for "ignore prior failure, run anyway." `release` is captured before the try so the finally always fires; no deadlock. Broadcast handlers go through the same lock, so a cross-tab `wiped` can't interleave with a local `unlock` — closes the v0.1.6 race-window class.

- `src/state/wallet-store.ts` `init()` idempotency — `storeInitialized` flag set *before* the await, plus `!keystoreChannel` guard, plus the test-only reset hook. Triple-guarded; the React.StrictMode double-mount no longer causes the v0.1.6 L-1 issue.

- `src/state/wallet-store.ts` `wipe(password)` — re-auth via `exportMnemonic` is the right shape. Resists drive-by wipe by a coercive bystander since they need the password. The L-4 v0.1.6 finding (no rate limit) carries forward unchanged; not flagged as new.

- `src/crypto/keystore.ts` `computeAAD` — version/kdf/iter/cipher binding is exactly the right context. Future-blob-format swap (v2 with different KDF) cleanly fails the GCM auth check.

- `src/crypto/keystore.ts` `decryptBlob` — fails-closed on unsupported version, generic error on auth failure. Good.

- `src/crypto/worker.ts` `hexToBytes` — validates length and charset, no silent NaN coercion. Closes the v0.1.6 "manually-edited keystore JSON" footgun.

- `src/lib/format.ts` `parseDecimal` — rejected `.`, `""`, negatives. All edge cases verified produce correct bigints (see L-4 above).

- `src/chains/pearl/tip.ts` `computeTipGrains` — floor-skip for sub-1-PRL sends prevents the "1 PRL tip on a 0.01 PRL send" footgun. Arithmetic still checks out at boundary (1 PRL exact: bps tip = 1000 grains = 0.00001 PRL, floor 1 PRL wins; 1000 PRL: bps tip = 1 PRL exact). Tip address visible in preview + Settings opt-out are the right UX.

- `src/ui/pages/Settings.tsx` `visibilitychange → hideMnemonic` — closes the v0.1.6 M-2 (backgrounded countdown freeze) cleanly. Reveal+background hides on transition; cosmetic gap analyzed in L-2 above is non-exploitable.

- `src/ui/pages/SendPRL.tsx` / `SendWPRL.tsx` `checkSend` — pure validator, no `setState`-during-render. Closes the v0.1.6 M-5 anti-pattern.

- `src/ui/pages/Splash.tsx` `initializing` state — Loading placeholder instead of flashing create CTA. Clean fix.

- `src/App.tsx` visibility-revive guard — checks elapsed-since-lastActivity before bumping. Closes v0.1.6 M-1 cleanly.

- `index.html` `<meta http-equiv="Content-Security-Policy">` — mirrors `_headers` so non-Cloudflare deploys still get connect-src protection. Closes v0.1.6 H-3.

- `package.json` — `@scure/btc-signer` dropped from deps as advertised. Bundle/audit surface reduced.

---

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 5 |
| Low | 5 |
| Info | 8 |

**No Critical or High findings.** The v0.1.7 batch closes the v0.1.6 H1/H2/H3 issues cleanly and the surface that worried me most (relayer mint payload binding) is now type-enforced. 

Top medium: **M-1** (JSON-number precision loss for WPRL uint256 fields — wedges bridge usability for any send >= 0.0091 WPRL if a relay encodes amount as a JS number rather than a string). Easy fix, big future-pain reduction.

Honorable mention: **M-3** (comment/code mismatch in `pearl-rpc.ts` — comment promises a partial total, code throws; combined with the pool walker's failure-counting, a hostile sentry can zero out a single high-balance address with no `partial` warning) and **M-4** (worker private-key buffers not zeroed on session replacement — defense-in-depth violation against same-renderer memory disclosure).
