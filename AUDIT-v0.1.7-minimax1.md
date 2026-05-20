# Security Audit Report: Pearl Web Wallet v0.1.7

**Auditor:** MiniMax Model (Independent Security Review)
**Target:** Pearl Web Wallet v0.1.7
**Date:** May 20, 2026
**Scope:** src/services/bridge.ts, src/services/pearl-rpc.ts, src/services/balances.ts, src/state/wallet-store.ts, src/crypto/keystore.ts, src/crypto/worker.ts, src/crypto/worker-client.ts, src/lib/validate.ts, src/ui/pages/*, src/App.tsx, public/_headers, index.html

---

## Executive Summary

The v0.1.7 release addresses several security improvements identified in prior audits, including:
- AAD context binding in AES-GCM encryption (prevents ciphertext-swap attacks)
- coerceUint normalization at the relayer signature boundary
- Two-pass UTXO walk ordering (prevents hostile sentry vin/vout reordering)
- MAX_UTXO_WALK_PAGES cap (prevents infinite loops)
- IntentExpectation required at type level (prevents MITM on relayer signatures)
- Async lock pattern for cross-tab sync
- Splash "initializing" status (prevents CTA flash)

**Overall Assessment:** The codebase demonstrates good security hygiene. One HIGH-severity regression was identified (sourcemap leakage in production). Several low-risk observations are documented.

---

## Findings

### HIGH: Sourcemap Leakage in Production Builds

**File:** vite.config.ts:21
```typescript
build: {
  target: "es2022",
  sourcemap: true,  // <-- Enabled unconditionally
```

**Description:** The Vite build configuration enables sourcemaps for all builds, including production. This causes source maps to be generated alongside bundled JavaScript files. While Vite generates "hidden" sourcemaps (no `//# sourceMappingURL` comment in the JS), the map files are still served as separate assets and can be directly requested by attackers.

**Impact:**
- Full source code exposure in production
- File paths, variable names, comments visible
- Aids reverse engineering and vulnerability discovery
- Could expose debugging paths or incomplete security checks

**Recommendation:**
```typescript
build: {
  target: "es2022",
  sourcemap: process.env.NODE_ENV !== "production" ? true : false,
  // Or use: sourcemap: process.env.NODE_ENV === "development",
```

**Severity:** HIGH

---

### LOW: AAD Construction Uses JSON Stringification Without Sorted Keys

**File:** src/crypto/keystore.ts:21-23
```typescript
return new TextEncoder().encode(
  JSON.stringify({ v: version, kdf, iter: kdfIterations, c: cipher }),
);
```

**Description:** The AAD (Additional Authenticated Data) is constructed via JSON.stringify. While current JavaScript implementations preserve insertion order for string keys, this is not guaranteed by the ECMAScript specification (though ES2015+ generally maintains insertion order for non-integer keys). The JSON object keys happen to be in alphabetical order, which coincidentally produces consistent serialization.

**Impact:**
- Low risk: Current implementation is consistent within a single runtime
- Could cause interoperability issues if migrating between browsers with different JSON implementations
- Downstream systems that re-compute AAD must match exact encoding

**Recommendation:** Consider using a canonical string format or explicit sorting:
```typescript
const aadStr = JSON.stringify({ v: version, kdf, iter: kdfIterations, c: cipher });
// Or: `v=${version}&kdf=${kdf}&iter=${iter}&c=${cipher}`
```

**Severity:** LOW

---

### LOW: BroadcastChannel Created Per Event

**File:** src/state/wallet-store.ts:82-91
```typescript
function broadcastKeystoreEvent(ev: KeystoreEvent): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(KEYSTORE_BROADCAST_CHANNEL);
    ch.postMessage(ev);
    ch.close();
  } catch {
    // BroadcastChannel unsupported (older Safari) — silent fallback.
  }
}
```

**Description:** A new BroadcastChannel is created, used, and closed for every event. While not a security issue, this is inefficient and could cause message loss if events fire rapidly (though the current usage is infrequent).

**Impact:**
- Minor performance overhead
- No security impact

**Recommendation:** Consider reusing a single BroadcastChannel instance (like `keystoreChannel`).

**Severity:** INFO

---

### INFO: No Clipboard Auto-Clear After Sensitive Copy

**File:** src/ui/pages/OnboardingCreate.tsx:137
```typescript
<p className="mt-3 text-xs text-ink-500">
  Writing down is safer. Clipboard can be read by malware.
</p>
```

**Description:** The UI warns users not to copy mnemonics to clipboard but does not automatically clear the clipboard after copy operations. This is mentioned in the UI as a warning, which is appropriate. No automatic clipboard clearing is implemented.

**Impact:**
- User must manually clear clipboard
- Warning is visible and clear

**Recommendation:** Consider adding clipboard clearing after a timeout (e.g., 30 seconds) if the application ever implements copy-to-clipboard functionality for mnemonics. Currently, the UI does not provide a copy button for mnemonics.

**Severity:** INFO (appropriately mitigated via warning)

---

### INFO: Worker Message Origin Not Validated

**File:** src/crypto/worker.ts:290-303
```typescript
self.onmessage = async (ev: MessageEvent<WorkerCmd>) => {
  const msg = ev.data;
  // No origin check here
```

**Description:** The Web Worker does not validate `ev.origin` on incoming messages. Workers can only be instantiated from same-origin scripts due to CSP (`worker-src 'self' blob:`), and there's no `importScripts` that could load external code.

**Impact:**
- Mitigated by CSP: only same-origin workers can be created
- No cross-origin worker instantiation possible
- Actual risk is LOW

**Recommendation:** Add explicit origin check for defense in depth:
```typescript
self.onmessage = async (ev: MessageEvent<WorkerCmd>) => {
  if (ev.origin !== self.origin) return; // Reject cross-origin
```

**Severity:** INFO (appropriately mitigated by CSP)

---

### INFO: prlToGrains Uses toFixed(8) Which Can Throw

**File:** src/services/pearl-rpc.ts:81-88
```typescript
function prlToGrains(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("E_INVALID_RPC_VALUE");
  }
  const [whole, frac = ""] = value.toFixed(8).split(".");
  // ...
}
```

**Description:** The code correctly validates for finite numbers and negative values before calling `toFixed(8)`. If a malicious or buggy sentry sends a value that causes `toFixed(8)` to throw (e.g., extremely large numbers that overflow), it will propagate as an uncaught exception.

**Impact:**
- Malicious RPC would cause balance fetch to fail entirely
- Not exploitable for fund theft
- Fails closed (throws) rather than allowing incorrect balances

**Recommendation:** Add a try-catch wrapper for defense in depth:
```typescript
try {
  const [whole, frac = ""] = value.toFixed(8).split(".");
} catch {
  throw new Error("E_INVALID_RPC_VALUE");
}
```

**Severity:** INFO (fails closed)

---

### INFO: Partial Pool Label Could Leak HD Discovery Side-Channel

**File:** src/services/balances.ts:75
```typescript
if (result.failures > 0) prlSource = "partial";
```

**Description:** When some addresses in the pool fail to fetch, the balance is returned with a "partial" source label. An observer (including the RPC endpoint) could potentially infer information about which addresses have activity based on which ones fail vs succeed.

**Impact:**
- Very limited: The pool is derived deterministically from the seed
- RPC already sees all queried addresses
- No additional information leakage to third parties

**Recommendation:** This is acceptable. The alternative (silently returning under-reported balance without a label) would be worse UX and could cause users to miss funds.

**Severity:** INFO (acceptable tradeoff)

---

### INFO: Missing COEP Header for SharedArrayBuffer

**File:** public/_headers, index.html

**Description:** The security headers include CSP and worker-src but do not include `Cross-Origin-Embedder-Policy: require-corp`. This prevents using SharedArrayBuffer for performance optimizations, though no such usage was observed in the codebase.

**Impact:**
- No impact on current functionality
- Prevents future use of SharedArrayBuffer without additional headers

**Recommendation:** If SharedArrayBuffer is needed for performance in future versions, add:
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

**Severity:** INFO

---

### VERIFIED: Security Controls (No Issues Found)

#### coerceUint Implementation (bridge.ts:97-108)

The coerceUint function correctly handles:
- Empty strings (rejects via trim() check)
- null/undefined (explicit check)
- NaN and non-finite numbers (Number.isFinite check)
- Negative values (explicit check after BigInt coercion)
- Non-string/number/bigint types (type guard)
- Fractional values (BigInt silently truncates, but the negative check catches negative fractions)

**Assessment:** SECURE

#### Two-Pass UTXO Walk (pearl-rpc.ts:144-162)

The two-pass approach (vouts first, then vins) correctly prevents hostile sentry manipulation where vin references could appear before their funding vout in the same page.

**Assessment:** SECURE

#### MAX_UTXO_WALK_PAGES Cap (pearl-rpc.ts:102, 128-132)

The hard cap of 20 pages (20 × 100 = 2000 transactions) prevents infinite loops from hostile or buggy sentry implementations.

**Assessment:** SECURE

#### IntentExpectation Binding (bridge.ts:144-147)

The `expected` parameter is now required at the type level:
```typescript
export async function verifyRelayerMintSig(
  sig: RelayerMintSig,
  network: EthNetwork,
  expected: IntentExpectation,  // REQUIRED
  nowSecOverride?: bigint,
): Promise<{ signer: `0x${string}` }>
```

This prevents callers from accidentally skipping the binding check.

**Assessment:** SECURE

#### AAD Context Binding (keystore.ts:15-27)

The AAD now binds version, KDF, iterations, and cipher:
```typescript
export function computeAAD(
  version: number,
  kdf: string,
  kdfIterations: number,
  cipher: string,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ v: version, kdf, iter: kdfIterations, c: cipher }),
  );
}
```

This prevents ciphertext-swap attacks where a blob from a different configuration could be substituted.

**Assessment:** SECURE (with LOW observation on JSON stringification noted above)

#### Async Lock Pattern (wallet-store.ts:109-127)

The makeAsyncLock pattern correctly serializes mutations:
- Each operation chains onto the previous promise
- Release is called in finally block to ensure unlock
- Errors in prior operations don't block subsequent ones

**Assessment:** SECURE

#### Splash Initializing Status (Splash.tsx:19-25)

The "initializing" status correctly prevents CTA flash:
```typescript
{initializing ? (
  <div className="text-sm text-ink-500 dark:text-ink-400">Loading...</div>
) : hasWallet ? (
```

**Assessment:** SECURE

#### CSP and Security Headers (public/_headers, index.html)

- CSP: Strict default-src, script-src 'self', worker-src 'self' blob:
- connect-src: Limited to known RPC endpoints
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Referrer-Policy: no-referrer
- Permissions-Policy: All features disabled

**Assessment:** SECURE

#### Password Validation (lib/validate.ts:44-61)

passwordAcceptable correctly enforces:
- Minimum length (10 characters)
- Minimum 2 character classes (lowercase, uppercase, digit, symbol)

**Assessment:** SECURE

---

## Summary Table

| ID | Severity | File | Issue |
|----|----------|------|-------|
| 1 | HIGH | vite.config.ts:21 | Sourcemap enabled in production |
| 2 | LOW | keystore.ts:21-23 | AAD JSON stringification order |
| 3 | INFO | wallet-store.ts:82-91 | BroadcastChannel per-event creation |
| 4 | INFO | worker.ts:290-303 | No origin validation (mitigated by CSP) |
| 5 | INFO | pearl-rpc.ts:81-88 | toFixed can throw on extreme values |
| 6 | INFO | balances.ts:75 | Partial pool label side-channel |
| 7 | INFO | Various | Missing COEP for SharedArrayBuffer |

---

## Conclusion

The v0.1.7 codebase demonstrates strong security engineering. The HIGH finding (sourcemap leakage) should be addressed before production deployment. All other findings are low-severity or informational and do not require immediate action.

**Recommendation:** Fix the sourcemap configuration in vite.config.ts before deploying to production. All other items can be addressed in future releases.

---

*Report generated: May 20, 2026*
*Auditor: MiniMax Model (Independent Security Review)*
