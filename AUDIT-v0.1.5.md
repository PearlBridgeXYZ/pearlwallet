# PearlWallet v0.1.5 Security & Quality Audit
**Date:** 2026-05-20
**Auditor:** Claude Code
**Scope:** Delta against v0.1.0 baseline (`AUDIT-2026-05-19.md`) — new and previously-missed findings in v0.1.5
**Baseline:** v0.1.0 audit closed Math.random tx hashes, EIP-712 verifier + RELAYER_ROLE check, 15s relay timeout, CSP gap (relay + sentry). v0.1.3 set HD coin_type 808276. v0.1.4 added pearlAddressPool + serialized sentry walk. v0.1.5 added mnemonic auto-wipe (60s + unmount) and a visible auto-lock countdown sharing a single `AUTO_LOCK_MS` source of truth.

---

## Executive Summary

**Overall Risk Assessment: HIGH** — driven by one critical contract-address staleness issue. **There is one Critical finding and one High finding.**

The v0.1.5 codebase is otherwise solid. The mnemonic auto-wipe and lock countdown work as designed, share a single constant, and clean up on unmount. The keystore migration path from v0.1.2 records to v0.1.4's `pearlAddressPool` is correctly implemented in `wallet-store.ts:159-170` and self-upgrades on the next unlock. Crypto dependencies are unchanged from the baseline good-practice list. CSP in `public/_headers` correctly allows `rpc.pearlwallet.xyz`, `ethereum-rpc.publicnode.com`, `eth.drpc.org`, and `pearlbridge.xyz` — matching exactly what the code fetches.

The Critical finding is a contract-address staleness: the on-chain RC5 redeploy on 2026-05-19 superseded the WPRL and BridgeController addresses that the wallet still ships. The High finding is a payload-binding gap in the relayer signature verifier — the verifier confirms the signer holds `RELAYER_ROLE` but does not assert the signed `recipient`/`amount`/`sdiHash` match the user's submitted intent, leaving a future-v0.2 broadcast path vulnerable to relayer substitution attacks.

The remaining items are Medium/Low/Info quality issues.

---

## Critical Issues

### 1. STALE CONTRACT ADDRESSES — RC3 SHIPPED, RC5 IS LIVE
**Severity:** CRITICAL
**File:** `src/chains/ethereum/network.ts:21-34`

```typescript
export const WPRL_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0xbE0DDDD4d064Ae941EA379b651fEF0317af5387e",  // RC3 — DECOMMISSIONED
  sepolia: "0x0000000000000000000000000000000000000000",
};

export const BRIDGE_ROUTER_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0x5b2C49f1B253dFbD404CeEe2843979a977ba4009",  // RC3 — DECOMMISSIONED
  sepolia: "0x0000000000000000000000000000000000000000",
};
```

PearlBridge redeployed to RC5 on 2026-05-19. Canonical mainnet addresses are now:
- WPRL proxy: `0x07696DcaB55E62cfef953666b29Fe1970518cB00`
- BridgeController: `0xA6571B73489d4eBFA269a107208665dF7C80Aef5`
- Timelock: `0xc07c5b10fa35c0db94ab47484b9f667b7b649762` (24h, Safe-proposer)

The wallet reads `WPRL_ADDRESS.mainnet.balanceOf()` on every dashboard refresh (`balances.ts:73 → bridge.ts:133`) and `BRIDGE_ROUTER_ADDRESS.mainnet.mintFeeBps()/burnFeeBps()` on Bridge page mount (`Bridge.tsx:31`). Against the decommissioned RC3 contracts these will either return stale values or revert if RC3 is paused per the decommission plan. WPRL balances will read `0` against the RC3 proxy after its `totalSupply` is migrated, silently displaying empty balances for users who hold WPRL on the RC5 contract.

**Why it matters:** Wallet behavior diverges from PearlBridge's canonical state. A user with real WPRL on RC5 will see "0 WPRL" and conclude their funds are lost. If the v0.2 broadcast lands without this update, the wallet will sign transfers to a dead contract.

**Fix:**
```typescript
export const WPRL_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0x07696DcaB55E62cfef953666b29Fe1970518cB00",
  sepolia: "0x0000000000000000000000000000000000000000",
};
export const BRIDGE_ROUTER_ADDRESS: Record<EthNetwork, `0x${string}`> = {
  mainnet: "0xA6571B73489d4eBFA269a107208665dF7C80Aef5",
  sepolia: "0x0000000000000000000000000000000000000000",
};
```
Also bump the EIP-712 domain version if RC5 increments it (verify against the deployed BridgeController's `eip712Domain()` view); `bridge.ts:65` currently hardcodes `version: "2"`. Add a runtime self-check on Dashboard mount: `eth_getCode(WPRL_ADDRESS.mainnet)` and surface a banner if it returns `0x`.

---

## High-Severity Issues

### 1. RELAYER SIGNATURE VERIFIER DOES NOT BIND PAYLOAD TO USER INTENT
**Severity:** HIGH
**File:** `src/services/bridge.ts:57-83, 170-177`

`verifyRelayerMintSig()` confirms the signature recovers to an address holding `RELAYER_ROLE` on BridgeController. It does **not** assert that the signed `payload.recipient`, `payload.amount`, or `payload.sdiHash` match what the user actually deposited. `getMintSignature()` returns whatever the relay says, the verifier rubber-stamps any role-holder signature, and the caller has no contractual guarantee the mint goes where the user expected.

```typescript
// Current: verifies signer role only
const signer = await recoverTypedDataAddress({ domain, types: MINT_TYPES, primaryType: "Mint", message: sig.payload, signature: sig.signature });
const hasRole = await controller.read.hasRole([RELAYER_ROLE, signer]);
if (!hasRole) throw new Error("E_SIGNATURE_NOT_FROM_RELAYER");
return { signer };
```

If a relayer key is compromised — or if the relay backend is MITM'd in a way that lets an attacker swap `recipient` after the user posts their SDI — the wallet would broadcast a mint to the attacker's address. This is the exact loss-of-funds vector the v0.1.0 audit flagged ("Also validate that the intent ID, recipient, amount, and network in the signature match the user's original submission"); only the role check was actually shipped in v0.1.1.

The bridge UI in v0.1.5 is stubbed (`Bridge.tsx:56-60` returns an error string), so this is not exploitable today. But `verifyRelayerMintSig` is exported and will be the trust gate when v0.2 wires broadcast — shipping the gap pre-broadcast leaves it easy to overlook.

**Fix:** Extend `verifyRelayerMintSig` to take the user's expected intent and assert payload equality:
```typescript
export async function verifyRelayerMintSig(
  sig: RelayerMintSig,
  expected: { recipient: `0x${string}`; amount: bigint; sdiHash: `0x${string}` },
  network: EthNetwork = "mainnet",
): Promise<{ signer: `0x${string}` }> {
  if (sig.payload.recipient.toLowerCase() !== expected.recipient.toLowerCase()) throw new Error("E_PAYLOAD_RECIPIENT_MISMATCH");
  if (sig.payload.amount !== expected.amount) throw new Error("E_PAYLOAD_AMOUNT_MISMATCH");
  if (sig.payload.sdiHash.toLowerCase() !== expected.sdiHash.toLowerCase()) throw new Error("E_PAYLOAD_SDIHASH_MISMATCH");
  if (sig.payload.deadline < BigInt(Math.floor(Date.now() / 1000))) throw new Error("E_SIGNATURE_EXPIRED");
  // ...existing recover + hasRole check
}
```
Also add a unit test that feeds a valid-by-role but recipient-swapped payload and asserts `E_PAYLOAD_RECIPIENT_MISMATCH`. No tests reference `verifyRelayerMintSig`, `getMintSignature`, or `postSdiIntent` today (zero coverage).

---

## Medium-Severity Issues

### 1. ONBOARDING OVERWRITES EXISTING KEYSTORE WITHOUT WARNING
**Severity:** MEDIUM
**Files:** `src/ui/pages/Splash.tsx:18-23`, `src/state/wallet-store.ts:107-115, 138`

Splash links straight to `/onboarding/create` and `/onboarding/restore` regardless of whether a keystore already exists. Both flows end at `saveKeystore(rec)` which `db.keystore.put(rec)` overwrites the `"primary"` record (storage/db.ts:78). A user who already owns a wallet, clicks "Create a new wallet" from Splash, and completes onboarding will silently destroy their old encrypted blob. If they hadn't written the previous mnemonic down, the old wallet is gone — no recovery.

The "Unlock existing wallet" link is shown when `hasWallet`, but the destructive paths sit above it with equal prominence. The "Restore from recovery phrase" button is also unguarded — a fat-finger phrase that happens to validate as BIP-39 will overwrite the live keystore.

**Fix:** Gate Create and Restore behind a confirmation if `status !== "no-wallet"`:
```tsx
{hasWallet && (
  <p className="text-sm text-amber-600">
    You already have a wallet on this device. Creating or restoring will
    permanently replace it. Make sure you have your recovery phrase first.
  </p>
)}
```
Or stronger: redirect Create/Restore to `/unlock` when `hasWallet`, and only allow keystore replacement from the explicit `Settings → Wipe` flow that already requires typed confirmation.

---

### 2. PEARL UTXO PAGE-ORDER ASSUMPTION IN BALANCE WALKER
**Severity:** MEDIUM
**File:** `src/services/pearl-rpc.ts:95-131`

`fetchPrlBalanceGrains` pages `searchrawtransactions` (PAGE=100, increasing `skip`) and folds into a UTXO map by adding vouts and deleting vins. The correctness of `utxo.delete(\`${vin.txid}:${vin.vout}\`)` depends on the spending tx appearing on a **later or same** page than the funding tx — otherwise the delete is a no-op on an empty map and the funding output gets added afterwards as a phantom unspent UTXO.

btcd's `searchrawtransactions` returns transactions in mempool-then-chain order, oldest-first by block height within the chain. For a well-behaved server that ordering holds and the algorithm is correct. But if the sentry is patched, sharded, or returns results in any order other than monotonic-oldest-first, the balance will be over-reported (spent outputs treated as live). There's no on-chain confirmation check that would reject this — the value just shows up as the user's balance.

**Fix:** Either:
- Two-pass: build the UTXO set in pass 1 (`addr` outputs only), then in pass 2 mark spent any UTXO whose `(txid, vout)` matches a `vin` in any tx touching the address. Both passes iterate the same paginated walk; correctness no longer depends on page order.
- Or: switch to a `getaddressutxos`-style RPC if the sentry exposes one (single call, server-side correct).

Add a test fixture that feeds the pages newest-first and asserts the balance is correct.

---

## Low-Severity Issues

### 1. LOCKED WALLET LINKS TO `/settings` THAT REDIRECTS TO `/unlock`
**Severity:** LOW
**File:** `src/ui/pages/Unlock.tsx:53-55`

The Unlock page offers "Wipe this wallet" linking to `/settings`. `App.tsx:59-61` redirects any non-`/unlock` path to `/unlock` when the wallet is locked, so the link is a no-op visible loop: click → land back on Unlock. A user trying to wipe a wallet whose password they've forgotten cannot reach the Settings wipe flow without first unlocking, which is exactly what they can't do.

**Fix:** Either add a Settings-style wipe affordance directly to the locked Unlock page (typed "wipe my wallet" + button, no password required since the keystore is already encrypted), or whitelist `/settings` in the locked-state redirect with the page rendering only the wipe section when locked. The first option is cleaner — locked-state wipe doesn't need any of the other settings.

---

### 2. WORKER `reset()` DROPS IN-FLIGHT PROMISES ON LOCK
**Severity:** LOW
**File:** `src/crypto/worker-client.ts:43-49`

```typescript
reset(): void {
  if (this.worker) { this.worker.terminate(); this.worker = null; }
  this.inflight.clear();  // ← pending promises never resolve or reject
}
```

If the user clicks Lock (or auto-lock fires) while an unlock/createWallet/exportMnemonic call is in flight, the worker is terminated and the entry is removed from the inflight map without calling `reject()`. The awaiter hangs forever. In practice this is a UX glitch — the spinner spins until tab close — not a security issue. But it does mean a `submit()` in OnboardingCreate could be sitting on a dead promise while React state thinks it's still busy.

**Fix:**
```typescript
reset(): void {
  if (this.worker) { this.worker.terminate(); this.worker = null; }
  for (const { reject } of this.inflight.values()) {
    reject(new Error("E_WORKER_RESET"));
  }
  this.inflight.clear();
}
```

---

### 3. TIP MINIMUM (1 PRL) CAN EXCEED THE SEND AMOUNT
**Severity:** LOW
**File:** `src/chains/pearl/tip.ts:24-30`

`TIP_MIN_GRAINS = 100_000_000n` (1 PRL). For a 0.5 PRL send the user would owe a 1 PRL tip — 200% of the principal. The tip is opt-in and Settings shows the policy in plain English, but a user sending small amounts probably doesn't realize the floor dominates micro-sends.

**Fix:** Cap the floor at the bps tip OR a per-send max-percentage (e.g. `min(TIP_MIN_GRAINS, sendAmount * 0.05)`); or skip the floor when `sendAmount < TIP_MIN_GRAINS * 10`. Surface a UI line in the SendPRL preview ("This tip is 200% of your send — consider unchecking") when the tip exceeds say 10% of the principal.

---

### 4. RECEIVE PAGE EXPOSES ADDRESS POOL TO CLIPBOARD WITHOUT INDEX FEEDBACK
**Severity:** LOW
**File:** `src/ui/pages/Receive.tsx:29-37`

`navigator.clipboard.writeText(addr)` puts an address on the system clipboard with no auto-clear. Standard behavior for a wallet, but the "Copied!" indicator only lasts 1.5s and doesn't include which pool index was copied. A user who switches the pool index (line 110: `setPrlIndex(i)`) and then copies could be unsure which address ended up on the clipboard. Combine with a malicious clipboard manager and the user could send to the wrong derived address — funds still recoverable (same seed), but they'd appear "lost" until they look at receive-pool aggregation.

**Fix:** Include the index in the "Copied!" toast: `Copied address #${prlIndex}`. Optionally, clear the clipboard after N seconds (Firefox/Chrome support this via Clipboard API permissions but is platform-conditional).

---

## Info-Level Findings

### 1. v0.1.5 NEW CODE — TopBar countdown + mnemonic auto-wipe
**Verdict:** CLEAN.

`TopBar.tsx`'s 1Hz `setInterval` is properly gated by `status === "unlocked"` and cleaned up in the `useEffect` teardown. The cost is negligible (single `setState` per second; React 18 batches). `AUTO_LOCK_MS` is exported from `wallet-store.ts` and consumed by both `App.tsx:46` (auto-lock check) and `TopBar.tsx:28` (countdown) — no duplication.

Settings.tsx mnemonic timer has belt-and-braces cleanup: the explicit `clearMnemonicTimer()` in both the `setInterval` body (when seconds hit 0) and the `useEffect` cleanup on unmount. The mnemonic state is set to `null` 60s after reveal AND the password input is cleared. The Hide button calls `hideMnemonic()` which performs the same cleanup. No re-render storms — the per-second setState updates a local `mnemonicSecondsLeft` only, no parent re-renders.

### 2. KEYSTORE MIGRATION v0.1.2 → v0.1.4 — CONFIRMED CLEAN
The `unlock()` reducer in `wallet-store.ts:148-173` correctly handles legacy records: `pearlAddressPool` is optional in `KeystoreRecord.publicData` (db.ts:28), `init()` falls back to `[rec.publicData.pearlAddress]` if missing (wallet-store.ts:75), and `unlock()` writes the freshly-derived pool back to the keystore on the next unlock. A v0.1.2-era keystore unlocks cleanly without user action. Verified path via code read; no test fixture covers the migration explicitly — adding one would be cheap insurance.

### 3. CRYPTO DEPS UNCHANGED FROM v0.1.0 BASELINE
package-lock.json: `viem 2.21.19`, `@noble/curves 1.6.0`, `@noble/hashes 1.5.0`, `@scure/base 1.1.9`, `@scure/bip32 1.5.0`, `@scure/bip39 1.4.0`, `@scure/btc-signer 1.4.0` — all exact-pinned, identical to the baseline. No transitive crypto-library bumps. No known CVEs against these versions.

### 4. CSP IN `public/_headers` ALIGNED WITH CODE
`connect-src` allows: `'self'`, `rpc.pearlwallet.xyz`, `ethereum-rpc.publicnode.com`, `eth.drpc.org`, `pearlbridge.xyz`. Code fetches (grepped): pearl RPC (`pearl-rpc.ts:54`), ETH RPCs via viem fallback (`rpc.ts:7`), relay (`bridge.ts:156, 172`), and the same-origin `/api/prl-price` proxy. All covered. CSP no longer needs `pearl-sentry-fsn1-1.pearlbridge.xyz` since the wallet uses the Cloudflare-fronted `rpc.pearlwallet.xyz` instead.

### 5. CONSIDERED AND DISMISSED — `setError(String(e))` ERROR LEAKAGE
`OnboardingCreate.tsx:44, 89`, `OnboardingRestore.tsx:65`, `Settings.tsx:83, 119`, etc. all do `setError(e instanceof Error ? e.message : String(e))`. Worker errors are either `E_PASSWORD_WRONG` (intentionally generic) or HD-derivation messages like "HD derivation failed at pearl receive index 3" — no key material or sensitive paths exposed. No leak.

### 6. CONSIDERED AND DISMISSED — `Number(balance) / 1e8` PRECISION
`Dashboard.tsx:19, 34` converts bigint balances to JS Number for USD multiplication. Precision is lost above `Number.MAX_SAFE_INTEGER` (2^53). For PRL that ceiling is ~90M PRL; for WPRL ~9M WPRL. Realistic for retail; only an issue for whales. The display is informational (USD estimate), not used in transaction construction, so even at lost precision the worst case is a slightly wrong USD figure — not a fund-loss vector.

### 7. CONSIDERED AND DISMISSED — `functions/api/prl-price.ts` median weighting
The `Math.floor(qty)` repetition for quantity-weighting (line 67) could push many entries for a large offer (1M PRL ask = 1M array entries). It runs server-side in a CF Pages Function with a 30s edge cache, so the CPU cost is amortized across all requests in that window. Not a wallet-side concern. If pearl-otc.com surfaces 100M+ PRL asks the function could OOM; consider replacing with proper VWAP arithmetic (sum px*qty / sum qty) for safety, but it's a server-side fix, not in scope for the wallet audit.

### 8. CONSIDERED AND DISMISSED — Mock-mode regression
v0.1.2 removed mock mode. Confirmed: no `mockMode` references in `src/`, the v0.1.0 audit's LOW#3 ("mock mode indicator") no longer applies, and `ui-store.ts` has no mockMode property.

### 9. CONSIDERED AND DISMISSED — Single-string `pearlAddrs` legacy path
`balances.ts:59` accepts `string | string[]`. Callers in `Dashboard.tsx:13` pass `pearlPool` array. The single-string path exists for tests and the v0.1.2 migration window. No code in v0.1.5 calls it with a string from the UI. Harmless.

### 10. CONSIDERED AND DISMISSED — Worker key material disposal on lock
`crypto/worker.ts:37-42` wipes private keys with `.fill(0)` before nulling the session, and `worker-client.ts:reset()` terminates the entire worker. Defense-in-depth: the actual `Uint8Array.fill(0)` zeroes V8-allocated memory but the JS engine may have other references the GC hasn't collected. Worker termination is the real cleanup; the explicit fill is belt-and-braces. Correct as written.

---

## Recommendations for v0.1.6

1. **Blocker:** Bump RC3 → RC5 contract addresses in `ethereum/network.ts`. Verify the EIP-712 domain `version` field against the deployed BridgeController's `eip712Domain()` and update `bridge.ts:65` if needed. Add a runtime `eth_getCode` self-check on dashboard mount.
2. **Blocker (forward-looking):** Extend `verifyRelayerMintSig` with the payload-equality and deadline checks before any v0.2 broadcast lands. Add a test feeding a role-valid but recipient-swapped payload.
3. **Before v0.2 broadcast:** Gate Splash's Create/Restore links behind an "existing wallet present" warning. Make `reset()` reject pending promises. Test the pearl-rpc UTXO walker against newest-first page ordering.
4. **Polish:** Per-send tip cap, copy-toast index feedback, locked-wallet wipe path from Unlock.

---

## Compliance Checklist

| Item                                                | Status     | Notes                                                              |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| No `eval` / `Function()` / `dangerouslySetInnerHTML`| PASS       | Grep clean across `src/`                                           |
| No hardcoded secrets                                | PASS       | Only public contract addresses                                     |
| PBKDF2 ≥ 600k                                       | PASS       | `KDF_ITERATIONS = 600_000`                                         |
| AES-GCM unique IV per encryption                    | PASS       | Fresh `crypto.getRandomValues` per `encryptPlaintext`              |
| WebCrypto-only enforcement                          | PASS       | `requireCrypto()` throws on absence                                |
| BIP-86 P2TR correct                                 | PASS       | (Unchanged from v0.1.0 audit; pearl/address.ts verified)           |
| EIP-55 checksum correct                             | PASS       | (Unchanged from v0.1.0 audit)                                      |
| HD coin_type matches btcd-oyster (808276)           | PASS       | v0.1.3                                                             |
| Multi-address pool aggregation                      | PASS       | v0.1.4 + tests in `tests/balances.test.ts`                         |
| Mnemonic auto-wipe (60s + unmount)                  | PASS       | v0.1.5, Settings.tsx:45-96                                         |
| Auto-lock countdown shares `AUTO_LOCK_MS`           | PASS       | Single export in wallet-store.ts:19                                |
| CSP `connect-src` complete                          | PASS       | `_headers` covers rpc.pearlwallet.xyz + drpc + publicnode + bridge |
| Relay fetch timeout (15s)                           | PASS       | `RELAY_FETCH_TIMEOUT_MS = 15_000`                                  |
| Relayer signature verifier exists                   | PASS       | `verifyRelayerMintSig`                                             |
| Relayer signature binds to user intent              | **FAIL**   | High #1 — payload not asserted against expected                    |
| Contract addresses match canonical mainnet deploy   | **FAIL**   | Critical #1 — RC3 addresses, RC5 is live                           |
| Mock-mode removed from production build             | PASS       | v0.1.2                                                             |
| Crypto dependencies pinned (exact)                  | PASS       | Unchanged from baseline                                            |
| Strict TypeScript + `--max-warnings 0`              | PASS       | tsconfig + lint config unchanged                                   |
| External links carry `rel=noopener`                 | PASS       | Splash, About                                                      |

---

## Final Assessment

**Readiness for Public Use: BLOCKED on Critical #1.**

The wallet is a single line-change away from being usable against the canonical RC5 deployment. The High #1 payload-binding gap is forward-looking (no UI caller today) but should land before any v0.2 broadcast wires up `getMintSignature` → on-chain mint. The remaining Medium/Low/Info items are polish that won't block release.

Fix Critical #1, ship v0.1.6. Then close High #1 before v0.2 broadcast.

**Audit Date:** 2026-05-20
**Auditor:** Claude Code
**Confidence:** HIGH — full codebase reviewed, all v0.1.5 deltas verified against baseline.
