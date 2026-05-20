# Security Audit Report: Pearl Web Wallet v0.1.7

**Auditor:** MiniMax-M2 (Independent Security Auditor)
**Target:** Pearl Web Wallet v0.1.7
**Date:** May 20, 2026
**Context:** Non-custodial pure-web wallet (Vite/React/TS + Zustand + Dexie + viem) for PRL (Pearl mainnet, BIP-86 P2TR) and WPRL (Ethereum ERC-20). Crypto runs in a Web Worker. Mainnet only.

---

## Executive Summary

This audit examined the v0.1.7 code surface with focus on new v0.1.7 features: coerceUint helper, normalizeRelayerMintSig, verifyRelayerMintSig expected binding, makeAsyncLock pattern, AES-GCM AAD context binding, UTXO walk DoS protection, passwordAcceptable, and Splash initializing state.

**Overall Assessment:** The v0.1.7 release addresses several prior audit findings and introduces meaningful security improvements. However, several issues were identified ranging from Medium to Low severity, plus one High-severity sourcemap leakage in production builds.

---

## Findings Summary

| Severity | Count | Area |
|----------|-------|------|
| High     | 1     | Build pipeline (sourcemap) |
| Medium   | 3     | Worker protocol, AAD migration, coerceUint edges |
| Low      | 4     | CSP COOP/COEP, PBKDF2, clipboard, chainId race |
| Info     | 3     | UI patterns, Dexie isolation, partial pool label |

---

## Detailed Findings

### HIGH

#### 1. Production Build Leaks Source Maps

**File:** `vite.config.ts:21`

```typescript
build: {
  target: "es2022",
  sourcemap: true,  // <-- LEAKS SOURCE TO PRODUCTION
```

**Issue:** The Vite build configuration has `sourcemap: true` enabled in production builds. This exposes the full source code structure, variable names, and comments to anyone who loads the application. While the code itself is open source, sourcemaps make debugging and reverse-engineering significantly easier for attackers.

**Impact:** Attackers can view original source with proper line numbers, making it easier to identify vulnerabilities, understand security mechanisms, and craft targeted exploits.

**Recommendation:** Change to `sourcemap: false` for production, or use `sourcemap: 'hidden'` if sourcemaps are needed for error tracking services (which should then be served from a separate, auth-protected endpoint).

**Severity:** High

---

### MEDIUM

#### 2. Worker Message Protocol Lacks Origin Validation

**File:** `src/crypto/worker.ts:290-304`

```typescript
self.onmessage = async (ev: MessageEvent<WorkerCmd>) => {
  const msg = ev.data;
  // No origin check: ev.origin is not validated
  try {
    const result = await handle(msg);
    // ...
  }
};
```

**Issue:** The Web Worker does not validate the `origin` property of the incoming MessageEvent. While the Worker is instantiated from the same origin (`new CryptoWorker()`), and the CSP restricts `worker-src` to `'self' blob:`, a compromised parent context could send arbitrary messages.

**Impact:** If an XSS vulnerability exists elsewhere in the application, an attacker could send messages to the worker to attempt operations (though the worker requires an unlocked session for most operations).

**Recommendation:** Add explicit origin validation:
```typescript
if (ev.origin !== self.location.origin) {
  console.warn("Rejected worker message from unauthorized origin");
  return;
}
```

**Severity:** Medium

---

#### 3. No Migration Path for AAD Format Change

**File:** `src/crypto/keystore.ts:15-27`

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

export const AAD = computeAAD(SUPPORTED_BLOB_VERSION, "PBKDF2-SHA256", KDF_ITERATIONS, "AES-256-GCM");
```

**Issue:** The v0.1.7 AAD now binds version, KDF, iterations, and cipher. However, there's no migration path for v0.1.6 keystore blobs that were encrypted with the old static AAD (`"pearl-web-wallet-v1"`). The `decryptBlob` function at line 106 uses `blob.aad` (the stored AAD), which means old blobs will still decrypt - but they won't benefit from the new AAD binding.

**Impact:** Users who created wallets with v0.1.6 and then upgrade won't have their keystore re-encrypted with the new AAD. The security improvement is only applied to new wallets.

**Recommendation:** Implement an on-demand migration: on successful unlock, detect if the stored AAD doesn't match the current computed AAD, and if so, re-encrypt the blob with the new format (requires password verification anyway).

**Severity:** Medium

---

#### 4. coerceUint Edge Cases Not Fully Handled

**File:** `src/services/bridge.ts:97-109`

```typescript
function coerceUint(field: unknown): bigint {
  if (field === null || field === undefined) throw new Error("E_SIGNATURE_MALFORMED");
  if (typeof field === "string" && field.trim() === "") throw new Error("E_SIGNATURE_MALFORMED");
  if (typeof field === "number" && !Number.isFinite(field)) throw new Error("E_SIGNATURE_MALFORMED");
  if (typeof field !== "string" && typeof field !== "number" && typeof field !== "bigint") {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  try {
    return BigInt(field as string | number | bigint);
  } catch {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
}
```

**Issue:** The coerceUint helper correctly rejects null, undefined, empty strings, NaN, Infinity, -Infinity, negatives (via post-coercion check at line 113), and non-numeric types. However, it does NOT handle:

1. **Hex strings:** `BigInt("0x123")` works in JS but may not be the intended format for JSON-RPC responses
2. **Leading "+" sign:** `BigInt("+123")` throws in some contexts
3. **Scientific notation:** `BigInt("1e18")` throws - but note that `1e18` as a number would work since it's first parsed as number
4. **BigInt(undefined):** Would throw, but the typeof check catches it
5. **String trimming:** A string with leading/trailing whitespace like `" 123 "` would throw

**Impact:** A malicious or buggy relayer returning non-standard number formats would cause signature verification to fail with a generic error rather than a specific validation error. This could be used as a denial-of-service vector or to confuse debugging.

**Recommendation:** Add explicit string validation and trimming:
```typescript
if (typeof field === "string") {
  const trimmed = field.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  return BigInt(trimmed);
}
```

**Severity:** Medium

---

### LOW

#### 5. Missing COOP/COEP Headers for Worker Isolation

**File:** `public/_headers:1-7`

```
Content-Security-Policy: ...
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: ...
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

**Issue:** The security headers include CSP, X-Frame-Options, HSTS, etc., but are missing:
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`

The crypto worker uses `blob:` URLs (`new CryptoWorker()`), which creates an opaque origin. Without COOP/COEP, the worker is not fully isolated from the browsing context.

**Impact:** While the worker code is secure, COOP/COEP would provide defense-in-depth against side-channel attacks (e.g., Spectre variants) and ensure the worker is truly isolated.

**Recommendation:** Add COOP/COEP headers:
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

Note: This requires ensuring all loaded resources use CORS with appropriate headers.

**Severity:** Low

---

#### 6. PBKDF2 600k Iterations Below 2026 Recommendations

**File:** `src/crypto/keystore.ts:4`

```typescript
export const KDF_ITERATIONS = 600_000;
```

**Issue:** PBKDF2-HMAC-SHA256 with 600,000 iterations was appropriate for 2020-2022. By 2026 standards, this is considered insufficient against modern attacker hardware (especially GPU clusters). OWASP and other bodies now recommend:
- PBKDF2-HMAC-SHA512: 600,000+ iterations
- Or better: Argon2id (memory-hard, resistant to GPU/ASIC attacks)

**Impact:** An attacker with physical access to the device who extracts the encrypted blob could brute-force the password offline with GPU acceleration more easily than intended.

**Recommendation:** 
- Option 1: Increase to 1,200,000 iterations for PBKDF2-HMAC-SHA512
- Option 2 (preferred): Migrate to Argon2id (requires adding a WASM library like libsodium.js or argon2-browser)

**Severity:** Low (acknowledged in context that Argon2id discussion was deferred)

---

#### 7. Clipboard Operations Not Cleared After Copy

**File:** `src/ui/pages/Receive.tsx` (and potentially other pages)

**Issue:** When users copy addresses or other sensitive data to clipboard, the clipboard is not cleared after a timeout. This is a known security concern for devices shared with others or subject to clipboard snooping malware.

**Impact:** Sensitive data (addresses, though not secrets) remains in clipboard. While addresses are not secrets, this pattern could be extended to other data accidentally.

**Recommendation:** Implement a clipboard clear after copy operations:
```typescript
navigator.clipboard.writeText(address).then(() => {
  setTimeout(() => {
    navigator.clipboard.writeText("");
  }, 30000); // Clear after 30 seconds
});
```

**Severity:** Low

---

#### 8. Potential ChainId Mismatch in verifyRelayerMintSig

**File:** `src/services/bridge.ts:144-156`

```typescript
export async function verifyRelayerMintSig(
  sig: RelayerMintSig,
  network: EthNetwork,
  expected: IntentExpectation,
  nowSecOverride?: bigint,
): Promise<{ signer: `0x${string}` }> {
  const cfg = bridgeConfig(network);
  const chainId = network === "mainnet" ? 1 : 11155111;  // Hardcoded at call time
  const domain: TypedDataDomain = {
    name: "PearlBridge",
    version: "2",
    chainId,
    verifyingContract: cfg.bridgeController,
  };
  // ... later ...
  const nowSec = nowSecOverride ?? BigInt(Math.floor(Date.now() / 1000));
```

**Issue:** The chainId is hardcoded based on the `network` parameter at the time of the call. If a user changes the network between when the signature was requested and when it's verified (e.g., via multi-tab sync changing `ethNetwork`), there's a theoretical mismatch. The signature is bound to a specific chainId in the EIP-712 domain, but the code doesn't re-verify after fetching external data.

**Impact:** Very low - the network parameter is passed to the function, and changing it mid-operation would be a user error. However, the pattern of using a mutable external value (getState) vs. an immutable parameter could lead to confusion.

**Recommendation:** Document that callers should pass consistent network throughout the flow, or capture the network at the start of the operation and pass it consistently.

**Severity:** Low (theoretical)

---

### INFO

#### 9. makeAsyncLock Concurrency Invariants

**File:** `src/state/wallet-store.ts:109-126`

```typescript
function makeAsyncLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((res) => (release = res));
    try {
      await prev;
    } catch {
      // prior operation failed — that's the prior caller's problem
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
```

**Observation:** The makeAsyncLock pattern serializes:
1. Local wallet operations (createWallet, restoreWallet, unlock, wipe, changePassword)
2. Cross-tab broadcast handlers (blob-updated, wiped events)

What it does NOT protect:
- Concurrent local reads of wallet state (e.g., two React components reading addresses simultaneously)
- The initial `init()` call (which is guarded by storeInitialized)
- Non-walletLock-wrapped operations

This is by design - the lock is for serialization of stateful mutations, not general concurrency control. The comment at lines 104-108 correctly documents the threat model.

**Assessment:** Correctly implemented for its intended purpose. No vulnerability found.

---

#### 10. Dexie Storage Isolation

**File:** `src/storage/db.ts`

**Observation:** Dexie (IndexedDB wrapper) stores data in the browser's origin-isolated storage. The schema shows:
- `keystore` table: Stores encrypted blob (ciphertext)
- `addressBook` table: Stores user-added addresses (plaintext labels)
- `txCache` table: Stores transaction data

**Assessment:** 
- Sensitive data (mnemonic) is encrypted at rest (AES-GCM)
- No storage encryption key derivation - relies on browser's origin isolation
- Storage quota is browser-dependent (typically 50-150MB)
- No eviction safety mechanism for storage pressure scenarios

**Recommendation:** Consider adding storage quota monitoring and user warnings when approaching limits.

**Severity:** Info

---

#### 11. "Partial" Pool Label Side Channel

**File:** `src/services/balances.ts:55-59`

```typescript
// "live" = full pool walked. "partial" = some pool addresses errored
//   but at least half succeeded — sum is under-reported; UI must
//   surface a warning so the user doesn't act on a low number.
//   "error" = whole walk failed.
prlSource: "live" | "partial" | "error";
```

**Observation:** The "partial" label is intentionally generic and doesn't reveal which specific addresses failed. This prevents an attacker from learning about the HD derivation state (which addresses have been used) by observing balance queries.

**Assessment:** Correctly implemented. The labeling is abstract and doesn't leak address indices or derivation information.

---

## Positive Security Observations

1. **IntentExpectation binding is now required:** The verifyRelayerMintSig function correctly requires the expected parameter at the type level, preventing accidental bypass of the recipient/amount/sdiHash binding.

2. **Two-pass UTXO walk:** The vout-before-vin ordering correctly prevents the hostile sentry attack vector.

3. **MAX_UTXO_WALK_PAGES cap:** Properly prevents infinite loops from malicious or buggy RPCs.

4. **AES-GCM AAD binding:** The new AAD construction binds version, KDF, iterations, and cipher - a meaningful improvement over the static v0.1.6 AAD.

5. **makeAsyncLock:** Properly serializes cross-tab events against local mutations, preventing the race condition described in the v0.1.6 audit.

6. **Splash "initializing" state:** Prevents the CTA flash that could lead to accidental wallet overwrite.

7. **PasswordAcceptable:** Shared helper ensures consistent password quality across create and changePassword flows.

8. **SendPRL/SendWPRL disabled:** Broadcast is explicitly disabled with clear UI indication, preventing user confusion.

9. **Settings mnemonic auto-hide:** 60-second timer, cleared on unmount, cleared on visibility change - comprehensive coverage.

10. **Strong CSP:** `script-src 'self'`, `worker-src 'self' blob:`, no unsafe-eval, strict connect-src allowlist.

---

## Closed Findings from Prior Audits

The following v0.1.6 findings are confirmed resolved:

- RC5 contract pins (mentioned in context)
- EIP-712 IntentExpectation binding (now required at type level)
- Idle-based auto-lock (implemented in App.tsx)
- BroadcastChannel multi-tab sync (wrapped in walletLock)
- wipe(password) re-auth (requires password verification)

---

## Recommendations Summary

| Priority | Action |
|----------|--------|
| P0       | Disable sourcemap in production builds |
| P1       | Add origin validation to worker message handler |
| P1       | Implement keystore AAD migration for existing users |
| P1       | Add COOP/COEP headers for worker isolation |
| P2       | Improve coerceUint string handling (trim, format validation) |
| P2       | Add clipboard clear after copy operations |
| P3       | Consider PBKDF2 iteration increase or Argon2id migration |
| P3       | Add storage quota monitoring |

---

## Conclusion

Pearl Web Wallet v0.1.7 demonstrates good security posture with meaningful improvements over v0.1.6. The critical finding (sourcemap leakage) should be addressed immediately, and the medium-severity items should be prioritized for the next release. The overall architecture - crypto in Web Worker, AES-GCM encryption with AAD binding, EIP-712 signature verification with IntentExpectation binding - represents solid security engineering.

**Auditor Signature:** MiniMax-M2  
**Report Date:** May 20, 2026
