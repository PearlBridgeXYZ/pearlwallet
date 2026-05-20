# PearlWallet v0.1.6 Security Audit

## Executive Summary

Audit of PearlWallet v0.1.6 focusing on new v0.1.6 features: BroadcastChannel multi-tab sync, wipe(password) path, and activity-based auto-lock. Identified 1 Medium issue, 2 Low issues, and 1 Info note. No critical or high-severity vulnerabilities found in new code.

---

## Medium

### M1: BroadcastChannel listener leak on repeated init()

**File:** `src/state/wallet-store.ts:99-113`

**What's wrong:** The `init()` function creates a new `BroadcastChannel` and attaches an `onmessage` handler every time it's called, but never cleans up the previous channel. Since `init()` is called in `App.tsx` via `void init();` (line 19), and there's no guard preventing re-initialization, multiple channels accumulate in memory with stacked handlers.

```typescript
// App.tsx:19
void init();

// wallet-store.ts:99-113 - every init() call adds a NEW channel + handler
if (typeof BroadcastChannel !== "undefined") {
  try {
    const ch = new BroadcastChannel(KEYSTORE_BROADCAST_CHANNEL);
    ch.onmessage = async (ev: MessageEvent<KeystoreEvent>) => { ... };
  } catch { ... }
}
```

**Exploit path:** While benign (handlers just read from DB), this causes memory growth over time and duplicate event handling if multiple `init()` calls occur. Each duplicate handler will attempt to `cryptoWorker.reset()` and update state, potentially causing redundant operations.

**Fix:** Guard `init()` to run only once:
```typescript
let initialized = false;
async function init() {
  if (initialized) return;
  initialized = true;
  // ... existing init code
}
```

---

## Low

### L1: wipe() allows passwordless wipe when blob is null

**File:** `src/state/wallet-store.ts:196-207`

**What's wrong:** The `wipe(password)` function gates the password check behind `if (blob)`. When `status === "no-wallet"`, `blob` is null, so the password is never verified:

```typescript
async wipe(password) {
  const { blob } = get();
  if (blob) {
    // Password check only runs if blob exists
    await cryptoWorker.call<"exportMnemonic", { mnemonic: string }>(
      "exportMnemonic",
      { password, blob },
    );
  }
  // ... proceeds to wipe regardless
}
```

**Exploit path:** If a user visits Settings after their wallet was already wiped (or on a fresh browser where IndexedDB was cleared externally), clicking "Wipe" with any password succeeds. This is confusing UX and could trick users into thinking they wiped a wallet when none existed. While not a fund-loss vector (no funds to lose), it could be used socially.

**Fix:** Remove the `if (blob)` guard, or check `status`:
```typescript
async wipe(password) {
  const { blob, status } = get();
  if (status !== "no-wallet" && !blob) {
    throw new Error("E_NO_WALLET");
  }
  if (blob) {
    await cryptoWorker.call<"exportMnemonic", { mnemonic: string }>(
      "exportMnemonic",
      { password, blob },
    );
  }
  // ...
}
```

---

### L2: Clipboard auto-clear timer persists across page navigations

**File:** `src/ui/pages/Receive.tsx:72-86`

**What's wrong:** The `copy()` function schedules a 60-second timeout to clear the clipboard, but there's no cleanup when the component unmounts:

```typescript
setTimeout(async () => {
  try {
    const current = await navigator.clipboard.readText();
    if (current === copiedAddr) {
      await navigator.clipboard.writeText("");
    }
  } catch { ... }
}, 60_000);
```

**Exploit path:** Edge case: User copies address, navigates away, returns within 60s and copies something else. The old timeout fires and may clear the new clipboard content if it matches the old address (rare but possible). More importantly, orphaned timeouts consume minimal resources but represent sloppy cleanup.

**Fix:** Use a ref to track the timeout and clear on unmount:
```typescript
const clearTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

useEffect(() => {
  return () => {
    if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
  };
}, []);

async function copy() {
  // ... existing copy logic ...
  clearTimeoutRef.current = setTimeout(async () => { ... }, 60_000);
}
```

---

## Info

### I1: Considered and dismissed - BroadcastChannel message origin

The BroadcastChannel in `broadcastKeystoreEvent` doesn't verify message origin. This is **acceptable** because:
- BroadcastChannel is origin-scoped by browser security model
- Only pages on `pearlwallet.xyz` (or localhost) can send to this channel
- Same-origin pages are implicitly trusted in browser security model
- The listener already performs safe operations (reads from DB, calls reset())

### I2: Considered and dismissed - Auto-lock interval persists after navigation

The `setInterval` in App.tsx auto-lock effect has no cleanup, but this is **acceptable** because:
- The interval reads from `useWallet.getState()` (not React state), so it continues working correctly
- It becomes a no-op when `status !== "unlocked"` (does nothing, just checks)
- React component stays mounted (App is root), so interval doesn't leak across route changes
- Only a re-mount would cause a duplicate interval, which doesn't happen in normal SPA usage

### I3: Considered and dismissed - IntentExpectation binding in verifyRelayerMintSig

The v0.1.6 addition of `IntentExpectation` parameter to `verifyRelayerMintSig` is correctly implemented. The function:
- Checks deadline before RPC calls (cheap reject)
- Binds all payload fields to expected values
- Recovers signer and verifies RELAYER_ROLE on-chain
- Properly rejects expired/mismatched signatures

No issues found.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | M1: BroadcastChannel leak |
| Low | 2 | L1: wipe bypass, L2: clipboard timer leak |
| Info | 3 | Considered/dismissed items |

The new v0.1.6 features are generally well-implemented. The BroadcastChannel leak (M1) is the most impactful issue and should be fixed to prevent memory growth and potential handler stacking. The wipe bypass (L1) is low-risk (no funds at stake) but confusing UX. The clipboard timer (L2) is minor cleanup.
