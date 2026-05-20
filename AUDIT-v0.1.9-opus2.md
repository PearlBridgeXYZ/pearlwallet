# AUDIT — Pearl Web Wallet v0.1.9 (opus2, independent second pass)

**Commit:** 6935c6e ("v0.1.9: send PRL + WPRL + ETH live; v0.1.8 audit hardening")

**Scope.** Independent second-pass audit of v0.1.9. Focus areas, deliberately
divergent from a classic line-by-line pass: worker isolation boundary,
process memory hygiene, derivation correctness, send-flow race conditions,
preview-vs-signed-tx drift, error swallowing, lock-screen edge cases,
build-vs-runtime constants, CSP / iframe-bust gaps, test-coverage gaps.

**Method.** Read-only. No code modified. Mainnet-only threat model (the
wallet has no testnet HRP). Adversary classes considered: hostile sentry
RPC, hostile Ethereum RPC, hostile DOM neighbor (XSS / extension /
bookmarklet), hostile mirror (non-CF host), shoulder-surfer with brief
device access, network MITM between user and relay.

**Severity bar.** *Critical* = direct loss of funds with no user mistake.
*High* = loss of funds requires a plausible user mistake or attacker
foothold; or a stated security claim is structurally false. *Medium* =
defense weakened, user-visible invariant broken, recoverable footgun.
*Low* = hygiene / DoS / UX cliff. *Info* = no bug, design observation.

---

## SUMMARY

| Sev      | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 2     |
| Medium   | 5     |
| Low      | 4     |
| Info     | 3     |
| **Total**| **14**|

| ID         | Sev   | Title                                                                       | Location                                |
| ---------- | ----- | --------------------------------------------------------------------------- | --------------------------------------- |
| O2-H-1     | High  | Preview → broadcast re-quote: user signs a tx they never saw                | src/ui/pages/Send{ETH,WPRL,PRL}.tsx     |
| O2-H-2     | High  | `signPearlTx` does not bind destination HRP to "prl" — defense-in-depth gap | src/crypto/worker.ts:410, 442–449       |
| O2-M-1     | Med   | ETH `pk` hex string lives on worker heap, can never be zeroed               | src/crypto/worker.ts:363                |
| O2-M-2     | Med   | Plaintext mnemonic crosses worker→main boundary at create/restore/export   | src/crypto/worker.ts:272, 292, 336      |
| O2-M-3     | Med   | Same-tab double-broadcast (rapid Send click) races UTXO selection          | src/services/pearl-tx.ts:152, SendPRL.tsx:86 |
| O2-M-4     | Med   | ETH nonce sourced from one RPC "pending" view; no in-flight de-dup         | src/services/eth-tx.ts:135, 168         |
| O2-M-5     | Med   | Pearl receive pool serialized walk × 20 means ~6s preview latency          | src/services/pearl-tx.ts:64–86          |
| O2-L-1     | Low   | `iframe-bust.js` has no `noscript`/extension fallback                       | index.html, public/iframe-bust.js       |
| O2-L-2     | Low   | `monotonicNow()` fallback latch is module-global, shared across all timers | src/lib/monotonic.ts:18–32              |
| O2-L-3     | Low   | Worker session not wiped on a wallet OnError during `signEthTx`/`signPearlTx` | src/crypto/worker.ts:464–491          |
| O2-L-4     | Low   | `tipAddressFor` is build-time constant; no runtime sanity check            | src/chains/pearl/tip.ts:15              |
| O2-I-1     | Info  | `tx-simulation` test coverage gap: no dual-tab send, no UI drift assertion | tests/v019.test.ts                      |
| O2-I-2     | Info  | UI shows truncated address only on Dashboard; full address only on Send confirm | src/ui/pages/Dashboard.tsx:100, SendPRL.tsx:146 |
| O2-I-3     | Info  | `lastActivity` is in store; not gated by `status === "unlocked"` in test paths | src/state/wallet-store.ts:428         |

---

## High

### O2-H-1 — Preview shows fee/gas/UTXOs from query Q1; broadcast() re-estimates and signs Q2 (silent drift)

**Files.**
- `src/ui/pages/SendETH.tsx:47-74` (`previewQ.queryFn` builds the displayed numbers)
- `src/ui/pages/SendETH.tsx:95-119` (`broadcast()` calls `sendNative` which re-quotes from scratch)
- `src/services/eth-tx.ts:131-153` (`sendNative` re-fetches nonce + gas + fees inside the signing call)
- `src/ui/pages/SendWPRL.tsx:49-68` and `86-114` — same pattern for WPRL
- `src/ui/pages/SendPRL.tsx:49-68` and `86-113` — same pattern for PRL; `composePearlSend` is called a second time inside `sendPearl`

**Finding.** On every Send page the preview pane runs a React Query that
computes the displayed numbers (gas, fee, worst-case wei, fee/change/UTXO
count). When the user clicks **Send**, the broadcast handler does NOT
re-use the preview's composed numbers. Instead:

- `sendNative` (eth-tx.ts:131) re-fetches `nonce`, `estimateNativeGas`,
  and `suggestGas` and builds a fresh `EthTxRequest`.
- `sendWprl` (eth-tx.ts:155) does the same.
- `sendPearl` (pearl-tx.ts:152) re-walks the entire UTXO pool via
  `composePearlSend` — so destination + amount stay constant but UTXO set,
  fee estimate, change amount, and tip can drift.

The signed transaction is therefore **whatever the network looks like
between the second `Promise.all` resolving** — not what was on screen.
There is no upper-bound cap, no "did the numbers change by more than ε,
reconfirm" guard, no diff display.

**Exploitation.**

1. *Hostile sentry RPC (Pearl path).* A sentry that returns a slightly
   different UTXO set on the second walk can cause the user to sign a tx
   spending **more inputs**, paying **higher absolute fee** (because fee
   scales with input count at 58 vB each × tier sat/vB), or producing a
   change output to a different `pool[0]` address than expected. The
   preview pane already "looked fine"; the user has no way to spot that
   the broadcast diverged.
2. *Hostile mirror with rate-limit/inject ability.* An RPC fronted with a
   cache-poisoning layer can serve "preview" responses with low gas and
   "broadcast" responses with much higher gas. Worst-case wei the user
   sees = `21000 × X` gwei; worst-case wei they actually sign =
   `21000 × 10X` gwei.
3. *Base-fee jump (organic).* Mainnet base fee can 2× across two adjacent
   blocks. The user sees `0.001 ETH worst-case` in preview, signs
   `0.004 ETH worst-case` 800ms later when broadcast resolves — they
   never see this number.

**Impact.** Violates the security claim "the user sees exactly what they
sign". Realistic loss bounded by base-fee volatility for ETH/WPRL
(low-to-medium $); unbounded in principle on PRL if a hostile sentry
adds a bogus large UTXO to the second walk's response (composer would
greedily pick it, then the worker signs a tx spending it, and the chain
rejects — only a DoS — UNLESS the sentry also has a way to influence
broadcast). Pearl L1 also has no per-tx fee ceiling exposed to the user.

**Recommended fix.** Two clean options, pick one:

1. **Sign-what-you-saw.** Pass the composed preview object straight into
   `broadcast()` and have `sendNative` / `sendWprl` / `sendPearl` accept
   a pre-composed object instead of re-quoting. Add a `freshnessTtlMs`
   (e.g. 30s); if the preview is older than that on click, refuse to
   sign and force a fresh preview. Eth-tx already has `composed: EthTxRequest`
   on the return value — the same shape can be the *input*.
2. **Diff-and-reconfirm.** Re-compose inside `broadcast()` (the current
   behavior), diff against the preview, and if any of {feeGrains,
   worstCaseWei, utxos.length, change.address, change.amount} changed by
   more than a tolerance, return to the preview stage with a banner
   "fee changed: was X, now Y — confirm again". Sign nothing without
   the user re-clicking.

Option 1 is structurally safer (the user really did sign what they saw)
and is the standard pattern for non-custodial wallets.

---

### O2-H-2 — Worker `signPearlTx` does not bind the output HRP to "prl"; `pubKeyHash: 0x00` accepts Bitcoin mainnet legacy addresses

**File.** `src/crypto/worker.ts:410-449`

```ts
const network = { bech32: params.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
// ...
tx.addOutputAddress(o.address, amt, network);
```

**Finding.** The worker's `signPearlTx` constructs a `network` object
that sets `bech32: params.hrp` (= `"prl"`) but leaves `pubKeyHash: 0x00`
and `scriptHash: 0x05` — these are **Bitcoin mainnet's** legacy address
prefixes (`1xxx...` / `3xxx...`).

`@scure/btc-signer`'s `Address(network).decode(address)` first checks
whether the string starts with `${network.bech32}1` — if not, it falls
through to base58check and accepts any address whose first byte equals
`network.pubKeyHash` (0x00) or `network.scriptHash` (0x05). A real
Bitcoin mainnet legacy address (e.g. `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`)
therefore *decodes successfully* and is accepted as a Pearl tx output
script.

The UI gate (`validPearl` in `src/lib/validate.ts:5` → bech32m+HRP
"prl") catches this on the SendPRL form, so the live exploit requires
bypassing the UI. But:

- The worker is documented as the **sole** boundary that key material
  crosses (`// All key material lives here. Main thread never sees raw keys.`).
  Defense-in-depth at that boundary is the entire point.
- A future programmatic caller (a "send max" helper, a Bridge flow that
  reuses `signPearlTx`, an automation hook) that forgets the UI gate
  hands the user a legacy-Bitcoin-format output and the worker signs it.
- A XSS or extension that can inject into the wallet store (not the
  worker — the worker is isolated) can set the destination directly via
  `useWallet.getState()` mutations or intercept the postMessage payload
  before it reaches the worker. The worker would not catch it.

**Impact.** The worker can sign a Pearl tx with an output to a non-Pearl
address. If broadcast lands, the funds go to a P2PKH/P2SH output that
*no Pearl wallet can spend* (Pearl is taproot-only on btcd; the address
codec the chain understands is bech32m+prl). Funds permanently lost.

This is also the kind of mistake an honest user can make if they paste
a Bitcoin address from a clipboard manager that mangled the prefix.

**Recommended fix.**

```ts
// Reject any base58 output prefix on the Pearl signing path. Pearl is
// taproot-only — the legitimate output is *always* bech32m with HRP "prl".
const network = {
  bech32: params.hrp,
  // Use a sentinel that base58check can never match (>= 0xfe is unused
  // by every mainnet/testnet Bitcoin variant).
  pubKeyHash: 0xff,
  scriptHash: 0xff,
  wif: 0xff,
};
// And before addOutputAddress:
for (const o of r.outputs) {
  if (!o.address.toLowerCase().startsWith(`${params.hrp}1`)) {
    throw new Error("E_PEARL_OUTPUT_HRP");
  }
  // ... existing shape check ...
  tx.addOutputAddress(o.address, amt, network);
}
```

The HRP startsWith check is a defense-in-depth assertion; the
`pubKeyHash: 0xff` rejects the base58 path inside `@scure/btc-signer`
because a real Pearl address would never have a leading 0xff byte after
base58check decode (and Pearl chain itself doesn't accept these outputs
anyway, but we want the wallet to refuse to *sign*, not let the chain
deal with it).

---

## Medium

### O2-M-1 — ETH private key hex string sits on worker heap; can never be zeroed

**File.** `src/crypto/worker.ts:363`

```ts
const pk = ("0x" + bytesToHex(session.ethPrivKey)) as `0x${string}`;
// ... passed to viem ...
const raw = await ethSignTransaction({ privateKey: pk, ... });
return { raw };
```

**Finding.** `bytesToHex(session.ethPrivKey)` constructs a 64-char hex
string of the private key. `session.ethPrivKey.fill(0)` only zeroes the
*byte array*; the hex string `pk` is an **immutable** JS string and
remains in V8's heap until GC. Even after GC, the string may have been
copied internally by V8 string interning, by viem's call into noble
curves, and by structured-clone if anything later serializes it.

`wipeSession()` (worker.ts:46-51) only fills the Uint8Array. The hex
string survives.

**Impact.** A worker heap dump (DevTools, crash reporter, OS memory
forensics, browser-extension with debug perms) recovers the ETH private
key after the user "locked" their wallet. The same applies to the
mnemonic that flows through `JSON.stringify({ mnemonic })` /
`TextDecoder().decode(plaintext)` (also immutable strings).

JavaScript fundamentally can't zero immutable strings — but the wallet
*can* avoid creating them. The signing helper in viem has a path that
accepts raw bytes; bypassing the hex conversion would close this.

**Recommended fix.**
- viem's `signTransaction` accepts `privateKey: Hex` and viem's
  `privateKeyToAccount` accepts `Hex | ByteArray`. Check whether
  `signTransaction({ ... privateKey: hex })` can be replaced by a
  direct call into `@noble/curves/secp256k1.sign` + RLP-encode + EIP-1559
  serialization that we already do for Pearl. Cost: more code in the
  worker. Benefit: never builds the hex pk.
- If that's too much surgery, at minimum:
  - Construct `pk` inside a try/finally so it's the *last* reference
    holding the hex string before the function returns — V8 has more
    chance to GC it.
  - Document this limitation in `worker.ts` so future contributors don't
    add additional hex copies (e.g. via `console.log` while debugging).

This is *Medium* not *High* because (a) the attack requires existing
heap-read capability — anyone with that already owns the user, and
(b) the bytes are zeroed, so the unprotected surface is JS string
copies, not the canonical key store. Worth fixing because v0.1.5
spelled out "key material stays in worker" as a design pillar.

---

### O2-M-2 — Plaintext mnemonic deliberately crosses worker → main thread on create / restore / export

**File.** `src/crypto/worker.ts:272-279` (`createWallet`), `:292-299` (`restoreWallet`), `:330-337` (`exportMnemonic`)

```ts
const out: CreatedWallet = {
  mnemonic,    // ← postMessage carries the raw mnemonic
  blob: blobToJSON(blob),
  addresses: { pearl: pool[0]!, pearlPool: pool, eth },
};
return out;
```

**Finding.** The Worker → Main `postMessage` for `createWallet`,
`restoreWallet`, and `exportMnemonic` returns the **plaintext mnemonic**
to the main thread, which then renders it in React (OnboardingCreate /
Settings).

This is documented and intentional — the user needs to see the phrase
to write it down. But the threat model claim "*src/crypto/worker.ts —
sole place keys ever touch*" is, strictly, false. The mnemonic transits
the main thread on three flows; from there it is in React state, in any
component the parent passes it to, in any browser-tab snapshot, in any
DevTools-React-DevTools tree, in any synchronous extension content
script that wraps `postMessage`.

The Settings `exportMnemonic` has a 60s auto-hide + visibility-hide; the
Onboarding flow does not have an explicit auto-clear path.

**Impact.** A malicious browser extension with content-script access to
`pearlwallet.xyz` can intercept the mnemonic on the structured-clone
boundary. CSP doesn't constrain extensions. The wallet should treat the
*postMessage payload* as part of its public surface and either:

- Not return the mnemonic to the main thread at all in
  `createWallet` / `restoreWallet`. Instead, store it in a worker-local
  "export pending" slot keyed by a one-shot nonce. The main thread asks
  the worker to *render* it into a single offscreen `<textarea>` via a
  trusted DOM-write helper, and clears immediately.
- Or, document the boundary honestly: "the mnemonic crosses the worker
  boundary in plaintext during onboarding and export — this is the only
  time keys leave the worker; install no extensions you do not trust".

The second option is what most wallets do. The first option is what
hardware wallets do.

**Recommended fix.**

1. Audit the README + UI to ensure the mnemonic-export boundary is
   stated clearly (it currently says "your keys never leave this browser",
   which is true but not granular).
2. In `OnboardingCreate`, wire the same 60s auto-hide + visibility-hide
   that Settings has. The mnemonic is currently shown indefinitely on
   that page until the user clicks "I wrote it down".
3. Consider: after the user confirms they wrote it down, send a
   `cryptoWorker.call("dropMnemonicCopy")` that explicitly nulls any
   string reference the worker is still holding (currently it isn't —
   the worker drops the local `mnemonic` reference on every return — but
   make this provable and tested).

---

### O2-M-3 — Rapid Send click → double-broadcast race; same UTXOs picked twice client-side, two txids returned (one accepted, one rejected)

**Files.**
- `src/ui/pages/SendPRL.tsx:86-113` (`broadcast`)
- `src/services/pearl-tx.ts:152-171` (`sendPearl`)

**Finding.** `SendPRL.tsx` guards the Send button with `disabled={sending}`,
which prevents a single React render from firing twice. But:

- The user can click in the **<16ms before the next render** committing
  `setSending(true)`. In practice browsers debounce double-clicks
  variably; on a slow device the click handler can fire twice before
  React flushes the disabled state.
- More importantly, **two tabs** of the same wallet (multi-tab is a
  documented feature — see `BroadcastChannel` wiring in wallet-store.ts)
  do not coordinate sends. Each tab independently composes a tx,
  selects the same largest UTXO, signs, and broadcasts. The first to
  hit the sentry wins; the second tx is rejected as a double-spend by
  the mempool — but the *signed-and-broadcast* artifact has leaked to
  the network in plaintext, including the user's Taproot signature, and
  the user sees an unexplained "Broadcast failed" instead of "this is
  a duplicate of the tx you already sent".

ETH is structurally protected by the nonce — the second send shares the
same `nonce` ("pending" tag) and the mempool rejects it. But viem on
some RPCs replaces the pending tx if `maxFee` is higher, which would
cause the second send to *replace* the first — fine if the user wanted
that, surprising if they thought they were sending two distinct
transactions.

**Impact.**
- Loss: small — both Pearl txs spend the same UTXO so only one
  succeeds. No double-spend on chain.
- Privacy / UX: bad. Hostile sentry sees two signed txs spending the
  same input → can fingerprint the wallet's behavior.
- Operator confusion: the user might believe their second Send was
  rejected for an unrelated reason and resend a third time.

**Recommended fix.**
- In `wallet-store.ts`, add a module-scope `sendInflight` map keyed by
  (chain, from, destination, amount). The Send button refuses to
  initiate if a matching entry exists. Clear on broadcast success OR
  fail.
- Broadcast the "send started" event over the same `BroadcastChannel`
  used for keystore sync (separate channel name for tx-events). Other
  tabs subscribe and grey out their own Send button for the matching
  parameters until the event clears.
- A simpler, partial fix: use `useRef` instead of `useState` for the
  `sending` flag so the disable is synchronous on the first click.

---

### O2-M-4 — ETH `getTransactionCount({blockTag:"pending"})` is non-authoritative; no in-flight nonce de-dup

**Files.**
- `src/services/eth-tx.ts:135` (sendNative)
- `src/services/eth-tx.ts:168` (sendWprl)

**Finding.** Both ETH send paths read the nonce via
`getTransactionCount({ blockTag: "pending" })` and immediately use that
value for the next tx. This works when:

- The mempool view at the chosen RPC reflects every pending tx for this
  account.
- No other client is concurrently sending from this account.

It breaks when:

- The user runs the wallet across two devices (a desktop + mobile)
  using the same recovery phrase. The desktop's pending tx hasn't
  propagated to the mobile's RPC yet; mobile reads nonce N and signs
  another N → one is rejected (nonce already used) or, on some RPCs,
  one is silently replaced.
- The user previously sent a tx that's still pending and now sends
  again. The RPC's pending view shows N+1, the wallet signs N+1, fine.
  But if the wallet's primary RPC and the fallback RPC disagree about
  pending (publicnode vs drpc — both are in `ETH_RPC_FALLBACK`), the
  signed nonce could mismatch the broadcast RPC's view.

The wallet has no `localStorage` ledger of "txs I just broadcast" to
cross-check. The `txCache` Dexie table (storage/db.ts:44) exists but is
not written by sendNative / sendWprl.

**Impact.** Most users send infrequently and this is a non-issue. A
user on flaky network or with two devices can sign two txs with the
same nonce; one will be lost or replaced. No fund loss (mempool
enforces), but the user can be very confused about which tx made it.

**Recommended fix.**
- After every successful broadcast, write to `db.txCache` with
  `status: "pending"`, `meta.nonce: N`.
- Before composing a new tx, read the latest pending entry; if
  `meta.nonce` equals the RPC's pending nonce, increment by 1 (the RPC
  is behind). If the RPC says N+1 and our cache says N, sign N+1.
- Surface a banner on the Send page: "You have N pending transactions;
  this will be nonce M". Lets the user spot the mismatch.

---

### O2-M-5 — Pearl pool walk is strictly serialized × 20 addresses, blocking preview render for ~6s on a cold load

**File.** `src/services/pearl-tx.ts:64-86` (`listPoolUtxos`)

```ts
for (let i = 0; i < pool.length; i++) {
  if (i > 0) await new Promise((r) => setTimeout(r, 300));
  ...
}
```

**Finding.** `composePearlSend` walks every receive-pool address
(RECEIVE_GAP_LIMIT = 20) **serially** with a 300ms inter-request gap,
each request itself a multi-page `searchrawtransactions` walk. On a
cold preview, that's `20 × (300ms + RPC_RTT)` ≈ 6–10s before the user
sees ANY fee/UTXO/change number.

The comment in `services/balances.ts:42` says the gap is to stay under
the sentry's ~10 req/s burst limit. That's a reasonable concern for
dashboard refreshes (1×/30s background). But for a preview that the
user is actively waiting on with their finger over **Send**, 6+ seconds
of "Walking UTXOs and selecting coins…" is the longest UX wait in the
wallet and the most likely moment for the user to bounce or smash-click.

The smash-click then ties back to **O2-M-3**.

**Impact.** Bad UX. Indirectly raises the probability of double-send
races. Not a fund-loss path on its own.

**Recommended fix.**
- Parallelize the walk with a `Promise.all` and a small in-flight
  concurrency cap (say, 4). 20 addresses × ~250ms each = ~1.25s wall
  clock instead of 6s.
- Cache the UTXO walk in `react-query` with the same 30s TTL the
  dashboard already uses — preview composition then reuses the cached
  utxo list 95% of the time instead of re-walking.
- Lower-bound the gap by tracking the actual previous-request timestamp
  (a token bucket), not a blind sleep.

---

## Low

### O2-L-1 — `iframe-bust.js` has no `noscript` fallback and no script-blocking-extension defense

**Files.** `index.html:42`, `public/iframe-bust.js`

**Finding.** The v0.1.8 audit Opus2 H-1 moved iframe-bust into an
external script to dodge the wallet's own CSP. That fix is correct.
But:

1. If a user has `noscript`, uBlock-with-aggressive-rules, or any
   extension that blocks `/iframe-bust.js`, the bust never runs. The
   page renders inside an attacker's iframe overlay despite the
   wallet's intent. The `<noscript>` block in `index.html:44-48`
   correctly tells the user "PearlWallet needs JS" — but only when JS
   itself is off, not when one file is blocked.
2. `script-src 'self'` requires `iframe-bust.js` to load from the same
   origin. If the wallet is mirrored at a 4xx-edge that fails on
   `/iframe-bust.js` (typo in the static-server config, malformed S3
   bucket, IPFS gateway that doesn't serve `.js` MIME), the rest of
   the page still loads because `/src/main.tsx` is a separate request.
   The wallet boots into an iframe successfully.

**Impact.** Low — it's a third-order failure mode. The fix is cheap.

**Recommended fix.**
- Add a parallel inline check in `main.tsx` (before any React mount)
  that performs the same `window.top !== window.self` test and either
  throws or redirects. As a module loaded under `'self'`, it satisfies
  CSP. The external `iframe-bust.js` becomes belt; the inline check
  becomes braces. Note that having BOTH is fine — they're idempotent.

---

### O2-L-2 — `monotonicNow()` fallback latch is module-global; max() across all timers can stall lock timers

**File.** `src/lib/monotonic.ts:18-32`

```ts
let monotonicFallbackHigh = 0;

export function monotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  const now = Date.now();
  if (now > monotonicFallbackHigh) monotonicFallbackHigh = now;
  return monotonicFallbackHigh;
}
```

**Finding.** The fallback branch (no `performance.now`) latches a
module-global to the highest `Date.now()` we've ever seen, and returns
that. The comment correctly notes that a backward clock step keeps the
returned value high so the lock fires no-later-than-expected.

But there's an edge case the comment doesn't cover: if any code path
(or a misbehaving test) ever calls `monotonicNow()` with the wall clock
set to a far-future date (e.g. `Date.now() = 2100`), the latch is
permanently set to that timestamp. Every subsequent call returns that
value. `since = monotonicNow() - lastActivity` is then always ~0
(because lastActivity is also latched to the same value on the next
`touch()`). The auto-lock effectively *never* fires once a far-future
timestamp poisons the latch.

In production this requires the user's OS clock to ever be wildly
ahead, then return to normal. Plausible on a phone that pulled an NTP
update mid-flight, on a VM that was paused and resumed across years,
on a deliberately set clock (some users do this for time-based DRM
bypasses).

**Impact.** Low — every modern browser has `performance.now`; the
fallback path is for IE / very old Safari / Node test runners. But the
comment ("worst case: user locks slightly late once") understates the
worst case.

**Recommended fix.**

- Bound the fallback to "highest seen, but only within +30s of the
  current `Date.now()`". If the latch is more than 30s ahead of the
  current wall clock, treat it as poisoned and reset.
- Alternatively, drop the fallback entirely. Every supported runtime
  has `performance.now`. If `performance.now` is genuinely absent,
  refuse to operate and surface "WebCrypto/performance unavailable —
  refusing to operate" (matching the keystore.ts pattern at line 46).
  Auto-lock is a security-critical control; defaulting to a fragile
  fallback isn't worth it.

---

### O2-L-3 — Worker `onmessage` catch block does not wipe session on signing error

**File.** `src/crypto/worker.ts:464-491`

**Finding.** When `signEthTx` or `signPearlTx` throws (e.g. shape
validation fails, bigint coercion fails), the worker catches and
returns `{ ok: false, error }`. The session — which contains the
private keys — is left intact.

This is *correct* for most errors (the user just typed a bad address
and we want them to retry without re-unlocking). But it's wrong for
the class of errors that imply the session itself is suspect:
`E_TX_BIGINT` (the caller serialized a non-numeric where a bigint
should be), `E_TX_SHAPE`, `E_PEARL_UTXO_SHAPE`. These shapes are
validated at the boundary; they only fail if the *main thread sent
malformed data*, which itself implies main-thread tampering.

A defense-in-depth response would be: on shape-validation failure, wipe
the session and require re-unlock. Currently the attacker who got the
main thread to send malformed payloads can keep firing until they find
one that *does* pass shape validation (or just trigger a real send).

**Impact.** Low — the attacker would need main-thread injection
(extension, XSS), which is already game-over. But the worker's job is
to be the last line; failing closed on suspicious input is cheap.

**Recommended fix.**

```ts
self.onmessage = async (ev) => {
  ...
  try {
    const result = await handle(msg);
    ...
  } catch (err) {
    // Shape-violation errors imply main-thread compromise. Wipe the
    // session as a precaution — the user can re-unlock.
    if (err instanceof Error && /^E_(TX|PEARL)_(SHAPE|BIGINT|RANGE|UTXO_)/.test(err.message)) {
      wipeSession();
    }
    ...
  }
};
```

---

### O2-L-4 — `tipAddressFor` is a hard-coded build-time constant; no runtime sanity check

**File.** `src/chains/pearl/tip.ts:15`

```ts
export const TIP_ADDRESS_MAINNET =
  "prl1ptzrunj28tua9uklxa3ses9nsl7g22s2qx2fdu9gf7wgvup58s94q9ldnxh";
```

**Finding.** The tip address is baked in at build time. A compromised
build pipeline (CI cache poison, dependency-confusion attack on a build
tool, malicious branch merged with an unreviewed string change) can
substitute the tip address. The user sees the tip output on the
preview, but the address is rendered in `<span class="font-mono">{tipAddressFor(...)}</span>`
which most users won't sanity-check character-by-character.

Tip is bounded at `max(10 bps, 1 PRL)` per tx; loss is bounded but
non-zero across thousands of transactions.

**Recommended fix.**
- Cross-check against the published team address via a build-time
  check (a separate file in `reference/` that lists the expected
  address; a CI gate that diffs them).
- At runtime, add an `isValidPearlAddress` assertion on the constant
  itself at module load — a string corruption (mistype in source)
  would crash loudly rather than silently sending tips to an invalid
  address (which would burn the tip to a coinbase reject anyway).

---

## Info

### O2-I-1 — Test coverage gaps: no multi-tab / drift simulation; no UI-vs-signed-tx assertion

**File.** `tests/v019.test.ts`

The new v0.1.9 test file covers:
- composePearlSend coin selection (single UTXO, pool aggregation,
  largest-first, dust collapse, degraded propagation, insufficient
  funds, no UTXOs).
- evaluateGasCoverage boolean correctness.
- monotonicNow non-decreasing.
- iframe-bust file existence and absence of `innerHTML`.
- pearlParams allowlist re-validation.
- passphrase degenerate-entropy rejection.

It does **not** cover, in order of decreasing audit value:

1. Preview-vs-broadcast drift (O2-H-1). Easy to write: mock
   `fetchPrlUtxos` so the first call returns a 1-UTXO set and the
   second call returns a 5-UTXO set. Assert the user sees the first
   one's fee/count and the broadcast either uses the first one or
   surfaces a re-confirm.
2. HRP rejection on the worker boundary (O2-H-2). The worker is
   exercised in `tx-simulation.test.ts` already — add a Bitcoin
   legacy address output and assert it throws.
3. Double-broadcast race (O2-M-3). Simulate two parallel `sendPearl`
   calls and assert exactly one succeeds, or both surface a clean
   "duplicate send" error.
4. monotonicNow fallback latch poisoning (O2-L-2). Set Date.now
   high, then low, assert that subsequent calls behave correctly.
5. Worker shape-violation wipe (O2-L-3). After post-message-ing a
   malformed payload, assert subsequent `unlock`-required ops fail
   until re-unlock.

---

### O2-I-2 — Display asymmetry: Dashboard shows truncated addresses; Send Confirm shows full but only for *destination*

**Files.** `src/ui/pages/Dashboard.tsx:100`, `src/ui/pages/SendPRL.tsx:146`

**Observation.** The Dashboard shows `shortAddr(addresses.pearl, 12, 8)`
— a truncated form. The Send Confirm shows the destination address in
full (good). But it does NOT show:

- The *change-output* address (i.e. which of the user's own receive
  addresses change is going to — currently always pool[0], but the user
  can't see that on the Confirm pane).
- The *tip output* address — actually this one IS shown
  (SendPRL.tsx:218-220) as `tipAddressFor(pearlNetwork)`.
- The *sending* address (which pool member the input came from) — for
  PRL with multiple inputs across pool indexes, the Confirm collapses
  to "Inputs: N UTXOs" without listing the source addresses.

This is fine for casual use but a sophisticated phishing scenario could
substitute the change address (via XSS — already game-over) and the
user would not notice on the Confirm pane.

**Not actionable as a fix** without more product input — listing 20
pool addresses on the Confirm pane would itself be a UX disaster.
Recommendation for the next pass: at minimum show the change address
in the Confirm dl. It's one line and it closes a phishing window.

---

### O2-I-3 — `lastActivity` field on the store can be touched without status guard

**File.** `src/state/wallet-store.ts:427-429`

```ts
touch() {
  set({ lastActivity: monotonicNow() });
},
```

**Observation.** `touch()` is exposed publicly on the store. Any
caller — including a future feature or a hostile main-thread script —
can call `useWallet.getState().touch()` and reset the auto-lock window
to "now".

The activity-tracking effect in `App.tsx:54-84` only calls touch on
real user input (pointer, key, focus). But the function is the same
function any other module can call. There's no `if (status ===
"unlocked") return` inside `touch()` either, so a `touch()` while
locked silently updates the meter.

**Impact.** None today — there's no other caller. Worth noting because
a future contributor adding background activity (e.g. "ping the sentry
every 60s") might call `touch()` to bump the lock window, defeating
the whole purpose of the auto-lock.

**Not a bug. Document or defensively gate.**

---

## Out of scope / not findings

- **AAD downgrade.** Reviewed; `computeAAD` binds version + KDF + iter
  + cipher in a deterministic pipe-delimited string. Sound for v1.
- **PBKDF2 600k iter.** Standard floor; meets OWASP-2024 guidance.
- **Bech32m HRP "prl" decode.** The codec is `@scure/base`; review of
  HRP/version/length checks in `decodeTaprootAddress` is clean.
- **BIP-86 derivation paths.** `m/86'/808276'/0'/0/i` for Pearl,
  `m/44'/60'/0'/0/0` for ETH. Both match documented expected paths;
  cross-tested against oyster (per the comment in hd.ts:8).
- **CSP `connect-src` allowlist.** Tight, matches the wallet's actual
  RPC needs.
- **Lock screen and visibility-change handlers.** The App.tsx logic
  uses `monotonicNow()` consistently; visibility wake correctly
  triggers a lock-check-then-bump (not bump-then-check), which is what
  the v0.1.6 audit asked for.
- **`exportMnemonic` password gate.** Correctly requires both the
  blob (cipher-on-disk) and the password (KDF input). Cannot be
  trivially exported by an XSS that only has main-thread access — the
  attacker would need to also exfiltrate the password.

---

## End of audit
