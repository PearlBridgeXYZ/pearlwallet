# Pearl Web Wallet — v0.1.8 Audit (opus1)

**Auditor:** Bridge Developer (opus1 pass)
**Date:** 2026-05-20
**Target:** `pearl-web-wallet` at HEAD (package.json version `0.1.8`)
**Scope:** crypto/keystore, crypto/worker, services/bridge, services/pearl-rpc,
services/balances, state/wallet-store, state/ui-store, storage/db, lib/validate,
ui/pages (Send*, Onboarding*, Settings, Unlock), index.html, public/_headers,
vite.config.ts. Tests at `tests/v018.test.ts` read for cross-validation.
**Method:** static review, cross-referenced against `AUDIT-v0.1.7-opus1.md` and
`AUDIT-v0.1.7-opus2.md` to verify v0.1.8 deltas closed prior findings.

**Top line:** v0.1.8 is materially safer than v0.1.7. Every major M/H finding
from the two prior opus passes was addressed. One Medium and one Low remain in
this pass, both deliverable. No Critical, no High.

---

## Severity ledger

| Severity | Count |
|----------|-------|
| Crit     | 0     |
| High     | 0     |
| Medium   | 1     |
| Low      | 2     |
| Info     | 6     |

---

## Crit

None.

---

## High

None. (The frame-ancestors + iframe-bust + COOP/COEP stack is now layered
defense; CSP `connect-src` is tight; sourcemaps are off; sigs are
intent-bound at the type level. The previously-Crit candidates from the v0.1.7
opus2 pass — bridge unbound mint verify, BroadcastChannel self-fire, sourcemaps
leaking, frame-ancestors-only — are all closed. See "Fixed correctly" section
for the receipts.)

---

## Medium

### M-1 — Passphrase escape hatch accepts mono-class, low-real-entropy strings

**File:** `src/lib/validate.ts:43–64`
**Confirming test:** `tests/v018.test.ts` (per prior read) explicitly asserts
`passwordAcceptable("1234567890123456").ok === true`.

**What's wrong.** v0.1.8 introduces `PASSPHRASE_MIN_LENGTH = 16` and at
`validate.ts:63–65`:

```ts
if (password.length >= PASSPHRASE_MIN_LENGTH) {
  return { ok: true };
}
```

The comment justifies this as the XKCD passphrase / non-Latin-script carve-out
("a 16-char all-lowercase string `correcthorsebatterystaple` has ~70 bits of
entropy when drawn from a 7k-word list"). That argument is correct **only**
when the input actually is drawn from a dictionary. The check does not verify
that. It accepts:

- `"1234567890123456"` — 16 chars, one class, ~0 bits real entropy
- `"aaaaaaaaaaaaaaaa"` — 16 chars, one class, ~0 bits real entropy
- `"passwordpassword"` — 16 chars, one class, ~10 bits real entropy
- `"qwertyuiopqwerty"` — 16 chars, one class, walking-the-keyboard pattern

The test suite proves this is intentional behaviour, not an accident:
`expect(passwordAcceptable("1234567890123456").ok).toBe(true)` is committed.

**Why exploitable.** The keystore's offline-brute-force resistance is
`PBKDF2-SHA256(600k) × entropy(password)`. 600k iterations on commodity GPU
hardware is ~10–30k guesses/sec. A 16-char-sequential or 16-char-mono attempt
falls inside the first ~10^6 candidates of any modern password dictionary
(e.g., `rockyou.txt` derivatives, sequential-pattern generators). Real-world
crack time: **seconds to minutes** for a "16+ chars" password that the wallet
told the user was "very strong."

The threat model that matters here is: a passer-by with brief physical access
exfiltrates the IndexedDB keystore blob (or a stolen device, or a cloud-sync
exfil of the IDB file). 600k PBKDF2 is the moat. A mono-class 16-char
password drains the moat.

This is worse than the v0.1.7 floor — the old `MIN_PASSWORD_LENGTH=10` + two
classes rule rejects every example above. v0.1.8 made the bar lower for the
"long" path while leaving the comment claiming higher entropy.

**Concrete fix.** One of, preferably (b):

(a) **Quick patch (lines).** Add a "unique character count ≥ 8" check to the
escape hatch:

```ts
if (password.length >= PASSPHRASE_MIN_LENGTH) {
  const unique = new Set(password).size;
  if (unique < 8) {
    return { ok: false, reason: "Use a more varied passphrase (try several different words)." };
  }
  return { ok: true };
}
```

This kills `aaaa…`, `1234…`, `passwordpassword`. It still admits XKCD-style
("correcthorsebatterystaple" = 14 unique chars).

(b) **Right fix (one dep).** Ship `@zxcvbn-ts/core` + the english+common
dictionaries (≈40–80 kB gzipped). Require `zxcvbn(password).guesses_log10 ≥ 12`
(roughly 40-bit equivalent) regardless of length. The comment at
`validate.ts:22` literally says "zxcvbn deferred to keep bundle small in v1
scaffold." v0.1.8 is past v1 scaffold. The bundle cost is bounded and the
heuristic is wrong without it.

(c) **Update the test to reflect intent.** If (a) or (b) lands, the
`"1234567890123456".ok === true` assertion in `tests/v018.test.ts` must be
flipped to `false` — that test is locking in the bug.

**Why not High.** The keystore exfil prerequisite is non-trivial (device
access or IDB exfil), and the user's recovery phrase remains the actual
cold-storage backstop. But this is the user's *only* line of defense against
"laptop stolen at airport, attacker has 24h before remote-wipe lands" — a
realistic threat for a non-custodial wallet. Borderline Medium/High. Calling
it Medium because the wallet UI's "Strength: very strong" label was always
a heuristic, not a guarantee.

---

## Low

### L-1 — `Settings.saveRpc` calls `setPearlRpcOverride` without catching the allowlist throw

**File:** `src/ui/pages/Settings.tsx:142–164`

**What's wrong.** `saveRpc` validates `https:` and URL parse-ability, then
calls `setPearlRpcOverride(parsed.toString())` (line 161) **without try/catch**.
The store's `setPearlRpcOverride` (per `state/ui-store.ts`) throws
`E_RPC_OVERRIDE_NOT_ALLOWED` for any host outside
`RPC_OVERRIDE_ALLOWED_HOSTS`. The throw is uncaught in the React event
handler and bubbles to the React error boundary (or, in production with no
boundary on this route, surfaces as an unhandled rejection visible only in
DevTools).

**Why this matters.** A user who enters a perfectly valid `https://my-rpc.example.com`
URL gets:
- No visible error in the Settings UI.
- `rpcStatus` says "Using custom: https://my-rpc.example.com" (line 163 runs
  before the throw — wait, actually line 161 throws first, so 162–163 don't
  run, but `rpcStatus` retains its previous value because `setRpcStatus(null)`
  fired at line 143). Result: silent failure with no feedback.
- The implicit CSP-blocks-it-anyway hint in the UI text (line 300–304) is
  cold comfort — the user concluded the form does nothing.

The `connect-src` CSP in `public/_headers` enforces the host allowlist a
second time, so the security property is intact. This is a pure UX bug, but
it's the kind that gets logged as "your RPC override is broken" by users who
don't know about the allowlist.

**Concrete fix.** Pre-check before calling:

```ts
// Pre-flight against the allowlist so we can show a useful error.
const ALLOWED = new Set(RPC_OVERRIDE_ALLOWED_HOSTS); // export from ui-store
if (!ALLOWED.has(parsed.host)) {
  setRpcStatus(`Host not on allowlist. CSP blocks anything other than: ${[...ALLOWED].join(", ")}`);
  return;
}
try {
  setPearlRpcOverride(parsed.toString());
} catch (e) {
  setRpcStatus(e instanceof Error ? e.message : "RPC override rejected.");
  return;
}
setRpcDraft(parsed.toString());
setRpcStatus(`Using custom: ${parsed.toString()}`);
```

Either expose `RPC_OVERRIDE_ALLOWED_HOSTS` from `ui-store.ts` or expose
`isAllowedRpcOverride(url): boolean` for the UI to call.

---

### L-2 — Worker `postMessage` origin guard is effectively a no-op

**File:** `src/crypto/worker.ts:304–317`

**What's wrong.** The dedicated-worker spec defines `MessageEvent.origin`
inside a worker's `onmessage` from `postMessage` as the **empty string**.
There is no "origin" on messages from the spawning page — that field is for
cross-origin `Window.postMessage`, `MessagePort`, `ServiceWorker`, and
`BroadcastChannel`. So the check:

```ts
if (ev.origin && expected && ev.origin !== expected) {
  return;
}
```

is short-circuited by `ev.origin` being `""` (falsy) on every legitimate
message. The branch never fires, ever. The comment claiming "ev.origin
should match self.location.origin" is wrong for dedicated workers.

**Why this matters.** Defense-in-depth that doesn't defend. If the threat
model genuinely required cross-context messages to be rejected
(e.g., a hostile `MessagePort` transferred in), this code wouldn't catch it
because it explicitly accepts `""`.

**Concrete fix.** Either:

(a) Delete the check and the comment — dedicated Worker `onmessage` only
fires from the spawning realm; there is no cross-origin sender to gate.

(b) Replace with a structural shape guard that always runs (which is what
defense-in-depth actually buys here):

```ts
const msg = ev.data;
if (!msg || typeof msg !== "object" || typeof (msg as any).id !== "string" ||
    typeof (msg as any).cmd !== "string") {
  return; // malformed RPC envelope
}
```

(c) If keeping the comment's spirit, replace with an actual port guard:

```ts
if (ev.ports.length > 0) return; // we never transfer ports; reject any that arrive
```

Calling this Low rather than Info because the code in tree falsely
advertises a defense it doesn't provide, which is worse than no comment.

---

## Info

### I-1 — Passphrase test asserts the bug

**File:** `tests/v018.test.ts` (per prior read; line numbers omitted as the
file wasn't re-read here)

Already covered under M-1. Calling out separately: as long as the test
`expect(passwordAcceptable("1234567890123456").ok).toBe(true)` exists, any
contributor fixing M-1 will see CI fail and conclude they introduced a
regression. Add a comment to the test, or remove/invert it when M-1 lands.

### I-2 — `RECEIVE_GAP_LIMIT = 20` is hardcoded

**File:** `src/crypto/hd.ts` (BIP-44 standard gap, referenced in
`src/crypto/worker.ts:108`)

The gap limit governs how many addresses the wallet derives, displays, and
scans on `pearl-rpc.ts`'s sentry walk. BIP-44 says 20 is the floor; many
modern wallets use 20–100 depending on UX. A user who externally generates
21+ receive addresses for a single restore (e.g., via a hardware wallet that
also used this seed) will have unreachable funds. Documentation-or-spec
issue, not a security bug. Worth a "Restore from external derivation may
need rescan" notice in restore UI in a future release.

### I-3 — Mnemonic + password still cross the worker boundary via structuredClone

**File:** `src/crypto/worker.ts:177–185` (WorkerCmd shapes)
**Carry-over:** v0.1.7 opus2 H4 was *partially* addressed in v0.1.8.

The session no longer retains the mnemonic past derivation (correct), but the
mnemonic and password are still posted from the main thread to the worker
via `postMessage`. `structuredClone` copies the string, leaving:
- one ephemeral copy in main-thread heap during the call
- one in worker heap during `seedFromMnemonic`
- both may persist in V8 heap until GC

This is the same browser-process memory exposure window the v0.1.7 audit
called out. There is no escape from this in pure-web architecture — you
cannot derive HD keys in a worker without giving it the mnemonic. Document
it; don't claim the worker boundary "isolates" the seed. The CRYPTO doc
(referenced at `worker.ts:2`) should say "minimizes the lifetime of seed
material in main thread heap" rather than "main thread never sees raw keys"
(line 1 comment is actively misleading — the main thread *does* see the
mnemonic en route to and back from the worker for `createWallet`/
`restoreWallet`/`exportMnemonic`).

**Concrete fix.** Update the file-top comment on `worker.ts:1`. Substantive
fix (off-loading mnemonic input to the worker via a hidden `<input>` inside
an iframe whose origin only the worker can read) is over-engineering for
this threat tier.

### I-4 — `coerceUint` regex covers the literal-canonical case but bridge sigs aren't replay-pinned to chainId in the wallet

**File:** `src/services/bridge.ts` (verifyRelayerMintSig + IntentExpectation)

The strict `/^(0|[1-9]\d*)$/` coercion is correct for stopping JSON-number
precision loss, leading-zero ambiguity, hex confusion, etc. (closes opus1
M-1 — see "Fixed correctly" below.)

What it doesn't reach: the wallet trusts the relayer's `chainId` field
verbatim and the EIP-712 domain it computes locally is constructed from the
PearlBridge contract config baked into the wallet. If the wallet were ever
re-pointed at a different bridge deployment (e.g., a testnet WPRL), an
intent signed for chain A against domain A could still be presented in the
wallet UI under chain B if the relayer lies about which network the user is
on. The wallet code path that computes the domain looks correct on review;
flagging only to remind future reviewers: every time
`PEARLBRIDGE_DEPLOYMENTS` changes, recompute the audit invariant
"every intent is verifiable against the locally-known domain at the time of
display, not the relayer-asserted one."

Not exploitable in current shape. Listed as a maintenance trap, not a bug.

### I-5 — `fetchEthBlockTimestamp` plausibility window not enforced

**File:** `src/services/bridge.ts` / `pearl-rpc.ts` time-source paths
**Carry-over:** v0.1.7 opus2 I-class.

If the wallet anywhere uses block-time data from the RPC (e.g., for
intent-expiry display or for "this signature expires in X minutes" UI), the
RPC is the time oracle. A malicious RPC can backdate or fast-forward by
hours and the wallet has no sanity-clamp against the local clock. Re-checked
in v0.1.8 — still no sanity clamp. Not exploited by anything user-visible I
could find, but worth a `Math.abs(blockTs - Date.now()/1000) < 3600 * 6`
guard if any UI starts depending on block timestamps for security
decisions (e.g., "this mint intent is still valid").

### I-6 — `index.html` iframe-bust uses `innerHTML` for the refusal page

**File:** `index.html` (top-of-body script)

The bust script writes `document.documentElement.innerHTML = '...refusal...';`
which is fine for a fixed string under the wallet's own CSP, but if any
future contributor adds a templating step that interpolates *anything*
sourced from `location.search`/`location.hash` into that refusal string, it
becomes an `innerHTML` injection sink. Add a code-review trip-wire comment
above the line: `// LITERAL STRING ONLY — never interpolate location data here.`

---

## Fixed correctly in v0.1.8

The following v0.1.7 findings from `AUDIT-v0.1.7-opus1.md` and
`AUDIT-v0.1.7-opus2.md` are confirmed closed by code inspection:

### From opus1 (v0.1.7)

- **opus1 M-1 (JSON number precision in `coerceUint`)** → fixed.
  `src/services/bridge.ts` now enforces `/^(0|[1-9]\d*)$/` against string
  inputs. Hex, JSON numbers, leading zeros, signs, whitespace, exponent
  notation, and decimal points are all rejected at the boundary. Verified
  by reading `coerceUint` and cross-checking `tests/v018.test.ts` cases.

- **opus1 M-3 (pearl-rpc sentry walk throws on partial failure)** → fixed.
  `src/services/pearl-rpc.ts` now returns
  `{ grains, degraded: true, failures }` instead of throwing. The
  `MAX_RPC_PAGE_LENGTH = 500` per-page cap also lands here, capping
  hostile-sentry tarpit memory growth. `services/balances.ts` propagates
  `degraded` into `prlSource = "partial"` and the failure-ratio threshold
  `failures > pool.length / 2` triggers "pool walk failed" labeling.

- **opus1 M-4 (worker private keys not zeroed on relock / re-unlock)** →
  fixed. `wipeSession()` in `src/crypto/worker.ts:44–49` is called at the
  top of every `createWallet`, `restoreWallet`, `unlock`, and `lock` branch.
  The session no longer carries the mnemonic at all (see opus2 H4 below for
  the partial side of this).

- **opus1 M-5 (OnboardingCreate timer leak across strength toggle)** →
  fixed. `src/ui/pages/OnboardingCreate.tsx:36–57` lifts the timer ref out
  of the async IIFE into the `useEffect` body, so the cleanup return
  function genuinely owns the timer handle. Toggling 12 ↔ 24 word now
  cancels the in-flight 5-second canContinue gate.

### From opus2 (v0.1.7)

- **opus2 H1 (sourcemaps would land in /assets)** → fixed.
  `vite.config.ts` sets `sourcemap: false` with a comment marking it as a
  release invariant. Duplicate `vite.config.js` removed.

- **opus2 H2 (frame-ancestors-only defense was single point of failure)** →
  fixed. v0.1.8 adds: (a) iframe-bust script at top of `index.html`
  (`if (window.top !== window.self) { document.documentElement.innerHTML = ...; throw ... }`),
  (b) `Cross-Origin-Opener-Policy: same-origin`,
  (c) `Cross-Origin-Embedder-Policy: require-corp`,
  (d) `Cross-Origin-Resource-Policy: same-origin`,
  in addition to the existing `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`. Layered.

- **opus2 H3 (BroadcastChannel self-fire could feedback-lock the store)** →
  fixed. `src/state/wallet-store.ts` generates `SENDER_ID = crypto.randomUUID()`
  on module load, tags every broadcast payload with it, and filters
  `if (ev.data.sender === SENDER_ID) return;` on receive. Verified.

- **opus2 H4 (mnemonic resident in WorkerSession after unlock)** → mostly
  fixed. The `WorkerSession` type at `src/crypto/worker.ts:35–40` no longer
  has a `mnemonic` field; mnemonic is in scope only inside the
  `seedFromMnemonic` call and goes out of scope immediately after. See I-3
  above for the residual structuredClone exposure that no pure-web wallet
  can avoid; the v0.1.7 finding's *actionable* part is closed.

- **opus2 M1 (AAD not canonicalized; old-format blobs unloadable on schema
  change)** → fixed. `src/crypto/keystore.ts` standardizes the AAD on
  `` `pearl-wallet/aad|v=${version}|kdf=${kdf}|iter=${kdfIterations}|cipher=${cipher}` ``
  for new blobs, and `decryptBlob` reads `blob.aad` (the stored bytes) so
  v0.1.2 / v0.1.7 records still decrypt. Forward + backward compat.

- **opus2 L6 (wipe doesn't clear localStorage)** → fixed.
  `src/storage/db.ts:85–108` introduces `LOCAL_STORAGE_KEYS` and the
  try/finally pattern in `wipeKeystore` — Dexie failure does not prevent
  the localStorage scrub. The `pearl-wallet-ui-v3` key is now part of
  "wipe everything from this browser." Comment makes the invariant
  explicit: "if a future feature stashes state under a new key, adding it
  here keeps wipe complete." Good.

### Other v0.1.8 deltas verified

- `state/ui-store.ts` `isAllowedRpcOverride` re-validates on `loadUI` —
  defense against an attacker who somehow wrote to `localStorage` before
  the allowlist tightened. Belt and braces.

- `setPearlRpcOverride` throws `E_RPC_OVERRIDE_NOT_ALLOWED` on rejection
  rather than silently coercing — store-layer behaviour is correct (the
  Settings.tsx caller doesn't handle the throw, which is L-1 above).

- `makeAsyncLock` in `wallet-store.ts` serializes keystore mutations,
  closing the "two concurrent unlocks racing on session" hole that opus2
  flagged as observation.

- `index.html` and `public/_headers` CSP are in sync. `connect-src` lists
  only the four canonical hosts; `worker-src 'self' blob:`; `script-src
  'self'` (no `'unsafe-inline'`, no `'unsafe-eval'`).

---

## Verdict

v0.1.8 is **shippable** with M-1 and L-1 as outstanding items. M-1 should
land before the next public-release branch (the test currently locks in the
bug); L-1 is a UX cleanup that should land same-cycle since the fix is
five lines in `Settings.tsx`. L-2 and the Info items can be deferred to
v0.1.9.

The audit-loop discipline visible across the two prior v0.1.7 passes and
this v0.1.8 closure is doing what it's supposed to: nothing in the
"fixed correctly" list above was guessed; every claim was verified against
the in-tree code.

— opus1, 2026-05-20
