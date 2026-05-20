## Executive Summary
This second adversarial pass identified **five distinct security and reliability issues** that were either missed by the first audit or represent incomplete fixes. The most critical finding is a **Denial of Service (DoS) vulnerability** in the Pearl UTXO balance walker, where a malicious or buggy RPC can cause the browser to hang indefinitely. Additionally, the EIP-712 signature binding, while added in v0.1.6, is **enforced as optional in the API**, creating a dangerous pathway for Man-in-the-Middle attacks on the bridge flow.

---

### Critical

#### 1. Infinite Loop DoS in Pearl Balance Walker
**File:** `src/services/pearl-rpc.ts:79`  
**Exploit Path:** A compromised or misconfigured Pearl RPC endpoint (`searchrawtransactions`) returns exactly 100 items (`PAGE` size) on every request, but never reaches an empty state (e.g., returning dummy transactions or looping cursor).  
**Impact:** The `while (true)` loop never terminates. The browser tab hangs, consuming 100% CPU until the tab is killed.  
**Fix:** Introduce a `maxPages` (e.g., 20) or `maxTransactions` cap to break the loop and treat the result as "best effort" or error if the limit is hit.

```typescript
// Suggested guard in fetchPrlBalanceGrains
const MAX_PAGES = 20;
let pageCount = 0;
while (true) {
  // ... fetch logic ...
  if (page.length < PAGE || ++pageCount >= MAX_PAGES) break;
}
```

---

### High

#### 2. Incomplete EIP-712 Binding Enforcement
**File:** `src/services/bridge.ts:60`  
**Exploit Path:** The `verifyRelayerMintSig` function accepts an optional `expected?: IntentExpectation` parameter. If the Bridge UI (or a future integration) calls `getMintSignature` without passing the user's original intent, the verification logic **skips the recipient, amount, and SDI hash checks** (lines 76-85). A compromised Relay can substitute any recipient or amount, and the wallet will verify it as long as the signature is valid and from a relayer address.  
**Impact:** Loss of funds. The fix in v0.1.6 introduced the binding check, but making it optional defeats the purpose.  
**Fix:** Make `expected` a **required** parameter in `verifyRelayerMintSig` and `getMintSignature`. Throw `E_MISSING_INTENT_EXPECTED` if undefined.

#### 3. Future Keystore Blob Version Handling
**File:** `src/crypto/keystore.ts:18` & `src/crypto/worker.ts`  
**Exploit Path:** The `EncryptedBlob` interface hardcodes `version: 1`. If a future wallet release (v0.2.0) introduces a v2 blob format (e.g., changing KDF iterations or cipher) and a user restores their wallet using the v0.1.6 client:  
1. The client reads `version: 2` from JSON.  
2. It attempts to decrypt using the v0.1.6 logic (which might use mismatched KDF params or fail to parse the new JSON structure).  
3. The wallet fails to unlock with a generic "E_PASSWORD_WRONG" or a cryptic crypto error, strandeding user funds.  
**Impact:** Data loss / Permanent account lockout for users upgrading from older backups in a mixed-version environment (or downgrading).  
**Fix:** Explicitly check `if (blob.version !== 1) throw new Error("E_UNSUPPORTED_BLOB_VERSION")` in `decryptBlob` and `blobFromJSON`.

---

### Medium

#### 4. Clipboard Auto-Clear on Unmount
**File:** `src/ui/pages/Receive.tsx:49`  
**Exploit Path:** The clipboard clear is implemented via a `setTimeout` that runs 60 seconds after the copy action. If the user navigates away from the Receive page (e.g., clicks "Send" or "Dashboard") *before* the 60s expires, the timeout **still fires**.  
1. User copies address.  
2. User navigates to Send page (55 seconds later).  
3. Timeout fires (5 seconds later).  
4. Wallet checks clipboard (contains address), clears it.  
5. User on Send page tries to paste -> Buffer is empty.  
**Impact:** Nuisance / Poor UX. Forces user to re-copy.  
**Fix:** Store the timeout ID in a `useRef` and clear it in the component's `useEffect` cleanup return.

#### 5. BroadcastChannel Handler Re-registration in Strict Mode
**File:** `src/state/wallet-store.ts:109`  
**Exploit Path:** In React Strict Mode (development), `init()` may be called twice. This creates two separate `BroadcastChannel` instances (or at least attaches two handlers to the same channel logic). While functionally redundant, it leads to double-processing of events (e.g., `cryptoWorker.reset()` is called twice, `set()` updates state twice).  
**Impact:** Performance degradation and potential race conditions in event handling logic.  
**Fix:** Ensure `init()` is idempotent or check if the channel is already initialized before attaching the handler.

---

### Low / Info

#### 6. CSP: Worker Source
**File:** `public/_headers`  
**Note:** The CSP `worker-src 'self' blob:` is correctly set to allow the Vite-compiled inline worker. This is necessary for `new CryptoWorker()`. No change needed, but noted for audit completeness.

#### 7. Activity Throttle Closure Safety
**File:** `src/App.tsx:67`  
**Verification:** Confirmed that the `useEffect` dependency on `status` ensures that when the wallet locks and unlocks, the effect is torn down and recreated. The new effect captures a fresh `touch` function and `lastBump` variable, preventing stale closure issues. **This fix is complete.**

#### 8. Multi-Tab Password Change Race
**File:** `src/state/wallet-store.ts`  
**Note:** The implementation correctly handles the race where Tab A changes the password while Tab B is unlocked
