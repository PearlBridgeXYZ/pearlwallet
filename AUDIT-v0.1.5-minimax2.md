# PearlWallet v0.1.5 — Audit Pass #2 Findings (Minimax)

---

## CRITICAL

### 1. Dangling promises after `WorkerClient.reset()`

**File:** `src/crypto/worker-client.ts:42` (`reset()`) and `:27` (`onmessage`)

`reset()` terminates the worker and clears `this.inflight`, but the `Map` entries (each a `{ resolve, reject }` pair) are deleted *without* calling `reject`. The worker's `onerror` is typed as `onmessageerror` (wrong event type — `ErrorEvent` is never fired by a `DedicatedWorkerGlobalScope`), so it never fires. Any in-flight call (e.g. `unlock`, `deriveAddresses`) made near-simultaneously with a lock or a timeout-triggered auto-lock hangs forever. The caller has no timeout, so the UI is wedged.

**Fix:** Before clearing, iterate `this.inflight.values()` and call `reject(new Error("E_WORKER_RESET"))` on each entry.

---

### 2. UTXO deduplication fails across pagination pages

**File:** `src/services/pearl-rpc.ts:78` (inside `fetchPrlBalanceGrains`)

The UTXO map key `${txid}:${vout}` is unique per output, so intra-page dedup is fine. The bug is subtler: if `searchrawtransactions` returns the same transaction in two consecutive pages (e.g. a brief re-org + re-include between the two calls), the balance gains that UTXO twice — once on page N, once on page N+1 — because `utxo.delete` only fires when the *same* page also contains the vin. The `page.length < PAGE` break condition doesn't prevent this; a re-org can cause a tx to appear in pages N and N+1 before the cursor advances past it.

A second, more likely path: the same UTXO is returned in two pages because the RPC's internal cursor skips a tx while delivering the previous page. Either way, the balance is overstated.

**Fix:** Maintain a `seen: Set<string>` of already-processed `${txid}:${vout}` keys and skip any duplicate entry regardless of which page it arrives on.

---

### 3. `deadline` not validated before using mint signature

**File:** `src/services/bridge.ts:94` (`getMintSignature`)

`verifyRelayerMintSig` recovers the signer and checks the RELAYER role (Pass 1 coverage), but neither function checks `sig.payload.deadline`. An old cached signature (or a relay that re-signs the same nonce after expiry) passes the role check and is returned. If the caller doesn't independently verify `deadline > Date.now() / 1000 | 0` before broadcasting, a signature valid at signing time could be replayed after the window closes — the contract may reject it, but the user experience is a failed broadcast and confusion.

**Fix:** In `getMintSignature`, after `verifyRelayerMintSig`, add:
```ts
if (sig.payload.deadline < Math.floor(Date.now() / 1000)) {
  throw new Error("E_SIGNATURE_EXPIRED");
}
```

---

### 4. `prlToGrains` panics on negative or extreme floats

**File:** `src/services/pearl-rpc.ts:54` (`prlToGrains`)

```ts
const sign = whole.startsWith("-") ? -1n : 1n;
// ... then:
return sign * (BigInt(wholeAbs) * 100_000_000n + BigInt(fracPadded));
```
If the RPC returns a negative `value` (malicious/faulty node, or a debited-but-not-confirmed amount presented as a raw value), `sign` is `-1n` and the product is a large negative bigint. Summing it into `total` in `fetchPrlBalanceGrains` produces a negative total, which downstream balance arithmetic treats as valid.

Separately: `value.toFixed(8)` on `Infinity` or `NaN` (from `JSON.parse` of a corrupted body, or an upstream fault) throws a `RangeError`, crashing the entire balance walk and surfacing `error` to the user — real funds are not lost (the RPC failure is detectable) but a single bad value in a 20-address pool throws away all 20 results.

**Fix:** Guard at the top of `prlToGrains`:
```ts
if (!Number.isFinite(value) || value < 0) throw new Error("E_INVALID_RPC_VALUE");
```

---

## HIGH

### 5. Password change stale-blob in multi-tab scenario

**File:** `src/state/wallet-store.ts:131` (`changePassword`)

`changePassword` writes the new blob to IndexedDB, then calls `set({ blob: out.blob })`. In a second open tab, `init()` loaded the old blob into that tab's closure. All subsequent operations in Tab B (e.g. `exportMnemonic`, or a `lock()` that triggers `reset()`) use the Tab B closure's `blob`, which is the pre-change ciphertext. The worker, if still alive, will `decryptBlob` with the new password against the old blob and throw `E_PASSWORD_WRONG` — confusing, not obviously a race.

The reverse is worse: if Tab A changes the password *and* the worker is reset, Tab B's in-memory `blob` is permanently orphaned from the on-disk state. Any future `saveKeystore` (e.g. on `unlock` pool upgrade) would overwrite with the old blob, wiping the new password.

**Fix:** After a successful `changePassword`, emit a custom event on `window` that Tab B listens for and triggers `init()` to reload the fresh blob from IndexedDB.

---

## MEDIUM

### 6. `hexToBytes` silently truncates odd-length input

**File:** `src/crypto/worker.ts:38`

```ts
const out = new Uint8Array(clean.length / 2);
for (let i = 0; i < out.length; i++) {
  out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
}
```
`out.length` is integer-divided, so `"0xabc"` → `clean = "abc"` → `out.length = 1`; the final `"c"` is discarded. For `kdfSalt` and `iv` (each 16 and 12 bytes respectively, i.e. 32 and 24 hex chars), this is unlikely in practice from `blobToJSON`, but a manually edited exported JSON would silently produce a 1-byte salt, breaking decryption. Invalid hex chars (e.g. `"xyz"`) produce `NaN`, which `Uint8Array` coerces to `0` — equally silent.

**Fix:** Add a guard: `if (clean.length % 2 !== 0) throw new Error("E_ODD_HEX");` and validate that every char is `[0-9a-fA-F]`.

---

### 7. Bridge fee label shows 10× the actual rate

**File:** `src/ui/pages/Bridge.tsx:55`

```ts
const activeFeeBps = isPrlSide ? fees.mintFeeBps : fees.burnFeeBps;
// ...
<div className="flex justify-between">
  <dt className="text-ink-500">
    Bridge fee ({activeFeeBps / 100}%)
```
`activeFeeBps` is already in basis-points (e.g. `50` for 50 bps = 0.5%). Dividing by 100 displays "0.5%" which is *coincidentally* correct by accident for 50 bps. But for `burnFeeBpsDefault = 0`, the user sees "0%". If the contract returns `5` bps, the label reads "0.05%" (correct) but the arithmetic `fee = (native * 5n) / 10000n` in the preview (line 63) uses 10000, which is also correct. The display inconsistency is that the label uses the raw bps integer divided by 100 — it works for 50 but would be wrong for e.g. `200` bps (should be 2%, displays 2% — correct by coincidence here but fragile).

**Fix:** Divide by 100 in the label: `(activeFeeBps / 100).toFixed(2)` to produce "0.50%". Or better: use `(activeFeeBps / 100).toFixed(2)` for display and clarify "bps" in the label.

---

## LOW

### 8. `onerror` typed as `onmessageerror` — wrong event type

**File:** `src/crypto/worker-client.ts:28`

```ts
worker.onerror = (ev) => {
  console.error("crypto worker error", ev);
};
```
`Worker.onerror` receives a `ErrorEvent`; `onmessageerror` receives a `MessageEvent`. The handler fires correctly for uncaught worker exceptions, but `ev` is typed as `MessageEvent` here, so `ev.filename`, `ev.lineno`, `ev.colno` (available on `ErrorEvent`) are inaccessible without a cast. Not exploitable, but the error context is incomplete.

**Fix:** Type the handler as `(ev: ErrorEvent) => void`.

---

### 9. `resetRpc` bypasses HTTPS requirement

**File:** `src/ui/pages/Settings.tsx:168` (`resetRpc`)

```ts
function resetRpc() {
  setRpcDraft("");
  setPearlRpcOverride("");   // ← no URL validation
  setRpcStatus(`Using default (${defaultRpcUrl}).`);
}
```
The `saveRpc` path validates `https://` via `parsed.protocol !== "https:"`. `resetRpc` has no such guard. In practice the default `PEARL_MAINNET.rpcUrl` is HTTPS, so the effective result is fine, but the code path is inconsistent. If the default were ever changed to HTTP, `resetRpc` would silently accept it.

**Fix:** Either assert `defaultRpcUrl.startsWith("https://")` in `resetRpc`, or call through `saveRpc("")` after validation.

---

## INFO

- **`pearlAddressFromSession` receives mutable `session`:** The `PearlReceiveKey.pubKey` field is an internal `Uint8Array`. Nothing in the call chain mutates it, and the worker is single-threaded — not an issue.
- **Zero-width chars in Pearl addresses:** `decodeTaprootAddress` → `bech32m.decode` validates the checksum, which covers all 1023-bit data words. A zero-width char inserted into the address string would corrupt the bech32m encoding and fail checksum validation. EIP-55 ETH address validation in `viem`'s `isAddress` similarly catches homoglyph attacks. No action needed.
- **`exportMnemonic` doesn't check session:** The comment says "require both active session AND password" but the implementation only checks the password via `decryptBlob`; the session is irrelevant. The mnemonic is stored in the blob, not the session. Correct by accident — no security issue.
- **Integer overflow in `computeTipGrains`:** `sendAmountGrains` max is ~21 million PRL × 10⁸ = 2.1×10¹⁵, well within `bigint` range. Not exploitable.
- **`RECEIVE_GAP_LIMIT = 20` walk time:** At 300ms/request the worst case is ~6s, acceptable given react-query caching. Not a vulnerability.
- **`AUTO_LOCK_MS` exported:** Correctly shared between `wallet-store.ts:28` and `App.tsx`, fixing the Pass 1 finding.
