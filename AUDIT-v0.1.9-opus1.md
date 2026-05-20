# Pearl Web Wallet v0.1.9 — Independent Security Audit (Opus pass 1 of 4)

- **Commit:** `6935c6e` (v0.1.9)
- **Scope:** live send paths (PRL UTXO, ETH native, WPRL ERC-20), v0.1.8 audit hardening (iframe-bust externalisation, pearlParams allowlist re-check, monotonic clock, passphrase entropy guard, Settings.saveRpc error catch).
- **Threat model:** hostile sentry RPC, hostile/partially-compromised Ethereum RPC, hostile DOM neighbour on a non-Cloudflare mirror, hostile localStorage contents, shoulder-surfing attacker with brief device access.
- **Out of scope:** smart-contract security (covered by RC5.6 contract audits), supply-chain attacks on @scure/btc-signer or viem, browser-platform vulnerabilities below the JS layer.

---

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 5 |
| Low | 4 |
| Info | 4 |
| **Total** | **15** |

The three live send paths land in good shape. P2TR sighash is amount- and script-bound by BIP-341, which neutralises the worst of the hostile-sentry surface: a sentry can refuse to broadcast, lie about balances, or under-pick coins, but cannot trick the signer into a sig that mints to a wrong destination. The v0.1.8 audit fixes are correctly applied. The remaining issues cluster in three areas: (1) the ETH send path's gas pipeline is exposed to a worst-case-ETH-drain via inflated fee-market reads from the primary RPC, (2) the iframe-bust hardening still has a 404-silent-pass gap on a non-CF mirror, and (3) several worker input-shape checks (vout non-integer, address-format binding, scriptHex-to-key consistency) are weaker than they could be.

---

## H — High

### O1-H-1 — Hostile ETH RPC can inflate gas to drain native ETH balance
- **Location:** `src/services/eth-tx.ts:40-51` (`suggestGas`), `src/services/eth-tx.ts:131-153` (`sendNative`), `src/services/eth-tx.ts:155-187` (`sendWprl`), `src/chains/ethereum/rpc.ts:4-12` (`ethClient`).
- **Description:** `suggestGas` reads `baseFeePerGas` from `client.getBlock({ blockTag: "latest" })` with no sanity ceiling, then computes `maxFeePerGas = baseFee * 2n + priority`. The user-visible "Worst-case gas" line in `SendETH.tsx`/`SendWPRL.tsx` displays whatever ceiling falls out, but the user is unlikely to recognise an inflated number — current mainnet baseFee is typically 1–20 gwei; an attacker who controls (or BGP-hijacks) `ethereum-rpc.publicnode.com` could return `baseFeePerGas: "0xffffffffffffffff"` (or any 18-decimal number short of `2^256`). With ETH's "miner keeps `min(maxFeePerGas, baseFee + priority) * gasUsed`" model, the actual fee paid is capped at the on-chain baseFee — BUT the wallet's own `evaluateGasCoverage` / "covered" check uses `worstCaseWei = gas * maxFeePerGas`, so the send button **disables** unless the user holds an absurd ETH balance. A subtler variant: the attacker returns a baseFee just above the user's balance but plausible (say, 200 gwei when normal is 10), shaping the UI to make the user fund more ETH than needed.
- **Impact:** Denial of service against the WPRL send flow (user with normal ETH cannot send because "covered" returns false). With more sophistication, social-engineering pressure to top up a wallet just before tx submission. No direct theft, but a UX-level coercion vector. Not Critical because viem caps the actual paid fee at on-chain baseFee on settlement; the inflation is only in the wallet's gating logic.
- **Recommended fix:** Sanity-clamp `baseFee` in `suggestGas` against a hard ceiling (e.g. reject anything > 5000 gwei outright with `E_ETH_FEE_MARKET_INSANE`; cap to 5000 gwei). Surface "RPC returned an unreasonable fee market — try again or switch network" instead of silently building an impossible tx. Tier-priority constants are already conservative; the ceiling is the missing piece.
- **Code refs:** `eth-tx.ts:45-50`, `SendWPRL.tsx:60-67`.

### O1-H-2 — `iframe-bust.js` 404 on a non-CF mirror silently disarms the click-jack defence
- **Location:** `index.html:42`, `public/iframe-bust.js`, `public/_headers:2`.
- **Description:** v0.1.8 moved the iframe bust to an external `script-src 'self'`-compatible file (Opus2 H-1 / Minimax2 H-1). Correct fix for the CSP-blocks-inline issue, but the new failure mode is silent: if a non-CF mirror serves the wallet and `/iframe-bust.js` returns 404 (typo, S3 typo'd key, IPFS gateway timeout), the `<script src="/iframe-bust.js"></script>` tag fails without error, `main.tsx` mounts anyway, and the wallet is now framable. `_headers` provides `frame-ancestors 'none'` but only on Cloudflare-served deploys. The `<meta http-equiv="Content-Security-Policy">` in `index.html` cannot set `frame-ancestors` (per spec, ignored from `<meta>`), so it offers no fallback. The current `index.html` CSP does NOT include `frame-ancestors` — there's nothing to catch a non-CF mirror that's missing `iframe-bust.js`.
- **Impact:** Click-jacking of unlock / send-confirm flows on a non-CF mirror where `iframe-bust.js` is mis-deployed. Attacker overlays a fake-deposit UI atop the real one, user signs a real send to attacker's address. Same severity as the original v0.1.7 finding the v0.1.8 fix was trying to address — the fix is incomplete.
- **Recommended fix:** Add an inline JS check immediately after the external `<script>` tag in `index.html` that verifies the bust ran. Easiest: have `iframe-bust.js` set `window.__pearlIframeBustRan = true`; the very next inline `<script>` checks that flag and aborts (`document.body.textContent = "iframe defence missing — refusing to load"`) if absent. The inline script is one tiny statement, fits inside any sane CSP (`script-src 'self' 'unsafe-inline'` already isn't used; tighten by using `script-src 'self' 'sha256-...'` with the inline's hash). Alternative: add a `connect-src` preconnect-style integrity check, or render-block on a fetch of `/iframe-bust.js` confirming 200.
- **Code refs:** `index.html:13-16` (CSP missing `frame-ancestors`), `index.html:42-49`, `public/iframe-bust.js:1-54`.

---

## M — Medium

### O1-M-1 — Concurrent sends collide on the same `pending` nonce, second tx is silently rejected
- **Location:** `src/services/eth-tx.ts:134-138`, `src/services/eth-tx.ts:167-171`.
- **Description:** Both `sendNative` and `sendWprl` read the nonce via `client.getTransactionCount({ ... blockTag: "pending" })`. The wallet has three send pages (PRL/WPRL/ETH) and nothing in the UI prevents the user from opening two send pages in two tabs (or two browser windows) and signing back-to-back before either reaches the mempool. Both reads return the same `pending` value; both txs are signed with identical nonces. The first to land claims the nonce; the second is rejected (`nonce too low`) and the user gets the error string from `broadcastRaw` surfaced as `"Broadcast failed: nonce too low"`. The wallet does no nonce-tracking across calls.
- **Impact:** UX regression and possible accidental double-spend setup: if the user retries the failed second tx, the new nonce reading picks up the latest pending, and the now-signed-but-rejected tx still exists in their local state. With two tabs, a user could believe both succeeded for a few minutes before noticing.
- **Recommended fix:** Track an in-memory "next nonce" per (from, network) and increment after each successful sign+broadcast. On a fresh session, prime from `pending`. On mempool rejection of a signed tx, decrement back. The simpler fix is a UI-level guard: disable Send buttons on all three pages while any send is in-flight (a single "sending" flag in the wallet store). The current per-page `sending` flag only blocks the same page.
- **Code refs:** `eth-tx.ts:134`, `eth-tx.ts:167`, `SendETH.tsx:39` (per-page `sending` state), `SendWPRL.tsx:40`.

### O1-M-2 — Worker accepts non-integer `vout` (1.5, 2**53, etc.) when constructing prev-out reference
- **Location:** `src/crypto/worker.ts:415-426`.
- **Description:** The worker validates `typeof u.vout !== "number" || u.vout < 0`, but does NOT verify `Number.isInteger(u.vout)`. `fetchPrlUtxos` constructs `vout: Number(voutStr)` from the page key `${txid}:${vout.n}`. A hostile sentry can return `vout: { n: 1.5 }` or `vout: { n: 2**53 + 1 }` — `Number(voutStr)` yields a non-integer or out-of-range number, the worker accepts it, then passes it as `index: u.vout` to `@scure/btc-signer`'s `addInput`. The signer is likely to either truncate, throw an arcane error, or (worst case) produce a malformed prev-out reference that resembles a valid one for a different vout.
- **Impact:** Theoretical wasted-fee/lost-tx if a hostile sentry can predict the signer's truncation behaviour to swap a `vout=1` reference for a `vout=2` reference of the same txid. Realistically: tx broadcast fails with a confusing error. Defence in depth.
- **Recommended fix:** In the worker's UTXO shape check, replace `typeof u.vout !== "number" || u.vout < 0` with `!Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xffffffff` (32-bit unsigned bound matches the protocol).
- **Code refs:** `worker.ts:421-422`, `pearl-rpc.ts:293-294`.

### O1-M-3 — Worker does not bind `scriptHex` to the signing key — can be tricked into signing UTXOs it doesn't own (broadcast-rejection DoS)
- **Location:** `src/crypto/worker.ts:414-440`.
- **Description:** For each input the worker takes `scriptHex` from the main thread and passes it as `witnessUtxo.script` along with the `tapInternalKey` (x-only pubkey from the named pool index). It never verifies that the BIP-86-tweaked output key matches the first 32 bytes of the `scriptHex` (after the `0x5120` P2TR prefix). A hostile sentry can return UTXOs whose `scriptHex` points to a DIFFERENT P2TR output than the one derived from `session.pearlReceive[poolIndex]`. The signer happily binds-and-signs; broadcast then fails because the on-chain prev-out doesn't match the witness. Repeated indefinitely, this is a denial of spend even when the user has live UTXOs.
- **Impact:** A hostile sentry can stall the wallet's send flow without ever allowing the user to escape — every signed tx is a guaranteed broadcast failure. The user might top up funds, switch sentries, or sign more attempts before realising. Combined with O1-H-1 inflation, this is a directed-pressure attack. Cannot produce theft because the signature is invalid for the actual prev-out (BIP-341 protects).
- **Recommended fix:** In the worker, derive the expected P2TR output key from `session.pearlReceive[u.poolIndex].pubKey` (strip parity, BIP-86 tweak, get x-only output key), build the canonical `5120<32-byte-output-key>` scriptPubKey, and assert byte equality with `u.scriptHex`. Throw `E_PEARL_SCRIPT_KEY_MISMATCH` on mismatch. The wallet already has `bip86Tweak` in `src/chains/pearl/address.ts:46-59`, so the verification is a few lines.
- **Code refs:** `worker.ts:430-439`, `address.ts:46-59`, `address.ts:121-130`.

### O1-M-4 — Worker `addOutputAddress` placeholder network accepts Bitcoin-mainnet P2PKH/P2SH addresses, not just Pearl bech32m
- **Location:** `src/crypto/worker.ts:410, 442-449`.
- **Description:** The worker constructs `network = { bech32: params.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 }` and passes it to `tx.addOutputAddress(o.address, amt, network)`. These pubKeyHash/scriptHash version bytes are Bitcoin-mainnet defaults; Pearl is taproot-only. `@scure/btc-signer.Transaction.addOutputAddress` decodes the destination — and with these placeholders, it will happily accept a legacy Bitcoin P2PKH address (`1...`) or P2SH (`3...`) starting with the corresponding version byte. The UI validates via `validPearl` which only accepts bech32m with HRP `prl`, so this is reachable only if a buggy UI or a future code path bypasses the validator. Defence in depth.
- **Impact:** If any code path ever passes a non-validated destination to `sendPearl`, the worker would happily sign a transaction sending PRL to a Bitcoin-address-shaped output. The funds would be locked at a script no Pearl key can spend. Not exploitable from the current UI but the next refactor could introduce it.
- **Recommended fix:** Reject any output address that does not start with `params.hrp + "1"` (the bech32 separator); or pre-decode the address with the project's own `decodeTaprootAddress` and abort on failure. The dummy `pubKeyHash: 0x00` etc. should be replaced with values that cannot match any real network (e.g. `0xff`) so a stray P2PKH attempt is rejected by the library too.
- **Code refs:** `worker.ts:410, 442-449`, `address.ts:80-98`.

### O1-M-5 — `composePearlSend` largest-first walk silently overpays when UTXO values are sentry-inflated
- **Location:** `src/services/pearl-tx.ts:64-86, 93-145`.
- **Description:** `listPoolUtxos` sorts UTXOs by sentry-reported `valueGrains`, largest first. Coin selection terminates when `sum >= amount + tipGrains + fee`. If the sentry overstates UTXO values (returns 100M grains for a UTXO actually worth 1M), the user's coin selection picks too few inputs and the broadcast fails (mempool rejects: input value < output value). The composed preview displays the inflated change, fee, and "Total leaving wallet" — UX confusion. Worse: if the inflated UTXO causes selection to pick a DIFFERENT input that legitimately covers the send, the user pays inflated fees relative to their actual coin holdings (the signer still binds the real values, but the preview lied).
- **Impact:** UX-level confusion and denial of spend. No direct fund loss because BIP-341 sighash binds to actual prev-out amounts; the signed tx is correct for the on-chain reality. The user may pay a few extra grains in fee due to over-selection. Combined with O1-M-3, this is part of a "drive the user crazy" attack profile.
- **Recommended fix:** Document the trust assumption ("preview values are sentry-reported; on-chain reality wins"). Optional: cross-check totals against `fetchPrlBalanceGrains` and warn if the UTXO-sum diverges from the balance-sum by > some threshold. The fix is defensive UX, not a security bug per se.
- **Code refs:** `pearl-tx.ts:82-86`, `pearl-tx.ts:104-115`.

---

## L — Low

### O1-L-1 — `evaluateGasCoverage` uses `>=` (correct for boundary equality but does not include a safety margin)
- **Location:** `src/services/eth-tx.ts:202-213`.
- **Description:** `covered = ethBalanceWei >= worstCaseWei`. At exact equality, the send proceeds — but the worst-case-wei is `gas * maxFeePerGas`, which is the absolute ceiling, not the expected cost. If the user holds *exactly* `gas * maxFeePerGas` ETH, the tx may settle, but they'll be left with zero ETH for the next transaction. No security impact; mild UX issue. Worth a note for the call-site (`SendWPRL.tsx`) to maybe surface "after this send you'll have ~0 ETH left for future gas".
- **Impact:** Stranded user with exhausted gas budget after one tx.
- **Recommended fix:** Optional reserve in `evaluateGasCoverage` (e.g. require `balance >= worstCase + 0.5 * worstCase` for "comfortable" vs "tight" labels). Or just keep the boundary correct as-is and let UI surface the post-send remainder.
- **Code refs:** `eth-tx.ts:211`.

### O1-L-2 — `passwordAcceptable` degenerate-entropy heuristic misses repeating short patterns longer than 2 unique chars
- **Location:** `src/lib/validate.ts:98-119`.
- **Description:** The v0.1.8 fix rejects all-digit, ≤2 unique chars, and monotonic walks. It accepts strings with 3+ unique chars that aren't monotonic. But a repeating 3-char pattern like `"abcabcabcabcabc"` (15 chars — under 16-char passphrase floor, so caught by class-mix gate) or `"abcabcabcabcabca"` (16 chars, 3 unique, NOT monotonic) passes — entropy is `log2(3^16) ≈ 25 bits` if the attacker knows the 3-char alphabet, way below the 70-bit floor the heuristic is meant to enforce. Same for `"qweqweqweqweqweq"` (top keyboard row trigram). Real users do this; it's the next-most-common low-entropy pattern after all-digit.
- **Impact:** A determined user can defeat the entropy guard with a trivial repeating pattern and end up with a keystore that's brute-forceable on a single GPU in hours.
- **Recommended fix:** Add a repeating-substring check: if there exists `k in [1, 3, 4]` such that `password === password.slice(0, k).repeat(password.length / k)` (and the inner repeat is a clean divisor), reject. Or measure unique 3-grams: if `password.length >= 12` and the number of distinct 3-grams is `< password.length / 4`, reject. Keep the rejection message friendly — "avoid repeating short patterns."
- **Code refs:** `validate.ts:101-117`.

### O1-L-3 — `pearlParams` allowlist re-check silently falls back to canonical; no UI signal
- **Location:** `src/chains/pearl/network.ts:39-53`, `src/services/pearl-rpc.ts:42-45`.
- **Description:** v0.1.8 Opus2 H-2 fix re-validates the override on every read. If the persisted localStorage `pearlRpcOverride` was tampered with to point at `https://attacker.example/` (and somehow bypassed the setter's allowlist — bookmarklet, stale value, manual edit), `pearlParams` now silently returns `PEARL_MAINNET` (canonical). Correct security behaviour, but the user's Settings page would still display the malicious URL in the input box because `rpcDraft` is loaded from the store's raw value. The user sees "custom RPC: https://attacker.example" while the wallet is actually using the canonical RPC. Confusion.
- **Impact:** No security loss (canonical RPC is used). User confusion that may cause them to think the wallet is broken.
- **Recommended fix:** In `ui-store.ts:55-71` (`loadUI`), when the re-validation fails, blank out `pearlRpcOverride` before exposing to the React tree. The persisted-but-invalid value is already useless; clearing it eliminates the UI-discrepancy class of bug.
- **Code refs:** `ui-store.ts:64-66`, `network.ts:50-52`.

### O1-L-4 — `monotonicNow` fallback uses module-scope state — share across tests can mask test-ordering bugs
- **Location:** `src/lib/monotonic.ts:18-32`.
- **Description:** The fallback `monotonicFallbackHigh` is module-scope. Tests can reset via `__resetMonotonicForTests`, but any production code that runs in two parallel React trees (e.g. a future micro-frontend embedding) shares the same latch. Not exploitable, just an architectural smell. The latch logic itself is correct.
- **Impact:** None in current single-page wallet usage.
- **Recommended fix:** Document the assumption ("one wallet per origin") in the comment header, or wrap state in a closure with an explicit `makeMonotonic()` factory exported for testing.
- **Code refs:** `monotonic.ts:18-32`.

---

## I — Info

### O1-I-1 — `prlToGrains` accepts `0` value vouts but `fetchPrlUtxos` collects them anyway
- **Location:** `src/services/pearl-rpc.ts:85-92, 267-276`.
- **Description:** `prlToGrains(0)` returns `0n`. `fetchPrlUtxos` then puts a 0-value UTXO into the working set. In `composePearlSend`, the greedy walk picks the largest-first; a 0-value UTXO would sort last and be picked only if absolutely nothing else covers the send (in which case the loop would still throw `E_INSUFFICIENT_FUNDS`). The worker rejects `valueGrains <= 0n`. So a 0-value UTXO would be ignored end-to-end. Harmless. Note: real Pearl L1 vouts cannot be 0 (dust limit is 546), but a hostile sentry could emit one. Defensive baseline.

### O1-I-2 — `signPearlTx` does not check that `r.outputs` total <= `r.utxos` total (relies on @scure/btc-signer's `allowUnknownOutputs:false`)
- **Location:** `src/crypto/worker.ts:412`.
- **Description:** `allowUnknownOutputs: false` is the relevant guard — it prevents adding outputs to addresses the library can't decode. But there's no explicit input-sum >= output-sum check in the worker. A buggy main thread (or a future change to `composePearlSend`) that produces an output total exceeding input total would let `tx.finalize()` throw — `@scure/btc-signer` does enforce this internally — and the worker would surface the throw. Defence-in-depth: a `// pre-finalize sum check` in the worker would make the invariant explicit.

### O1-I-3 — Cross-tab consistency of `monotonicNow` is not guaranteed (different origins of `performance.now()`)
- **Location:** `src/lib/monotonic.ts:20-22`.
- **Description:** `performance.now()` is per-document-context — two tabs of the wallet see independent zero-origins. The auto-lock logic uses `monotonicNow() - lastActivity`, and `lastActivity` is per-tab (set in this tab's React tree). So cross-tab consistency is not a concern *for auto-lock*. The cross-tab keystore broadcast (`pearl-wallet-keystore`) uses BroadcastChannel events, not timestamps. Documented because the comment in `monotonic.ts` hints at "cross-tab consistency" without resolving it — adding a one-liner that the auto-lock is per-tab would settle the question for the next reviewer.

### O1-I-4 — `index.html` CSP `<meta>` cannot set `frame-ancestors`; non-CF mirrors lack click-jack protection in the headers layer
- **Location:** `index.html:13-16`, `public/_headers:2`.
- **Description:** Per spec, `frame-ancestors` is ignored when set via `<meta http-equiv>`. The wallet relies entirely on `_headers` (CF Pages) and the `iframe-bust.js` runtime check. On any non-CF mirror, only the runtime check protects the user. See O1-H-2 for the failure-mode escalation. Logged here as defence-in-depth: the wallet's documented threat model should explicitly say "non-CF mirrors are second-class citizens; load `iframe-bust.js` must succeed."

---

## Verified-clean areas

For audit completeness, the following areas were reviewed and no defects were found at this severity threshold:

- **BIP-86 taproot tweak** (`src/chains/pearl/address.ts:46-59`) — tagged-hash construction, scalar-mult, x-only output correctly implemented; matches BIP-86 reference.
- **`signEthTx` chainId binding** (`src/crypto/worker.ts:381-393`) — chainId is taken from main-thread `t.chainId`, which originates in `eth-tx.ts:120-129` via `client.chain.id` (viem's hardcoded chain definitions). No path lets a hostile RPC swap the chainId.
- **`normalizeRelayerMintSig`** (`src/services/bridge.ts:72-144`) — strict canonical-decimal uint256 parsing, rejects JSON numbers, hex strings, leading zeros; binding `expected` is required at the type level on `verifyRelayerMintSig`.
- **Worker origin guard** (`src/crypto/worker.ts:464-477`) — rejects cross-origin postMessage; accepts empty origin only under file:// / test-env, which is the standard pattern.
- **AsyncLock serialisation** of wallet-store mutating ops (`src/state/wallet-store.ts:143-161`) — correctly chains, releases on error, no observable deadlock path.
- **`hexToBytes` boundary** (`src/crypto/worker.ts:57-75`) — rejects odd-length, non-hex, empty; no silent truncation.

---

## Reproducibility

- All file:line references resolved against `git show 6935c6e:<path>`.
- Diff base for "v0.1.9 delta": `git diff 79d7890..6935c6e`.
- 195 tests passing per commit message; this audit did not re-run the suite, but cross-checked findings against `tests/v019.test.ts:1-345` for behaviour assumptions.
