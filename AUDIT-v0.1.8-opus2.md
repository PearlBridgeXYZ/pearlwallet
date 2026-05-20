# AUDIT — Pearl Web Wallet v0.1.8 (opus2, independent second pass)

**Scope:** Independent second-pass audit on the v0.1.8 cycle, targeted at angles
the traditional code-flow audit (opus1) is likely to under-emphasize:
adversarial inputs at boundaries, state-machine race conditions, AAD
forward-compat / downgrade risk, supply-chain hygiene, CSP / framing
defenses, worker boundary semantics, and test-coverage anti-patterns.

**Method:** Read-only. No code modified. Findings cite file:line and include
break path + concrete fix. Tooling-discoverable issues (lint, typecheck) were
not the focus — those have a separate gate.

**Severity convention:** Crit / High / Med / Low / Info. A finding is High if
exploitation under the wallet's threat model leads to fund loss, key
exfiltration, or bypass of a stated security claim. Med = degrades a defense
or breaks a documented user-visible invariant. Low = hygiene / DoS / brittle
test. Info = no bug, design observation.

---

## SUMMARY TABLE

| Sev   | ID    | Title                                                              | File                       |
| ----- | ----- | ------------------------------------------------------------------ | -------------------------- |
| High  | H-1   | Iframe-bust script is killed by the wallet's own CSP                | index.html:38              |
| High  | H-2   | RPC override consumer (`pearlParams`) does not re-validate         | src/chains/pearl/network.ts:37 |
| Med   | M-1   | Auto-lock can be bypassed by setting the wall-clock backward       | src/App.tsx:67, 88         |
| Med   | M-2   | Worker `ev.origin` guard is a no-op for same-origin workers        | src/crypto/worker.ts:304   |
| Med   | M-3   | Settings.tsx `saveRpc` swallows nothing on disallowed host (UX)    | src/ui/pages/Settings.tsx:161 |
| Med   | M-4   | AAD context binding is semantically weak (downgrade risk)          | src/crypto/keystore.ts:98  |
| Low   | L-1   | `package-lock.json` is at v0.1.7 — `npm ci` will fail              | package-lock.json:3        |
| Low   | L-2   | v0.1.8 tests use source-text regex where runtime asserts belong    | tests/v018.test.ts:285+    |
| Low   | L-3   | `iframe-bust` test asserts source presence, not runtime behavior   | tests/v018.test.ts:329     |
| Info  | I-1   | `qrcode` dep drags in yargs@15 (large build-time surface)          | package.json:25            |
| Info  | I-2   | Wallet fetches `/api/prl-price` — local dev hits no endpoint       | src/services/prices.ts     |
| Info  | I-3   | `searchrawtransactions` reorg semantics implicit                   | src/services/pearl-rpc.ts  |

---

## High

### H-1 — Iframe-bust script is killed by the wallet's own CSP (defense DOA on non-CF mirror)

**File:** `index.html:13-15` (meta CSP), `index.html:38-56` (inline script)

**Finding.** The `<meta http-equiv="Content-Security-Policy">` declares
`script-src 'self'` with no nonce, no hash, and no `'unsafe-inline'`. The
iframe-bust script directly below it is inline. Per CSP Level 3, an inline
`<script>` is blocked by `script-src 'self'` unless explicitly whitelisted.

The comment at `index.html:29-37` says this defense exists *specifically*
for non-Cloudflare mirrors where the `frame-ancestors` response header from
`public/_headers` is not served — i.e., the only deployment where the
iframe-bust is structurally necessary. On those mirrors, the meta CSP IS
served (it's in the HTML), and it blocks the script.

**Exploit path.** Attacker hosts `pearlwallet.xyz` on an IPFS gateway or S3
mirror, then embeds it in a clickjacking iframe on `evil.example`. The
browser:
1. Reads the inline meta CSP → installs `script-src 'self'` policy.
2. Reaches the inline `<script>` → policy violation → script never executes.
3. Loads `/src/main.tsx` (module, `'self'`) and renders the unlock screen
   inside the attacker's overlay.

Confirmed by checking CSP semantics: a `'self'` source whitelist without a
`'unsafe-inline'`, nonce, or hash directive denies inline script execution.
The script's own `try/catch` cannot save it — the script never runs at all.

**Test gap.** `tests/v018.test.ts:329` asserts only that the regex
`/window\.top\s*!==\s*window\.self/` appears in `index.html`. The test
passes while the runtime defense is silently neutralized.

**Fix.** Two clean options:
1. Move the iframe-bust into `/src/main.tsx` top-level (it'll be loaded as
   a module from `'self'` and execute under CSP). Document the slight
   timing delta — module loads after meta parsing but before app render.
2. Add a SHA-256 hash of the inline script to `script-src` in BOTH the
   meta CSP and `public/_headers`, e.g.:
   `script-src 'self' 'sha256-<base64hash>'`. Hash must be regenerated
   any time the inline script body changes; tie this to a `prebuild`
   step alongside `sync-version.mjs`.

Option 1 is preferable — it eliminates the meta/header drift footgun and
keeps the CSP minimal. The `frame-ancestors 'none'` response header (which
DOES protect CF deployments) is unaffected.

---

### H-2 — RPC override consumer trusts arbitrary string when passed (`pearlParams`)

**File:** `src/chains/pearl/network.ts:37-41`, `src/services/pearl-rpc.ts:38-41`

**Finding.** `isAllowedRpcOverride` in `src/state/ui-store.ts:18-27`
correctly validates the override against an allowlist at the SETTER
(`setPearlRpcOverride`) and at LOAD (`loadUI` re-validates persisted
values). However, the consumer reads the override and passes it
unconditionally to `pearlParams`:

```ts
// src/services/pearl-rpc.ts:38
function rpcUrl(): string {
  const override = useUI.getState().pearlRpcOverride;
  return pearlParams("mainnet", override).rpcUrl;
}
```

And `pearlParams` accepts whatever string arrives without re-validation:

```ts
// src/chains/pearl/network.ts:37
export function pearlParams(_net = "mainnet", override?: string): PearlNetworkParams {
  const trimmed = override?.trim();
  if (!trimmed) return PEARL_MAINNET;
  return { ...PEARL_MAINNET, rpcUrl: trimmed, rpcLabel: "custom" };
}
```

**Break path.** The defense relies on `setPearlRpcOverride()` and `loadUI()`
being the *only* paths that populate `pearlRpcOverride`. Two ways this can
break:

1. **Zustand state poisoning from a future migration.** If a future devtool
   import, store migration, or a state-restore-from-backup feature writes
   directly to `useUI.setState({ pearlRpcOverride: "..." })`, the
   allowlist is bypassed. Zustand allows direct `setState` and there is no
   middleware (no `subscribeWithSelector`/persist that revalidates).
2. **localStorage tamper window during `loadUI`.** A bookmarklet running
   pre-app could set the localStorage key to a JSON object with a hostile
   `pearlRpcOverride`. Yes — `loadUI` does re-validate. But the defense
   currently depends on two separate sources of truth; making the
   consumer also enforce it is the canonical fix.

CSP `connect-src` does kill the *fetch* at runtime, but the failure mode
is "the wallet is unusable + console errors" rather than "the wallet
detected and refused tampering" — a much weaker invariant. Worse, the
fetch error is interpreted as a sentry outage and `degraded:true` is
surfaced to the user with a stale balance.

**Fix.** Re-validate at the consumer:

```ts
// src/services/pearl-rpc.ts
function rpcUrl(): string {
  const override = useUI.getState().pearlRpcOverride;
  // Defense in depth — pearlRpcOverride was validated at the setter, but
  // we don't want this to silently allow arbitrary URLs if the store
  // shape changes or a future migration writes through setState.
  const safe = isAllowedRpcOverride(override) ? override : "";
  return pearlParams("mainnet", safe).rpcUrl;
}
```

Or, stronger: move `pearlParams`'s `override` parameter check into a typed
brand (`AllowedRpcUrl`) so callers can't pass an unvalidated string at the
type level.

---

## Medium

### M-1 — Auto-lock can be bypassed by setting the wall-clock backward

**File:** `src/App.tsx:67, 88`, `src/state/wallet-store.ts:168, 425`

**Finding.** All idle / auto-lock arithmetic uses `Date.now()` — wall-clock
time, not a monotonic clock. The check pattern is:

```ts
// App.tsx:67-71  (visibilitychange handler)
const since = Date.now() - useWallet.getState().lastActivity;
if (since > AUTO_LOCK_MS) { /* lock */ }

// App.tsx:88
const since = Date.now() - useWallet.getState().lastActivity;
if (since > AUTO_LOCK_MS) { /* lock */ }
```

`lastActivity` is set via `touch()` (`wallet-store.ts:425` `set({lastActivity: Date.now()})`).

**Exploit path.** Attacker has 60 seconds of physical access to an unlocked
device. They:
1. Open System Settings → Date & Time → disable automatic time → set the
   clock back by 24 hours.
2. Tab focus / visibility events fire, but `since = Date.now() - lastActivity`
   is now a large *negative* number. The `since > AUTO_LOCK_MS` predicate
   is false. The wallet does not auto-lock.
3. Time `touch()` fires (any pointer movement), `lastActivity` is reset to
   the past timestamp. From that point forward `since` is positive again
   but the attacker now has indefinite access until the user notices.

Variant: setting the clock *forward* would immediately trigger a lock — not
exploitable, but it's a UX surprise that exposes the absence of a
monotonic-clock invariant.

**Fix.** Use `performance.now()` for the idle clock. `performance.now()` is
monotonic per page (and survives visibility changes), starting at the
navigation-start origin. Replace `Date.now()` in the four locations:
- `src/App.tsx:55` (`bump`)
- `src/App.tsx:67` (visibility handler)
- `src/App.tsx:88` (interval)
- `src/state/wallet-store.ts:168, 313, 350, 425` (touch / set lastActivity)

Note: `performance.now()` returns ms but is a `DOMHighResTimeStamp` float
— change `lastActivity` type to `number` (it already is) and the math is
identical. Keep `Date.now()` for the keystore `createdAt` field — that's
a calendar timestamp, intentionally wall-clock.

---

### M-2 — Worker `ev.origin` guard is effectively a no-op

**File:** `src/crypto/worker.ts:304-317`

**Finding.** The worker's `onmessage` handler has an origin check:

```ts
const expected = (self as unknown as { location?: { origin?: string } }).location?.origin;
if (ev.origin && expected && ev.origin !== expected) {
  return;
}
```

The HTML `MessageEvent.origin` is **specified to be the empty string `""`
for messages received by a dedicated worker** spawned via `new Worker(url)`
(HTML Living Standard §worker semantics — dedicated workers do not carry
an origin on their message channel; only `SharedWorker` / `ServiceWorker`
/ cross-document `postMessage` populate `ev.origin`).

So `ev.origin === ""` for every legitimate message from `worker-client.ts`,
and the guard's `if (ev.origin && expected && ...)` short-circuits on the
falsy `ev.origin`. The check is a no-op for the normal path; the comment
at lines 304-313 even acknowledges accepting `""`.

**Threat model.** The dedicated worker is spawned by `new CryptoWorker()`
in `src/crypto/worker-client.ts:16`. Per the spec, **only the spawning
Window can postMessage to it** — there is no cross-origin attack surface
on a dedicated worker by design. The origin guard isn't *needed* here.

So this is not a vulnerability per se — but it IS a false sense of
defense. A future change to `SharedWorker` (e.g., to share crypto across
tabs without IndexedDB) would suddenly need real origin handling, and the
existing code would silently fail to provide it because `""` is accepted.

**Fix.** Either:
1. Delete the guard and add a 2-line comment explaining dedicated workers
   don't need one.
2. Replace with a more meaningful invariant: check `MessageEvent.source`
   (must be null for dedicated workers — anything else is suspicious), or
   verify the message structure matches `WorkerCmd` before processing
   (already done implicitly by the type-narrowing dispatch).

The comment at 304-313 should be updated regardless — "`""` appears under
file:// and some test runners" is misleading; it's the normal case.

---

### M-3 — `saveRpc` allows the user to click "Save" on a disallowed https URL with no error message

**File:** `src/ui/pages/Settings.tsx:142-164`

**Finding.** `saveRpc` validates:
1. Trims input.
2. Empty → save default, return.
3. `new URL()` → catches malformed.
4. `parsed.protocol === "https:"` → rejects `http:`, but ACCEPTS any
   other https URL (including evil.example).
5. Calls `setPearlRpcOverride(parsed.toString())`.

`setPearlRpcOverride` (`ui-store.ts:88-98`) throws
`E_RPC_OVERRIDE_NOT_ALLOWED` if the host isn't on the allowlist. `saveRpc`
**does not wrap that call in try/catch**. The result is an uncaught
exception in the React event handler (`onClick={() => saveRpc()}`).

**Break path.** A user enters `https://my-cool-rpc.io/` from a phishing
guide. They click "Save". The page throws unhandled, the input stays
populated, no error is rendered. They believe the override took effect —
in fact `pearlRpcOverride` is still empty. Best-case: confusion. Worst-
case: the user goes through a second flow assuming their override is
live, sends a tx using a balance from a "trusted" RPC that they didn't
actually configure, and acts on misleading data.

**Fix.** Either:
1. Call `isAllowedRpcOverride(trimmed)` from `saveRpc` and surface a clear
   "That host isn't in the wallet's allowlist (CSP would block it
   anyway)" message via `setRpcStatus`. The allowlist hosts should
   probably be listed in the UI when this triggers.
2. Wrap the `setPearlRpcOverride` call in try/catch and surface the
   error.

Option 1 is better — single source of truth (the allowlist function),
no exception-as-control-flow.

---

### M-4 — AAD context-binding is semantically weak (stored bytes trusted on decrypt)

**File:** `src/crypto/keystore.ts:98-122`

**Finding.** v0.1.8's AAD comment (`keystore.ts:9-20`) claims the AAD
"binds the ciphertext to the version, KDF identity, iteration count, and
cipher." The encrypt path (lines 76-96) builds AAD from the current
runtime constants (`SUPPORTED_BLOB_VERSION`, `KDF_ITERATIONS`,
`"PBKDF2-SHA256"`, `"AES-256-GCM"`) via the module-level `AAD` constant.
The decrypt path (lines 98-122) reads `blob.aad` — the AAD bytes stored
*alongside* the ciphertext — and passes them to `subtle.decrypt`.

```ts
// line 113:
{ name: "AES-GCM", iv: blob.iv as BufferSource, additionalData: blob.aad as BufferSource },
```

This means GCM verifies that the AAD bytes have not been tampered with
relative to the encryption, but it does **not** verify that the AAD bytes
*match* the blob's claimed header fields (`blob.version`, `blob.kdf`,
`blob.kdfIterations`, `blob.cipher`).

**Why this matters.** The defense claim is that "a keystore exported from
this build will not decrypt against a future v2 blob that swaps cipher
or iterations." But: the blob's *headers* declare the params used for
KDF derivation (`blob.kdfIterations`, `blob.kdfSalt`, `blob.kdf`), and
those headers are what `deriveKey` reads at line 110. AAD is not part of
the KDF input — it's part of the GCM verification.

So a forged blob *could* declare `kdfIterations: 1000` in the header, and
the AAD stored in `blob.aad` could declare `iter=600000`. GCM happily
authenticates that the AAD bytes weren't tampered post-encryption, but
the KDF runs with 1000 iterations.

**Impact.** Limited under the v0.1.8 wallet's actual flow:
- The blob is loaded from IndexedDB. An attacker who can write IndexedDB
  can also do worse things.
- The future v2-rejection guard at `decryptBlob:103-108` rejects any blob
  with `version !== 1` *or* `kdf !== "PBKDF2-SHA256"` *or*
  `cipher !== "AES-256-GCM"`. This effectively pins the blob's header
  fields. So the AAD-vs-header drift is bounded by the version check.

But: if v2 is ever introduced and the version check is relaxed (e.g.,
to support backward compat with v1 blobs while accepting v2), the
guard collapses. And there is no test in `tests/v018.test.ts` that
verifies decrypt fails when blob.aad is replaced with a v2-style AAD
while header fields stay v1 — that would catch the regression.

**Fix.** On decrypt, **recompute** the expected AAD from the blob's
declared header fields and compare to `blob.aad` byte-for-byte BEFORE
calling `subtle.decrypt`:

```ts
// src/crypto/keystore.ts:decryptBlob, after line 108
const recomputedAAD = computeAAD(blob.version, blob.kdf, blob.kdfIterations, blob.cipher);
if (recomputedAAD.length !== blob.aad.length || !timingSafeEqual(recomputedAAD, blob.aad)) {
  throw new Error("E_AAD_MISMATCH");
}
```

Use a constant-time comparison (the values are not secrets, but consistency).
This makes the binding the comment claims into the binding that the code
actually enforces.

Add a test in `tests/v018.test.ts` that crafts a blob with mismatched
header/AAD and asserts decrypt fails.

---

## Low

### L-1 — `package-lock.json` is at v0.1.7 (package.json is v0.1.8); `npm ci` will fail

**File:** `package-lock.json:3, 7`

**Finding.** `package.json` declares `"version": "0.1.8"`; `package-lock.json`
declares `"version": "0.1.7"` at both the root and the nested
`packages.""` entry. `npm ci` requires the lockfile root version to match
`package.json` exactly. CI / Cloudflare Pages / IPFS-mirror builders that
invoke `npm ci` will fail with `EUSAGE`.

**Fix.** Run `npm install` once to regenerate the lockfile, then commit.
Alternatively, the `prebuild` `sync-version.mjs` step could also update
`package-lock.json`'s root version field — that closes the drift class
permanently.

### L-2 — Several v0.1.8 tests assert source-text regexes instead of runtime behavior

**File:** `tests/v018.test.ts:285-311`, `tests/v018.test.ts:314-325`

**Finding.** The "no-mnemonic-in-session" tests at lines 285-311 read
`src/crypto/worker.ts` as a string and regex-match its source:
- Line 295: `src.match(/interface WorkerSession \{([\s\S]*?)\}/)` then
  asserts `body.includes("mnemonic") === false`.
- Line 308: `new RegExp(\`case "${name}":[^]*?wipeSession\\(\\)\`)`.

These pass when the source LOOKS right, not when the runtime BEHAVES
right. Renaming `WorkerSession` to `WSession` would silently invalidate
the first test (it would always pass because `match` returns null and
`match!` would throw → test fails noisily, which is OK). But moving the
`mnemonic` field into a `private` class field, or stashing it in a
closure capture, would still leave a runtime exfiltration path while
the regex returns clean.

The vite-sourcemap test (line 314-325) similarly regex-matches
`sourcemap: false` in the config file — fragile to formatting changes
(e.g., `sourcemap:false` without space would fail, even though behavior
is identical).

**Fix.** Replace with runtime assertions:
- For "no mnemonic in session": after `unlock()`, walk the worker's
  serialized state (e.g., via a test-only `__debugSerializeSession()`
  helper) and assert no field contains the input mnemonic string. This
  catches closures, prototypes, and renames simultaneously.
- For sourcemap: build the project and inspect `dist/assets/*.js.map`
  presence. Less flaky, actually tests the deliverable.

These don't have to ship in v0.1.8 — they're long-term tech debt — but
the wallet's threat model leans heavily on "tests catch regressions."

### L-3 — The iframe-bust test is a string-presence assertion, not a runtime check

**File:** `tests/v018.test.ts:329-334`

**Finding.** The only assertion is that `index.html` source contains the
regex `window\.top\s*!==\s*window\.self`. The test passes today even
though (per H-1 above) the script never executes under the wallet's CSP.

**Fix.** Either delete this test once H-1 is resolved (it becomes part of
a real defense-in-depth chain), or upgrade it to a Playwright /
puppeteer integration test that loads the wallet inside an iframe and
asserts the iframe-bust UI replaces the document.

---

## Informational

### I-1 — `qrcode` transitive deps include `yargs@15`

`package.json:25` declares `"qrcode": "^1.5.4"`. `qrcode@1.5.x` pulls
`yargs@15.x` for its CLI shim, which transitively includes ~30 deps
including `cliui`, `string-width`, `wrap-ansi`, etc. None of these end up
in the production bundle (Vite tree-shakes), but they're in the build
environment and contribute to the supply-chain attack surface.

Alternative: use a smaller QR encoder (e.g., `qr-code-styling`,
`qrcode-generator`) without a CLI surface. Not urgent.

### I-2 — Wallet UI fetches `/api/prl-price` which is a CF Pages function (`functions/api/prl-price.ts`)

`src/services/prices.ts` and the OTC price proxy depend on the function
being live alongside the static deploy. Local dev (`vite` without Pages
runtime) and any mirror deploy (IPFS, S3, plain nginx) won't have it. The
wallet should:
- Gracefully degrade ("price unavailable") on fetch failure (verify this
  behavior — quick read of `prices.ts` shows error handling is present;
  this is more of a deployment-doc note).
- Document the function dependency in the README / DEPLOY notes for
  non-CF mirror operators.

### I-3 — `searchrawtransactions` reorg semantics implicit

`src/services/pearl-rpc.ts` walks UTXOs by paging
`searchrawtransactions` against each address in the pool. If the sentry
returns transactions that were in a chain tip that subsequently reorgs
away, the wallet's computed balance includes spends/receives that the
network no longer agrees on. The btcd RPC layer doesn't filter for
confirmations by default. The `RawTx.confirmations?` field is parsed but
not enforced anywhere visible.

Recommendation (defense-in-depth): require `confirmations >= 1` for
included UTXOs and surface unconfirmed-but-seen balance as a separate
"pending" line. Out of scope for v0.1.8 hotfix but worth a tracking
issue.

---

## Defense-in-depth recommendations (not bugs)

These are not findings — they're hardenings worth adopting as the wallet
matures.

1. **Subresource Integrity for the inline iframe-bust (once H-1 is fixed
   via option 2).** Pinning the hash in CSP gives you tamper detection at
   the meta level if the deploy pipeline is ever compromised.

2. **Constant-time AAD comparison** (M-4 fix). Even though the AAD bytes
   aren't secret, training the codebase to use timing-safe comparisons
   for all crypto-adjacent byte equality checks builds the right reflex.

3. **`Permissions-Policy` could deny more.** Current header denies
   accelerometer/camera/etc. Add: `clipboard-read=()`, `display-capture=()`,
   `interest-cohort=()`, `screen-wake-lock=()`. The wallet writes to
   clipboard (mnemonic export, address copy) but doesn't read; explicitly
   denying read is defense against a future regression.

4. **`Cross-Origin-Resource-Policy: same-origin` is on `public/_headers`.**
   Good. Verify the `/api/prl-price` CF Pages function also returns
   `CORP: same-origin` — if not, a cross-origin requester could read the
   price feed, which isn't sensitive but is a hygiene gap.

5. **Lock files: dual lockfile drift detection.** Add a CI step that
   runs `node -e "const a=require('./package.json').version, b=require('./package-lock.json').version; if(a!==b) process.exit(1)"` as the first CI gate. Cheaper than discovering it
   at `npm ci` in the Cloudflare build step.

6. **AAD recompute test.** Once M-4 is fixed, add a positive test:
   "decrypt rejects a blob whose stored AAD doesn't match header
   fields." Today no test exercises that path.

7. **Monotonic-clock invariant test for auto-lock.** Once M-1 is fixed,
   add a test that mocks `performance.now()` to advance independently
   of `Date.now()` and asserts auto-lock fires based on `performance.now`.

8. **Worker boundary integration test.** Spawn a real Worker in
   jsdom + happy-dom, post a message with a forged `origin`, assert it
   is (or isn't, per design) accepted. Today the guard is a static
   review surface only.

9. **CSP report-only deployment in staging.** Add a `Content-Security-Policy-Report-Only` header alongside the enforcing CSP that posts
   violations to a sink. The H-1 finding (inline script blocked by CSP)
   would have shown up immediately on the first staging load.

10. **OnboardingRestore mnemonic input has no max length.** A pasted
    blob of 100kB into one of the 12 word inputs would be passed to
    `cryptoWorker.call("validateMnemonic", ...)` and serialized over
    postMessage. `validateMnemonic` would reject it cheaply, but the
    boundary could enforce a reasonable per-word maxLength (≤ 8) at the
    input element to fail-fast on accidental paste of the full encrypted
    blob into one input.

---

## What this audit did NOT cover

- Detailed Pearl L1 address codec / bech32m correctness — covered by
  bech32m round-trip tests already and outside opus2's differentiator
  angle. opus1 should have it.
- viem upgrade path / dependency CVEs at the lockfile level — `npm audit`
  was not run; the lockfile drift (L-1) blocks meaningful execution.
- Cross-browser worker spec divergence (Safari old) — would need real
  device testing.
- React Router v6 deep-link handling — wallet does not register any
  custom URI scheme handler, so no `pearl:` / `prl:` deeplink attack
  surface exists in v0.1.8.

---

*opus2 / v0.1.8 audit pass complete.*
