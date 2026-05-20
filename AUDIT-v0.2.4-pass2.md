# AUDIT-v0.2.4 — Pass 2 (Convergence)

Audit window: verifying the M-1 (await-before-navigate auto-lock) fix and
the `routeGuardTarget` extraction shipped after pass 1
(`AUDIT-v0.2.4-lock-password.md`). Scope: route guard correctness, lock
race windows, unit-test coverage, and a sampling re-verification of
the crypto-at-rest claims from pass 1.

Reviewer: Bernard
Date: 2026-05-20
Build: `package.json` reports `0.2.4` (now bumped — pass 1 note closed).

Test state: `npm run typecheck` clean.
`npm test` → 25 files, **407 passed / 4 skipped / 1 file skipped**
(`pearl-rpc-live.test.ts` — live-RPC integration). Matches the claim
in the prompt.
`npm run build` → clean (`vite build` produces 4 chunks; only a
pre-existing micro-packed `/* @__PURE__ */` comment warning, unrelated
to this audit).

---

## Summary

Both v0.2.4 fixes are **correct, complete, and don't introduce new
bypasses**:

* **M-1 (await-before-navigate)** is applied at both call sites — the
  `visibilitychange` handler (App.tsx ~line 111) and the 1 Hz auto-lock
  poll (App.tsx ~line 143). Each wraps the `lock(); navigate(...)`
  sequence in `void (async () => { await lock(); navigate("/unlock"); })()`,
  so the route guard never sees `status === "unlocked"` after the
  navigate lands. The `useEffect` cleanup closure (`return () => { ... }`)
  is unchanged on both effects — the IIFE is fire-and-forget inside the
  handler and does not replace the returned cleanup function.

* **Matrix extraction (`routeGuardTarget`)** is a pure exported function
  with no closure dependencies. Tracing it against every `<Route>` in
  the Routes block confirms:
  * `/`, `/unlock`, `/onboarding/create`, `/onboarding/restore` have
    explicit per-status carve-outs.
  * Every other live route (`/dashboard`, `/receive`, `/send/*`,
    `/bridge`, `/history`, `/settings`, `/about`, `/vaults`,
    `/vaults/*`) is **reachable only when `status === "unlocked"`**.
  * The `<Route path="*">` catch-all bounces to `/` (which then bounces
    via the guard).

* **Regression tests** (`tests/v024-route-guard.test.ts`, 60 cases)
  cover locked / no-wallet / unlocked / initializing × allowed-and-blocked
  paths, plus historical-bypass landing pages and history-API tricks
  (`/unlock/../settings`, `/settings/../dashboard`). Coverage is
  meaningful — the locked-side blocked-set names every concrete route
  in `<Routes>` plus deep-link variants.

* **Crypto-at-rest** re-verified at the sampling level: PBKDF2-HMAC-SHA256
  600k iterations (`keystore.ts:4`), AES-256-GCM with a 12-byte random IV
  + 16-byte random salt (`keystore.ts:78-79`) freshly drawn per
  `encryptPlaintext` call (i.e. fresh on every `changePassword` because
  it calls `encryptPlaintext` not a re-`subtle.encrypt` with stored
  params). Password is never main-thread-string-compared — every
  password-bearing op (`unlock`, `exportMnemonic`, `wipe`,
  `changePassword`) routes through the worker, which exercises it only
  as a PBKDF2 input. Worker session wipes seed + all per-pool privkeys
  + eth privkey on `lock` (`worker.ts:60-66`).

Two non-blocking quality issues recorded below:

* **Low** — `path.startsWith("/onboarding")` matches `/onboarding-fake`
  and similar non-canonical strings. Not exploitable (the `<Routes>`
  catch-all renders `<Navigate to="/">` for unknown paths, and the
  reachable surface is unchanged), but the guard's allow-set is
  semantically broader than the matching routes. Tightening to
  `path.startsWith("/onboarding/")` would make matrix and routes agree
  exactly.

* **Low** — `tests/v024-route-guard.test.ts` exercises the
  *matrix function* but not the *useEffect deps*. The original bug
  (deps = `[status]` only) lived in the effect's dependency array, not
  in the decision matrix. Reverting only the deps array would leave all
  60 unit tests green. The effect-deps regression is now defended by
  reading the source, not by the test suite — worth a Low note for
  future hardening (a jsdom + react-router test would close this).

VERDICT: **CLEAN — ready to ship.**

---

## Critical

None.

No new path to reach an unlocked state without a successful PBKDF2
decryption. The lock-bypass class identified in pass 1 is closed: every
known auto-lock call site, every `<Link>` target, every `navigate()`
call, and the route-guard `useEffect` deps line up to the same matrix.

---

## High

None.

* Route guard regression — none. M-1 fix applied identically at both
  call sites; the guard re-runs on `[status, location.pathname, navigate]`
  on every navigation; the matrix correctly bounces `locked + /settings`
  → `/unlock` (this is the historical bypass landing page; covered by
  the test suite at line 130-135).
* Auto-lock that doesn't actually lock — verified. `lock()` awaits the
  worker `lock` cmd and then calls `cryptoWorker.reset()` (terminate +
  reject in-flight). Subsequent renders see `status === "locked"` and
  the guard bounces.
* Key material retained post-lock — verified. `wipeSession()` zeroes
  `pearlReceive[*].privKey`, `ethPrivKey`, and the BIP-39 `seed` before
  nulling the session pointer; the worker is then terminated outright,
  so the heap region is reclaimed by the engine.

---

## Medium

None.

The pass-1 M-1 (auto-lock flash) is now fixed at both sites and
verified by reading `App.tsx`:

* onVis handler (line 111-132): elapsed-since-lastActivity check FIRST
  using `monotonicNow()` (not `Date.now()`), then the IIFE
  `void (async () => { await lock(); navigate("/unlock"); })()`. Return
  cleanup at line 134-137 detaches `visibilitychange` and the
  activity-bump events — unchanged from pre-fix. The IIFE itself isn't
  awaited from the cleanup; that's intended — the cleanup runs on
  unmount/dep-change, not on lock.

* 1 Hz auto-lock poll (line 143-159): same IIFE shape, same cleanup
  (`clearInterval(timer)`).

Neither IIFE captures stale closures: `lock` and `navigate` are listed
in the effect deps, so a re-render with different bindings rebuilds
the effect.

The pass-1 M-2 (`useQuery enabled: !!addresses` during the lock
transition) is **still present** but the pass-1 reviewer's
"non-blocking" call holds:

* `lock()` (wallet-store.ts:358-362) calls `set({ status: "locked" })`
  without clearing `addresses`. So `enabled: !!addresses` remains
  true for one render cycle.
* The route guard's `useEffect` on `[status, location.pathname, ...]`
  fires immediately after the status flip and `navigate("/unlock",
  { replace: true })` runs synchronously inside the effect; React
  unmounts `Dashboard` / `ActivityList` / `VaultDetail` on the next
  reconcile.
* In the worst case, one `fetchBalances` call may fire over public
  RPC with the user's own address(es) as the only argument — no key
  material, no AAD, no ciphertext. This is a metadata-leak/lock-signal
  issue at most, and the live RPC traffic the wallet emits when
  unlocked already publishes the same addresses on every 30s poll.
* Fixing it cleanly is one line in `lock()`:
  `set({ status: "locked", addresses: null })`. Recorded here so a
  future refactor doesn't lose it, but does not block ship.

---

## Low

* **L1 — `startsWith("/onboarding")` over-matches.** The matrix's
  `no-wallet` and `unlocked` branches both use
  `path.startsWith("/onboarding")` without a trailing slash, so
  `/onboarding-fake` or `/onboardingX` would be treated as
  "onboarding-shaped" by the guard. Not exploitable: the React Router
  `<Routes>` block has only `/onboarding/create` and
  `/onboarding/restore` as live routes; anything else falls through to
  `<Route path="*" element={<Navigate to="/" replace />} />`, which
  triggers another guard pass on `/`. But the matrix and the route
  table disagree on what counts as "onboarding"; tightening to
  `startsWith("/onboarding/")` would close the gap. Test cases for
  this typo class (`/onbarding/restore`, `/onboarding-fake`) are not
  in `v024-route-guard.test.ts`.

* **L2 — Regression test covers matrix, not useEffect deps.** The pass-1
  bug was deps `[status]` only — the matrix code (extracted in this
  revision) was always correct in spirit. Reverting only the deps
  array on `App.tsx` line 176 would leave every test in
  `v024-route-guard.test.ts` green. A jsdom + react-router test that
  drives the full App component would close this, but adding jsdom
  here is a non-trivial test-infra change; the 60 unit tests do catch
  any future matrix-shape regression, which is the more likely
  recurrence mode.

* **L3 — Comment at `App.tsx:80` refers to "Apply theme class on root"
  but the comment header at line 88 still calls itself line-100ish in
  the M-1 fix block.** Cosmetic only; no semantic risk.

* **L4 — `routeGuardTarget` uses `path === "/onboarding/restore"` for
  the locked carve-out, which is an exact-string compare.** Good:
  `/onboarding/restore/` (trailing slash) would NOT match and would
  bounce to `/unlock`. React Router historically canonicalises
  trailing slashes in `Link to="/onboarding/restore"` clicks, but a
  user typing `/onboarding/restore/` in the address bar would be
  bounced. Documented here as "not a bug, just be aware" — matches
  the "exact path match" intent.

---

## Notes

1. **History-API tricks.** Verified against
   `node_modules/@remix-run/router/dist/router.js`: `decodePath`
   (line 863) only decodes URI-encoded segments — it does NOT
   normalize `.` / `..`. Neither does the browser History API
   (`pushState`/`replaceState` preserve the literal path). So
   `useLocation().pathname` for a URL like `/unlock/../settings`
   yields the literal string `/unlock/../settings`, which the matrix
   correctly bounces:
   * `locked + "/unlock/../settings"`: `path !== "/unlock"`, `path !==
     "/onboarding/restore"` → returns `/unlock` ✓
   * Covered by the test at line 38-39.

   `/%2e%2e/settings` (URL-encoded `..`) gets decoded by `decodePath`
   to `/../settings`, which still does not match any carve-out — the
   matrix bounces. No exploit surface.

2. **No infinite loops.** Unlocked + `/onboarding/create` → bounce to
   `/dashboard`; unlocked + `/dashboard` → null (allowed). No cycle.
   Locked + `/dashboard` → bounce to `/unlock`; locked + `/unlock` →
   null (allowed). No cycle. No-wallet + anything-but-`/`-or-`/onboarding/*`
   → bounce to `/`; no-wallet + `/` → null. No cycle.

3. **Effect dependency completeness.** The route-guard effect lists
   `[status, location.pathname, navigate]`. `routeGuardTarget` is
   imported (not a closed-over variable) and `navigate` is stable
   across renders inside `react-router-dom`. No missing deps; ESLint
   would catch a regression here.

4. **Crypto re-verification.**
   * `keystore.ts:4` — `KDF_ITERATIONS = 600_000` ✓
   * `keystore.ts:78-79` — fresh `crypto.getRandomValues` for kdfSalt
     and iv on every `encryptPlaintext` ✓ — `changePassword`
     (worker.ts:406-410) calls `encryptPlaintext` (not `subtle.encrypt`
     with retained params) so salt+iv rotate too.
   * `keystore.ts:81-85` — AES-GCM with structured AAD (kdf|iter|cipher|
     version pipe-delimited).
   * Password handling: every entry point — `unlock`, `exportMnemonic`,
     `wipe` (via `exportMnemonic`), `changePassword` — sends `password`
     into the worker over `postMessage`. Worker uses it only as a
     PBKDF2 input. No `===`-style string compare anywhere in the main
     thread (verified by grep — no `password === ` or `password ==`
     pattern outside `worker.ts`/`keystore.ts`).
   * Worker session wipe: `worker.ts:60-66` fills `pearlReceive[i].privKey`,
     `ethPrivKey`, and `seed` with zeros before nulling. `cryptoWorker.reset()`
     then terminates the worker entirely (worker-client.ts:48-57).
   * No seed in main thread post-lock — verified: `wallet-store.ts`
     only stores `addresses` (public data) and `blob` (encrypted
     ciphertext + metadata). Mnemonic and seed live only in the worker
     closure.

5. **Build artifacts.** `dist/assets/worker-*.js` (184 kB) is the
   crypto worker as a separate bundle; main chunk is 732 kB
   (uncompressed) / 226 kB gzipped. No regression vs. v0.2.3.

6. **Pre-existing `package.json` v0.2.4 bump.** Pass-1 noted version
   drift (`package.json` reported v0.2.3 while the work was tagged
   v0.2.4). `package.json` now reports `0.2.4`. Closed.

---

VERDICT: **CLEAN — ready to ship.**
