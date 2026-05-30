# AUDIT-v0.2.4 — Lock & Password Surface

Audit window: post the v0.2.4 route-guard / Unlock.tsx fix that closed the
`locked → /settings → /dashboard` bypass. Scope: password handling +
encryption at rest, lock mechanism end-to-end.

Reviewer: Bridge Developer
Date: 2026-05-20
Build: package.json reports v0.2.3 (the v0.2.4 label is the fix tag, not
yet bumped in package.json — flagged at Notes #1).

Test state: `npm run typecheck` clean. `npm test` → 347 passed, 4
skipped (live-RPC integration tests, expected). No regressions from
prior audits.

---

## Summary

The v0.2.4 fix is **correct and complete** for the reported bypass:

* `App.tsx` route-guard `useEffect` deps now include `location.pathname`
  and `navigate`, so the guard re-runs on every navigation (not just on
  status flips). While `status === "locked"` only `/unlock` and
  `/onboarding/restore` are reachable; every other path is replaced
  with `/unlock`. Verified by reading the guard control flow against
  every `<Link>` and `navigate(...)` call in the codebase.
* `Unlock.tsx` no longer exposes a `Link to="/settings"` — the
  "Wipe this wallet" affordance is now a static `<p>` explaining the
  flow requires unlock first.

The crypto-at-rest primitives are sound: PBKDF2-HMAC-SHA256 with 600k
iterations (above OWASP's 600k floor for SHA-256, ahead of MetaMask's
historical 10k and on par with Bitwarden's 600k post-2023), AES-256-GCM
with a 12-byte random IV and a 16-byte random salt drawn from
`crypto.getRandomValues`, and a structured AAD that binds the cipher
+ KDF + iteration count + blob version into the GCM auth tag (closes a
prior audit's H6 finding on context binding). Each `encryptPlaintext`
call fetches a *fresh* random salt and IV — no nonce reuse on
`changePassword`.

Worker-side session lifetime is correctly bounded. `wipeSession()` zeroes
every retained `Uint8Array` (per-pool privkeys, eth privkey, BIP-39 seed)
and nulls the session pointer. `cryptoWorker.reset()` then terminates the
worker entirely and rejects any in-flight promises — every `lock()` path
in `wallet-store.ts` calls both. There is no retained derivation cache
between locks.

Two findings worth recording, both **Medium**, neither blocks ship:

1. **Auto-lock pre-state-flip navigate flash** (App.tsx onVis + interval).
   `void lock(); navigate("/unlock")` runs synchronously; the route guard
   sees `status === "unlocked"` & `path === "/unlock"` and bounces back
   to `/dashboard` for ~one tick until `lock()` resolves and flips the
   status. No data exposure (worker is being torn down in parallel and
   any signing call inside that window fails with E_WORKER_RESET /
   E_LOCKED), but it's a visible flash and an unnecessary
   round-trip. Two-call fix: `await lock(); navigate(...)`.

2. **`useQuery` polls remain enabled while `status !== "unlocked"`**.
   Dashboard, ActivityList, and VaultDetail all gate on
   `enabled: !!addresses`, and `addresses` is populated on
   `loadKeystore()` at `status === "locked"`. The route guard's bounce
   to `/unlock` unmounts the page before the next refetchInterval tick,
   so in steady state no RPC fires while locked — but the *initial*
   render after status flips to "locked" can fire one request in the
   gap between the status change and the route guard's `navigate`. Only
   public data (the user's own addresses) is sent, so this is a
   metadata-leak / "lock signal to RPC" issue, not key exposure. Tighten
   by gating queries on `status === "unlocked"`.

VERDICT: **CLEAN — ready to ship.** The reported bypass is fixed. The
two Mediums are quality-of-implementation issues, not security gaps.

---

## Critical

None.

The Wipe→/settings→/dashboard chain is closed:

* `Unlock.tsx` no longer has a `<Link to="/settings">`. (Verified by
  full read of `src/ui/pages/Unlock.tsx` — the only outbound link is
  `<Link to="/onboarding/restore">`, which is on the route guard's
  allow-list for the `locked` state.)
* `App.tsx`'s route guard deps now include `location.pathname`. Any
  attempt to reach `/settings`, `/dashboard`, `/vaults*`, `/send/*`,
  `/receive`, `/bridge`, `/history`, `/about`, or `/onboarding/create`
  while `status === "locked"` triggers `navigate("/unlock", {replace:
  true})` synchronously. (Verified by tracing the guard against the
  full route table in App.tsx lines 179–200.)
* No `<Navigate to=…>` element bypasses the guard. The only
  `<Navigate>` is the catch-all `path="*"` element that redirects to
  `/`; `/` then trips the guard back to `/unlock`.
* `history.replaceState` / direct address-bar injection does not bypass
  the guard either, because the guard is keyed on React Router's
  `useLocation().pathname` which updates on every router-mediated
  navigation. (A user with DevTools could `history.replaceState` to
  change the URL bar without triggering the guard, but the rendered
  Route is still `/unlock` — no UI state is mutated. Not a vector.)

`/onboarding/restore` is intentionally reachable while locked — it's
the documented forgot-password path. The overwrite there requires a
valid BIP-39 phrase typed by the user; an attacker with physical
access but no seed phrase can use it to brick the device-local
keystore (denial of service) but cannot read or move existing funds.
This is the documented design tradeoff.

`/onboarding/create` is correctly blocked while locked. Without that
block, the `createWallet → restoreWallet` overwrite dialog could be
clicked through without password verification. The guard fix is what
closes that escalation, so the audit confirms it works:

```
status === "locked"
path === "/onboarding/create"
→ path !== "/unlock" && path !== "/onboarding/restore"
→ navigate("/unlock", { replace: true })
```

---

## High

None.

The lock-mechanism invariants hold end-to-end:

* **`lock()` actually drops the keys.** `wallet-store.ts:358` calls
  `cryptoWorker.call("lock", ...)` (which dispatches `wipeSession()` in
  the worker — zeroes every privkey + the BIP-39 seed), then
  `cryptoWorker.reset()` which terminates the worker entirely. After
  that, any later worker call lazy-spawns a fresh worker with
  `session === null` and every signing handler short-circuits on
  `if (!session) throw new Error("E_LOCKED")`. There is no recoverable
  state held in main-thread JS after a successful `lock()` — the store
  retains `blob` (ciphertext only) and `addresses` (public addresses
  only), nothing key-deriving.
* **`wipeSession()` is exhaustive.** Every field in `WorkerSession`
  (the `pearlReceive[i].privKey` array, `ethPrivKey`, and the BIP-39
  `seed` retained for multisig child derivation) is `.fill(0)`-zeroed
  before the session pointer is nulled (`worker.ts:60`). The seed
  retention is explicitly documented (`worker.ts:42–47`) and is wiped
  on every lock. Tests guard against regression: `tests/v018.test.ts`
  asserts the `WorkerSession` type does NOT carry a `mnemonic` field
  and asserts `createWallet`/`restoreWallet`/`unlock` each invoke
  `wipeSession()` before reassigning.
* **No AEAD primitive substitution risk.** Keystore decrypt rejects
  any blob whose `kdf !== "PBKDF2-SHA256"` or `cipher !== "AES-256-GCM"`
  with `E_UNSUPPORTED_BLOB_VERSION` *before* attempting to derive the
  key. The AAD is computed deterministically as a pipe-delimited byte
  sequence (no JSON insertion-order dependency — see comments at
  `keystore.ts:13–20`) and bound into the GCM auth tag; flipping any
  of {version, kdf, iter, cipher} on the blob fails authentication and
  surfaces as `E_PASSWORD_WRONG`. Verified by `tests/keystore.test.ts`
  → "decrypt fails (E_PASSWORD_WRONG) if AAD on the blob is tampered".
* **No IV reuse across re-encryptions.** `encryptPlaintext` draws a
  fresh `crypto.getRandomValues(new Uint8Array(12))` for the IV every
  call. `changePassword` re-encrypts the *plaintext* (decrypted
  mnemonic) and obtains a fresh IV and salt for the new blob —
  `tests/keystore.test.ts:58` directly asserts distinct salt + IV +
  ciphertext for two encrypts of the same plaintext.
* **Password compared via WebSubtle decrypt.** `decryptBlob` returns
  the plaintext on success or throws `E_PASSWORD_WRONG` on any
  WebCrypto failure (auth tag mismatch, key derivation failure). There
  is no main-thread string equality on the password — comparison is
  done via the AEAD auth tag, which is constant-time by spec on
  every WebCrypto implementation. No timing side-channel reachable
  from JS.
* **Visibility-change handler checks elapsed BEFORE bumping**
  (`App.tsx:73–86`). The clock source is `monotonicNow()` which uses
  `performance.now()` (or a latched `Date.now()` high-watermark
  fallback). A backward wall-clock step (NTP, VM resume, DST,
  hostile OS) cannot reduce the reported elapsed. The auto-lock poll
  uses the same source (`App.tsx:97–107`), so an attacker cannot
  trick the wallet into staying unlocked past the policy window by
  walking the clock.
* **BroadcastChannel events are sender-gated.** Every payload carries
  `sender: SENDER_ID` (per-tab `crypto.randomUUID()`), and the
  `onmessage` handler short-circuits if `ev.data.sender === SENDER_ID`
  to prevent the originating tab from receiving its own broadcast and
  force-locking itself after `changePassword`. Closes the
  v0.1.7-opus2-H3 finding; preserved end-to-end.
* **`changePassword` cross-tab race is guarded.** After the worker
  produces the new blob, `wallet-store.ts:409` re-checks
  `loadKeystore()` and throws `E_WALLET_WIPED` if a peer-tab wipe
  arrived during the worker round-trip. The local `set({blob:newBlob})`
  is gated on the row still existing — no resurrection of a stale
  password.
* **`wipe(password)` requires the password.** Wipe attempts a worker
  `exportMnemonic` decrypt with the provided password against the
  current blob. A wrong password throws `E_PASSWORD_WRONG` *before*
  any state mutation; the keystore stays intact. Only on successful
  decrypt does the wipe proceed to `cryptoWorker.reset()` → `wipeKeystore()`
  → broadcast → `set({status:"no-wallet"})`. Closes the v0.1.5
  "Wipe with no password" footgun.
* **`wipeKeystore` is true wipe.** `db.keystore.delete("primary")`
  followed by clearing `addressBook`, `txCache`, `vaults`,
  `vaultPendingTxs`, then a `try/finally` block that scrubs every
  versioned `pearl-wallet-ui-*` key from `localStorage` even if the
  Dexie call throws. Single source of truth, audit-tested
  (`tests/v018.test.ts:243`).
* **TopBar Lock button works while unlocked, hidden while locked.**
  The button is rendered inside `status === "unlocked"` guard
  (`TopBar.tsx:49–73`) so a locked user cannot trigger a redundant
  lock. The button's `onClick` does `await lock()` *then*
  `navigate("/unlock")` — correct ordering, no flash.
* **Async-lock serialization holds.** Every state-mutating store op
  (`createWallet`, `restoreWallet`, `unlock`, `wipe`, `changePassword`)
  and every BroadcastChannel handler runs inside `walletLock`. This
  closes the unlock-vs-wipe interleave: a peer's `wiped` event cannot
  land between `cryptoWorker.call("unlock")` resolving and the local
  `set({status:"unlocked"})`. `tests/async-lock.test.ts:93–120` pins
  the invariant.

---

## Medium

### M-1. Auto-lock fires `navigate("/unlock")` BEFORE `lock()` resolves

Location: `src/App.tsx:73–86` (visibility-change handler) and
`src/App.tsx:97–107` (1Hz poll).

```js
if (since > AUTO_LOCK_MS) {
  void lock();
  navigate("/unlock");
  return;
}
```

`lock()` is async: it `await`s the worker `lock` round-trip, then
`cryptoWorker.reset()`, then `set({status: "locked"})`. Until that
chain resolves, `status` is still `"unlocked"`. The synchronous
`navigate("/unlock")` runs first and triggers the route guard, which
sees `status === "unlocked"` && `path === "/unlock"` and bounces *back*
to `/dashboard` (App.tsx:139–141). One tick later `lock()` resolves,
`status` flips to `"locked"`, the guard runs again, and the user
finally lands on `/unlock`.

Symptoms: visible flash of `/dashboard` for ~one frame after an
auto-lock fires. The worker is being torn down in parallel — any user
click in that window that triggers a worker call would hit
`E_WORKER_RESET` (the in-flight call is rejected by
`cryptoWorker.reset()`) or `E_LOCKED` (a new call into the freshly
respawned worker sees `session === null`). So **no funds-moving
attack** is reachable in the window. It's a UX defect.

Compare TopBar (`TopBar.tsx:64–70`) which does `await lock();
navigate("/unlock")` — the correct ordering.

Fix shape (do NOT apply per instructions — documenting only):

```js
if (since > AUTO_LOCK_MS) {
  void lock().finally(() => navigate("/unlock"));
  return;
}
```

or `await`-style by wrapping in an `async` arrow.

### M-2. `useQuery` polls remain enabled with public data while locked

Location: `src/ui/pages/Dashboard.tsx:16–29`,
`src/ui/components/ActivityList.tsx:23–42`,
`src/ui/pages/VaultDetail.tsx:50–54`.

All three use `enabled: !!addresses`. `addresses` is populated at
`status === "locked"` time (init reads `publicData` off the keystore
record — `wallet-store.ts:181–192`). So in the brief render window
between an unlocked page being on-screen and the route guard
re-rendering after `status → "locked"`, a polled balance/activity
query can fire one outgoing request.

What's exposed: the user's own Pearl + Eth addresses on the RPC layer
(they're public anyway and already exposed to the configured RPC
host). A passive observer of the RPC traffic could infer "this client
is locked" by the absence of activity that follows, but they had the
address list already.

Not a key/funds vulnerability. It is a state hygiene gap: queries
should fire only while `status === "unlocked"`. Tighten by gating each
`useQuery({ enabled })` on `status === "unlocked"` rather than
`!!addresses`. The `refetchInterval` won't restart while
`enabled === false`, and on unmount React Query cleans up cleanly.

This also subtly aids M-1 — fewer in-flight queries in the lock-flash
window means a cleaner transition.

### M-3. `useQuery`-driven pages render their full UI during the route-guard tick after lock

Symptom-level companion to M-2. Because the guard's `navigate` is
async (re-renders are scheduled, not synchronous), the locked user
may briefly see `/dashboard` (with stale balances) for one frame after
a manual `lock()` or auto-lock. The same flash is what M-1 produces
in the auto-lock path; the bounce eventually lands on `/unlock`.

This is mitigated end-to-end by:
* The worker is reset → no signing call succeeds during the flash.
* The route guard has `replace: true` → no back-button vector.
* Dashboard renders nothing actionable beyond `<Link>` buttons; all
  destinations are route-guarded.

But: if a future feature renders something self-actionable on
Dashboard (e.g. a "stake" widget that fires a worker call from a
useEffect), the flash becomes a real window. Add a top-level
`if (status !== "unlocked") return null;` (or a `<LockOverlay/>`)
inside `Page.tsx` as belt-and-braces. Cheap defense-in-depth.

---

## Low

### L-1. BFCache restore on browser back/forward

Location: no `pageshow` / `beforeunload` handler in `App.tsx`.

Modern browsers cache full page state — including JS heap — when the
user navigates away and back via the browser history. If a user
unlocks the wallet, navigates to a different site, then hits Back
within the BFCache window, the page resumes with `status === "unlocked"`
and a populated Zustand store. The worker session is process-bound to
the same browsing context, so it's also restored. Net effect: the
wallet is back to a fully unlocked state without re-prompting for
password.

Threat model: an attacker would need physical access to the device
*after* the legitimate user unlocked, *before* the auto-lock window
elapsed in the BFCache. In practice the user has navigated away — so
the auto-lock interval is suspended (`setInterval` is paused while
the page is hidden) and the visibility-change handler doesn't fire on
BFCache restore (it dispatches `pageshow` instead, which we don't
listen to).

Tighten by adding a `pageshow` handler in `App.tsx`'s lock-poll effect
that checks elapsed and locks on stale: `window.addEventListener(
"pageshow", (e) => { if (e.persisted) { /* same elapsed check */ }})`.
Same logic as `visibilitychange`, just keyed on BFCache restore.

### L-2. OnboardingCreate retains mnemonic in main-thread state

Location: `src/ui/pages/OnboardingCreate.tsx:13,49`.

```js
const [mnemonic, setMnemonic] = useState<string>("");
// …
setMnemonic(out.mnemonic);
```

The mnemonic is displayed during the verify-words step (necessary to
let the user confirm), so it has to live in React state for the
wizard's duration. Once the wizard completes (`restoreWallet` is
called and the user navigates to `/dashboard`), the component
unmounts and React drops the state — but until then, the string is on
the main-thread heap and visible to any future heap dump.

This is the same tradeoff that Settings' Export Recovery Phrase
handles by auto-hiding after 60s + on visibility-change + on unmount.
OnboardingCreate doesn't have an analogous auto-hide — the user needs
the words on-screen until they click "I've written it down" and the
verify step accepts them. The mitigation is shorter exposure: scrub
`setMnemonic("")` immediately after the `restoreWallet` call returns
(currently the state lives until the unmount); also scrub on
visibility-change during the verify step.

Not a remote-attacker vulnerability — requires heap-dump-level
access to the browser process. Worth flagging for completeness.

### L-3. Settings reveal: a deeply-targeted shoulder-surf still possible

Settings auto-hides the mnemonic after 60s and on tab-hide. But
during the visible window, the string is rendered into the DOM as a
`<pre>` node. A pre-existing extension with `tabs` permission can read
it. Not new in v0.2.4 — the wallet's threat model excludes hostile
browser extensions (consistent across all prior audits). Worth a
note only.

### L-4. `passwordAcceptable` minimum still permissive against targeted attackers

10-char two-class minimum (or 16-char passphrase with non-degenerate
variety). Combined with 600k PBKDF2-SHA256, a 10-char two-class
password (~50 bits entropy) is offline-attackable in
~weeks-to-months on a single modern GPU rig (~$5k hardware,
electricity excluded). The escape hatch passphrase (16+ chars,
degeneracy-guarded) does the right thing for users who use it.

This is a known tradeoff and the current floor matches MetaMask's
(8 chars). The fix is to push users toward the passphrase path with
better UI guidance, not to raise the technical floor. Not new in
v0.2.4. Documented for posture awareness.

---

## Notes

### N-1. Version label drift

`package.json` reports `"version": "0.2.3"`. The audit file is
labeled v0.2.4 and the route-guard comment references
`v0.2.4 (SEC fix)`. The version bump hasn't landed in package.json
yet. Not security-relevant; bump before tagging the release so the
Footer's `BUILD_VERSION` matches what shipped.

### N-2. `crypto.randomUUID()` fallback path

`SENDER_ID` falls back to `${Date.now().toString(36)}-${Math.random()...}`
on environments without `crypto.randomUUID`. Acceptable — the sender id
is a tag, not a secret, and the only modern browsers without
`randomUUID` are well-defined exceptions (Safari <15.4 is the most
recent gap, since closed). Documented at `wallet-store.ts:83`.

### N-3. `init()` is idempotent via `storeInitialized` flag

Closes the React.StrictMode dev-mode double-effect race that would
otherwise overwrite an in-flight unlock back to `"locked"`. The flag
is module-scoped; `__resetWalletStoreForTests()` clears it. Verified
sound. Cold-start through `/onboarding/create` works because init()
runs before the unmount of Splash, settles `status: "no-wallet"`,
and the StrictMode second mount returns early on the flag.

### N-4. `restoreWallet` accepts any mnemonic that passes
`validateMnemonic`

This is the intended forgot-password recovery path. An attacker with
physical access but no seed phrase can replace the device-local
keystore with their own (denial of service against the legitimate
user's local wallet, no impact on on-chain funds — the legitimate
user recovers via their own seed phrase on another device). Already
documented in OnboardingRestore.tsx and the route-guard rationale.
Recording here so a future audit doesn't flag it as a regression.

### N-5. The async-lock `walletLock` serializes only at the store
boundary

If two operations in different store methods happen to both not call
`walletLock` (e.g. a future method that forgets the wrapper), the
serialization invariant breaks. Currently every mutating method calls
it. Worth a lint rule or a test that greps for new `async`
exports in `wallet-store.ts` against the `walletLock` wrapper.

### N-6. Auto-lock window is 5 minutes — appropriate default

Matches MetaMask's (5 min on extension, configurable). Lightweight
attack surface: a user who walks away from their device gets locked
within 5 min of last input. No way to defeat via clock manipulation
(monotonic clock).

### N-7. Test coverage status

* `tests/keystore.test.ts` (14 tests): AEAD round-trip, AAD binding,
  version guard, salt/IV uniqueness, password rejection. Strong.
* `tests/async-lock.test.ts` (4 tests): serialization, error
  propagation, the unlock-vs-wipe interleave. Strong.
* `tests/validate.test.ts` (20 tests) + `tests/v019.test.ts` /
  `tests/v018.test.ts`: passwordAcceptable and the degenerate-entropy
  guard. Strong.
* `tests/v018.test.ts:289–317`: source-level grep guards that
  `WorkerSession` never grows a mnemonic field and that every session
  reassignment calls `wipeSession()`. Strong.

**No end-to-end browser test covers the route-guard's
`location.pathname` dependency.** A vitest or Playwright test that
mounts `<App/>` under a memory router, sets `status: "locked"`, and
asserts that `navigate("/settings")` lands on `/unlock` would be the
direct regression guard against the originally-reported bypass.
Recommend adding before next release. (Logging as a Note, not a
Medium, because the manual fix verification is solid and the
tests-as-spec gap is well-understood across the project.)

---

## VERDICT

**CLEAN — ready to ship.**

* The reported bypass (`Wipe link → /settings → /dashboard`) is closed
  at both vectors: route-guard pathname-awareness AND removal of the
  Settings link from Unlock.tsx.
* Crypto-at-rest primitives are sound and unchanged from prior audits.
* Worker session lifetime is correctly bounded; lock truly drops the
  keys; wipe truly removes the keystore.
* The two Mediums (auto-lock UX flash, useQuery while transitioning to
  locked) are quality-of-implementation issues, not security gaps —
  no funds-moving or key-exposure path is reachable in either.
* Lows are known tradeoffs, documented for posture awareness.

Ship this build. File M-1 / M-2 / L-1 as follow-up tasks; none block
release.
