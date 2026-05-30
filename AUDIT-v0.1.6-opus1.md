# Pearl Web Wallet v0.1.6 — Independent Audit (opus1)

Audited against `package.json` version `0.1.6` on 2026-05-20. Independent read — prior `AUDIT-v0.1.5-*.md` files not consulted.

Scope: src/crypto/*, src/services/{bridge,pearl-rpc,balances}.ts, src/state/wallet-store.ts, src/chains/{pearl,ethereum}/*, src/ui/pages/*, src/App.tsx, public/_headers, index.html.

Note: `src/chains/pearl/tx.ts` mentioned in the brief does not exist. PRL/WPRL send and Bridge are still UI stubs (`broadcast()` throws "not yet enabled"). Findings below cover code shipped, not future broadcast paths.

---

## HIGH

### H-1. Relayer mint payload JSON is never typed-coerced; bigint strict-eq vs JSON number guarantees `E_SIGNATURE_AMOUNT_MISMATCH`
**File:** `src/services/bridge.ts:71-115, 205-216`

`getMintSignature` parses the relay HTTP response as JSON and asserts the result type as `RelayerMintSig` directly (`as RelayerMintSig`). At runtime `payload.amount`, `payload.nonce`, and `payload.deadline` arrive as JSON number or string — never `bigint`. `verifyRelayerMintSig` then runs:

```
if (sig.payload.deadline <= nowSec) ...           // bigint <= bigint required
if (sig.payload.amount !== expected.amount) ...   // bigint !== string|number
```

`BigInt <= number` throws TypeError (`Cannot mix BigInt and other types`). `bigint !== string|number` is always `true` because `!==` does not coerce. The deadline branch crashes the verifier *before* the binding checks; the amount/nonce branches would fail-closed anyway. Net effect: every legitimate mint signature is rejected.

**Exploit path:** Not a fund-loss issue (fails closed), but the bridge integration is completely non-functional the moment it's wired into the broadcast UI. The defense-in-depth payload-binding rationale you added in v0.1.6 silently regresses on first contact.

**Fix:** Normalize after fetch:
```ts
const raw = (await res.json()) as { payload: Record<string, string|number>; signature: `0x${string}` };
const payload: MintPayload = {
  recipient: raw.payload.recipient as `0x${string}`,
  amount: BigInt(raw.payload.amount),
  sdiHash: raw.payload.sdiHash as `0x${string}`,
  nonce: BigInt(raw.payload.nonce),
  deadline: BigInt(raw.payload.deadline),
};
```
Then pass the normalized struct into `verifyRelayerMintSig`. Add a runtime shape guard so a `null`/missing `payload` throws cleanly, not via a destructure TypeError.

### H-2. `getMintSignature.expected` is optional; broadcast path can call it without binding
**File:** `src/services/bridge.ts:205-216`

`expected?: IntentExpectation` is typed optional, and `verifyRelayerMintSig` only runs the recipient/amount/sdiHash binding checks `if (expected)`. The docstring says "broadcast path must not call this without `expected` in production" — but TypeScript does not enforce a comment. Once the Bridge UI is wired up, any caller that forgets to pass `expected` (or passes it as `undefined` from a conditional) accepts whatever recipient the relay returns. Given that the relay is explicitly in the threat model as hostile, this is the exact loss-of-funds path the v0.1.6 work was supposed to close.

**Fix:** Make `expected` required at the function signature level (drop the `?`). Push the *only* "no expectation" path to an explicit `verifyRelayerMintSigUnbound()` that lives in tests-only or behind a `__noBinding: true` discriminant so it can't be reached by accident from the broadcast call site.

### H-3. CSP exists only in `public/_headers`, not in `<meta>` — non-Cloudflare deploys lose connect-src protection
**File:** `public/_headers:2`, `index.html`

CSP is delivered as a header by Cloudflare Pages. There is no `<meta http-equiv="Content-Security-Policy">` in `index.html`. The Settings page text claims:

> Note: the wallet's strict Content Security Policy only permits requests to the default RPC hosts.

That is only true when the wallet is served through Cloudflare. Anyone running the built `dist/` from a static server that does not replay `_headers` (any local dev mirror, `python -m http.server`, an S3 bucket, IPFS, a tor hidden service, etc.) has **no connect-src restriction at all**. Combined with the custom RPC override (Settings → Pearl RPC endpoint) which validates only `https:` protocol, the user can be talked into pointing at any host and the browser will dutifully connect — defeating the assurance the Settings copy advertises.

This matters less today (UTXO lies don't move funds), but the moment send-PRL goes live, a hostile custom RPC can poison coin selection, fee estimation, and confirmation status.

**Fix:** Add `<meta http-equiv="Content-Security-Policy" content="…">` to `index.html` with the same directives as `_headers`. Keep `_headers` for defense in depth (meta CSP can't set frame-ancestors / HSTS), but the connect-src list must travel with the HTML. Drop the misleading Settings copy or condition it on `document.querySelector('meta[http-equiv="Content-Security-Policy"]')` being present.

---

## MEDIUM

### M-1. Auto-lock can be silently postponed by switching to a background tab
**File:** `src/App.tsx:46-78`

The activity bumper listens to `visibilitychange` and calls `bump()` whenever `document.hidden` becomes false. The auto-lock poll is a `setInterval(... 1000)` that browsers throttle to ~1/min in background tabs.

Sequence that breaks the 5-minute lock:
1. User unlocks, leaves wallet tab open, switches to a different tab.
2. Background poll runs at most every ~60s. After 5 min idle, the next poll *would* fire `lock()`.
3. Attacker (or curious roommate) returns to the tab. `visibilitychange` fires synchronously **before** the next interval tick, calls `bump()`, sets `lastActivity = now`. The next poll sees `since = ~0`, no lock.

Result: a tab in the background past the auto-lock window can be revived by anyone who clicks back into it, even if the genuine user has been away the entire interval.

**Exploit path:** Hostile/coercive bystander with brief device access (explicitly in threat model) gets a logged-in wallet without typing the password. Wipe gate still requires the password, but they can read balances, copy receive addresses (privacy leak), and once Send is enabled, sign sends.

**Fix:** On `visibilitychange → visible`, evaluate `if (Date.now() - lastActivity > AUTO_LOCK_MS) { lock(); navigate('/unlock'); return; }` **before** calling `bump()`. Equivalently: maintain `lastActivity` in a `Date.now()` comparison driven by `visibilitychange` itself, not by polling. The `bump()` should be gated on "current state is unlocked AND not already past the lock window."

### M-2. Mnemonic export display does not auto-hide on tab hide; countdown freezes when backgrounded
**File:** `src/ui/pages/Settings.tsx:69-79, 93-97`

`doExport` reveals the mnemonic and starts a 60s `setInterval` that decrements `mnemonicSecondsLeft`. When the tab is backgrounded the interval is clamped to ~1/min by every modern browser, so a 60s auto-hide becomes a 1-2 tick auto-hide spread over potentially much longer. Worse, the mnemonic stays in the DOM the whole time. If the user reveals the mnemonic then switches to another tab, the phrase remains visible on the next tab switch back, regardless of how long they were away.

The on-unmount cleanup only fires on full route change, not on visibility.

**Exploit path:** Shoulder-surf / screen-capture against an inattentive user. Same threat model as v0.1.0 LOW #1, partially reverted.

**Fix:** Add a `visibilitychange` handler in the export flow that calls `hideMnemonic()` whenever `document.hidden` becomes true. Belt-and-braces: use `performance.now()` as the truth source for "should still be visible" and drive the auto-hide from a wall-clock check inside the existing 1-second interval, not from decrementing a counter (so when the browser throttles, the *first* tick after un-backgrounding catches up).

### M-3. UTXO walk credits double-counts if sentry returns vins before their funding vouts
**File:** `src/services/pearl-rpc.ts:100-144`

The walk:
```ts
for (const tx of page) {
  for (const vout of tx.vout) {
    if (!voutPaysAddress(...)) continue;
    if (seenOutputs.has(key)) continue;
    seenOutputs.add(key);
    utxo.set(key, prlToGrains(vout.value));
  }
  for (const vin of tx.vin) {
    if (!vin.txid || vin.vout === undefined) continue;
    utxo.delete(`${vin.txid}:${vin.vout}`);
  }
}
```

Two subtle issues:

1. **`utxo.delete` on a not-yet-credited output is a no-op.** If the sentry returns transactions out of chronological order (legitimate during reorgs, or under cursor drift across pages), a vin can be seen *before* its funding vout. The delete misses, then the later page credits the vout, and the spent output stays in the running total — wallet over-reports its own balance.
2. **`seenOutputs` guards double-credit but not double-debit.** The vin pass has no dedup — if the same spending tx appears on two pages, the second `utxo.delete` is idempotent (good), but the dedup logic is asymmetric: outputs use a set, inputs use raw deletes. That's defensible but worth documenting.

**Exploit path:** Malicious relayer/sentry can engineer page ordering to inflate the reported balance. User sees "you have 50 PRL," tries to spend 45 (when the actual UTXO set has 30), and the send fails / consumes wrong UTXOs at construction time. Not direct fund loss while send is gated, but the balance display is unreliable against a hostile sentry.

**Fix:** Two-pass per page. First pass over all transactions in `page`, collect *all* vouts that pay this address into `utxo` (deduped). Second pass over all vins, delete from `utxo`. Or fully buffer the whole walk into a `tx[]` first, sort by `confirmations DESC` (or `blockheight ASC`), then fold inputs/outputs in chronological order. The current per-tx fold assumes the sentry's ordering matches Bitcoin's input-cannot-precede-output invariant — that invariant only holds within a block, not across paginated query responses.

### M-4. `fetchPoolBalances` returns partial sum on >0 and ≤half failures, labeled `live`
**File:** `src/services/balances.ts:28-43`

If 9 of 20 pool addresses fail with sentry errors, the function returns the sum of the remaining 11 and the caller labels the result `prlSource: "live"`. The user sees an under-reported balance with no UI indicator that the walk was incomplete. Funds shipped to receive index 18 are invisible until the sentry recovers.

**Exploit path:** Hostile sentry selectively fails the addresses that hold the user's largest UTXOs, then offers a "helpful" suggestion (via the explorer / phishing) that the user "must have lost their funds, here's how to recover." Same surface enables a malicious actor to mask incoming deposits.

**Fix:** Either (a) change `prlSource` to `"partial"` (new variant) and surface that in the UI, or (b) require all-or-nothing for a `"live"` label. Half-failure swallowing is the worst of both — looks authoritative, isn't.

### M-5. `validate()` called from inside JSX render writes React state synchronously
**File:** `src/ui/pages/SendPRL.tsx:82-86`, `src/ui/pages/SendWPRL.tsx:68-69`

```tsx
if (stage === "preview") {
  const v = validate();   // calls setError() during render
  ...
}
```

`validate()` calls `setError(...)` synchronously. Calling a state setter during render is a React anti-pattern and in dev mode throws a console warning ("Cannot update component during render"). In some flows it triggers a re-render loop. Not security per se, but the Send screens can wedge for users on strict-mode builds.

**Fix:** Move validation into the click handler that transitions to "preview" (already partially done), and pass the validated `{ dest, grains }` through component state. Don't re-run `validate()` from inside the render branch — read from state.

---

## LOW

### L-1. `wallet-store.init()` is idempotency-naive; second invocation can force `status: "locked"` while worker session is alive
**File:** `src/state/wallet-store.ts:89-132`

Under React StrictMode dev, `useEffect(() => void init(), [init])` in `App.tsx` fires twice. The second `init()` runs `loadKeystore()`, finds the record, calls `set({ status: "locked", ... })` — overwriting `status: "unlocked"` if the first effect already raced ahead. Worker `cryptoWorker` is not reset, so derived keys still live in memory but the UI shows the unlock screen. Confusing UX in dev; harmless in production single-mount.

Also: each `init()` attaches a fresh `BroadcastChannel` listener that is never closed. Two listeners would each trigger their own `cryptoWorker.reset()` on a single foreign blob-updated event, doubling the rejected-in-flight messages.

**Fix:** Track `initialized` (module-scope `let` or store flag), no-op the second call. Hold a reference to the BroadcastChannel and close it on a future `dispose()`/cleanup hook, or move channel construction to module scope guarded by `if (typeof BroadcastChannel !== "undefined")`.

### L-2. `bech32m.decode` cast accepts non-`prl1` separator strings
**File:** `src/chains/pearl/address.ts:84`

```ts
const decoded = bech32m.decode(address as `${string}1${string}`, 90);
```

The TypeScript template-literal cast is non-validating — `bech32m.decode` itself enforces the `1` separator and HRP/case rules, so this is currently safe. But the cast hides a runtime assumption. If `@scure/base` ever changes its parser to require pre-validated input, this would silently break.

**Fix:** Replace the cast with a runtime check `if (!address.includes("1")) throw new Error("E_INVALID_ADDRESS")` then pass the bare string.

### L-3. `OnboardingCreate` calls `restoreWallet` instead of `createWallet`
**File:** `src/ui/pages/OnboardingCreate.tsx:83-85`

The create flow generates a mnemonic in step 1, then on submit calls `restoreWallet(mnemonic, password)` — explained by the inline comment, but `createWallet` in the store generates a *fresh* mnemonic so it would overwrite the user's verified phrase. Using `restoreWallet` is the right behavior here; the code smell is that `createWallet` in the store is now unused from the UI. Either delete the unused `createWallet` worker cmd + store method (dead-code surface = audit surface), or refactor so `createWallet` takes an optional `mnemonic` parameter so a single happy path exists.

### L-4. Wipe gate only verifies password by decrypting the blob; no rate limit
**File:** `src/state/wallet-store.ts:241-256`

`wipe(password)` calls `exportMnemonic` to verify the password. PBKDF2 at 600k iterations gates the attempt (good — ~500ms per try on commodity hardware). But there's no lockout / backoff after repeated failures. A coercive bystander who can issue Settings clicks can brute-force at ~2 attempts/second of CPU time, which against a weak 10-char password is years but against a poor user choice (`password12345`) is online-dictionary territory. Same applies to `unlock()`.

**Fix:** Add an in-memory failure counter (persist across reloads via a Dexie row) that adds exponential backoff after N=5 failures. Same gate covers `unlock`, `exportMnemonic`, `changePassword`, `wipe`.

### L-5. `passwordStrength` is heuristic and doesn't reject obviously bad inputs
**File:** `src/lib/validate.ts:23-32`

`"qwertyuiop"` → length≥8: +1, length≥12: 0, no upper+lower: 0, no digit+symbol: 0 → score 1 "weak", *but passes* the 10-char gate in OnboardingCreate. Even `"aaaaaaaaaa"` passes. The UI accepts it.

**Fix:** Reject known-weak patterns (consecutive same chars, common substrings) at the gate, or bite the bundle bullet and ship zxcvbn-ts.

---

## INFO

- **Mnemonic in main-thread DOM during onboarding** (`OnboardingCreate.tsx`): unavoidable for any browser wallet that displays the phrase to the user. JS strings can't be zeroed. Worth a visibility-change auto-hide consistent with Settings (M-2 fix would generalize).
- **No subresource integrity** on the served bundle (CF Pages hash-named assets get cache-busted but no SRI). Defense-in-depth against a compromised CF asset.
- **`pearl-rpc.ts` retries 5xx with no jitter** — 250ms × attempt linear backoff. Three concurrent users hitting a sentry overload synchronize. Minor.
- **`tip.ts` `TIP_BPS = 10n`** — verified: 1% of sends >= 100 PRL → 0.1 PRL → below floor → uses 1 PRL min. 1000 PRL → 1 PRL. 10000 PRL → 10 PRL. Arithmetic checks out. Setting clearly disclosed and disablable.
- **`@scure/btc-signer 1.4.0`** listed in deps but not imported anywhere in `src/`. Dead dependency adds bundle/audit surface. Drop until tx-signing lands.
- **`MINT_FEE_BPS_DEFAULT = 50` (0.5%)** but Bridge UI displays `activeFeeBps / 100` as percent → "0.5%". Correct, but the literal magic numbers in `network.ts` should reference the runtime contract read at startup.
- **`History.tsx`, `Dashboard.tsx`, `About.tsx`** not in audit brief — skipped.

---

## Sections that look fine

- `src/crypto/keystore.ts` — AES-256-GCM + PBKDF2-SHA256 600k iterations + 16-byte salt + 12-byte IV + fixed AAD. Generic decrypt error. Solid.
- `src/crypto/hd.ts` — BIP-86 path correct, coin-type 808276 documented and cross-checked, gap-limit reasonable.
- `src/crypto/mnemonic.ts` — thin wrapper over `@scure/bip39`. Trim+lowercase normalization consistent.
- `src/chains/pearl/address.ts` `bip86Tweak` — implementation matches BIP-86 spec; tagged-hash construction correct, x-only parity recovery via `0x02` prefix is standard.
- `src/crypto/worker-client.ts` `reset()` — correctly rejects in-flight after terminate. Good.
- `src/crypto/worker.ts` `hexToBytes` — validates length and charset. Good.
- `parseDecimal` — rejects empty/dot-only/negatives via regex. Good.
- Clipboard auto-clear on Receive — best-effort, correctly checks current clipboard matches before clearing. Acceptable.

---

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 5 |
| Low | 5 |
| Info | 6 |

No direct key-leak or unauthorized-mint path found. The two most important findings are H-1 (bigint JSON coercion silently breaks the new payload-binding defense — wedges bridge usability) and H-2 (the binding parameter is opt-in by signature, making the defense bypassable by a forgetful caller). H-3 (no meta CSP) is a deploy-model assumption that the codebase silently depends on and should not. M-1 (visibility-revive of auto-lock) and M-2 (mnemonic export auto-hide freezes when backgrounded) are the bystander-threat-model holes worth fixing this rev.
