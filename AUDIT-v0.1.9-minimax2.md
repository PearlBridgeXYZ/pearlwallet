# Pearl Web Wallet v0.1.9 Security Audit — Pass 4 (Minimax2)
## UX Attack Surface, Privacy, Threat Model Gaps

**Audit Date:** 2026-05-20  
**Commit:** 6935c6e (v0.1.9)  
**Auditor Focus:** User experience attack surface, privacy leaks, threat model gaps, address handling, fee/gas dynamics, cross-chain confusion, recovery/onboarding flow.  
**Scope:** Independent of prior passes (Opus1, Opus2, Minimax1).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 5 |
| Low | 4 |
| Info | 2 |
| **Total** | **13** |

---

## Findings

### M2-H-1: Missing Address Reuse Warning for Pearl Sends
**Severity:** High  
**Location:** `src/ui/pages/SendPRL.tsx:136–241`, `src/services/pearl-tx.ts:127–135`  
**Description:**  
Pearl uses a UTXO model with a receive-address pool. When a send completes, the change output is always routed back to `pool[0]` (the primary address). This address is used for every send's change, which is visible in the public blockchain. A recipient analyzing the sender's past transactions can infer send amounts and timing by observing change outputs to the same address across multiple txids.

The wallet displays the composed transaction in the preview step (change amount, inputs, etc.) but does **not warn the user** that the change is being consolidated to an address they've already used. In contrast, receive.tsx explicitly educates about the receive-address pool; the send flow is silent.

**Impact:**  
- Privacy leakage: an adversary observing the blockchain can correlate sends by change address.
- User misconception: non-technical users may assume each send uses a fresh address (as might be default in some wallets).
- Cumulative disclosure: repeated sends to the same destination with visible change trails expose a relationship.

**Recommended Fix:**  
Add a disclosure line in SendPRL preview step (after the change amount, before the "Review" button flow):  
```
⚠ Change (546+ grains) is routed to your primary address (prl1p..., address #0 of your receive pool). 
This address appears on-chain in every send. For enhanced privacy, avoid reusing the same recipient across multiple sends.
```
Or surface this as a collapsible info section in Settings.

---

### M2-H-2: Fee Estimate vs Broadcast Mismatch Window (ETH/WPRL)
**Severity:** High  
**Location:** `src/ui/pages/SendETH.tsx:47–74`, `src/ui/pages/SendWPRL.tsx:49–68`, `src/services/eth-tx.ts:134–170`  
**Description:**  
Both SendETH and SendWPRL fetch `suggestGas()` + `estimateNativeGas()` / `estimateWprlGas()` on the preview stage and display the "worst-case gas" to the user. However, the actual broadcast happens moments later in `sendNative()` / `sendWprl()`, which **re-fetch** the nonce, gas estimate, and fee parameters from the chain:

```typescript
// SendETH.tsx preview (block cache lookup)
const [gas, fees, ethBal] = await Promise.all([
  estimateNativeGas(ethNetwork, ethAddr!, validated!.dest, validated!.wei),
  suggestGas(ethNetwork, tier),
  fetchEthBalanceWei(ethAddr!, ethNetwork),
]);

// Later, in broadcast (fresh RPC reads)
const [nonce, gas, fees] = await Promise.all([
  client.getTransactionCount({ address: p.from, blockTag: "pending" }),
  estimateNativeGas(p.network, p.from, p.to, p.value),
  suggestGas(p.network, p.tier),
]);
```

If the base fee spikes between preview and broadcast (gas spikes, mempool congestion), the user may be surprised by a higher fee. While the preview estimates 20% padding for storage warming, a 2–3× base fee jump in volatile market conditions is possible.

**Impact:**  
- User expectation mismatch: the shown "worst-case gas" may not be the actual worst case paid.
- Silent overpayment: a user who budgets assuming the preview estimate may overpay unexpectedly.
- Mobile/slow connections: larger time windows between preview and broadcast increase risk.

**Recommended Fix:**  
1. **Cap the broadcast gas estimate**: before broadcast, fetch the fresh estimate but cap it to preview_estimate * 1.5x (or similar threshold). If exceeded, block broadcast and re-prompt the user.
2. **Timestamp the estimate**: include the block height/timestamp of the preview estimate in the confirmation screen, and if the chain advances by >N blocks before broadcast, refresh the estimate and show the updated fee.
3. **Explicit drift warning**: if the broadcast estimate differs by >20% from preview, surface a warning before signing.

---

### M2-M-1: No Native Asset Confusion Check (PRL Address into ETH Send)
**Severity:** Medium  
**Location:** `src/ui/pages/SendETH.tsx:76–93`, `src/ui/pages/SendPRL.tsx:70–84`, `src/lib/validate.ts:5–15`  
**Description:**  
The wallet has three separate send flows (SendPRL, SendETH, SendWPRL), each with its own address validator:
- `validPearl()` → `isValidPearlAddress()` (bech32m, "prl" HRP)
- `validEth()` → viem's `isAddress()` (0x-prefixed hex)

However, there is **no cross-check** to prevent a user from copying a Pearl address (prl1p...) and pasting it into the ETH send field, or vice versa. While the validators will reject each other (a Pearl address fails validEth, an Ethereum address fails validPearl), a **confused user might misinterpret the error message** ("That doesn't look like a valid Ethereum address") as a validation failure rather than a format mismatch.

A typosquat scenario: user on a phishing clone (pearlwallet.xyz → walletmrb.xyz) sees an unfamiliar address in the send field, doesn't realize they're on the wrong domain, and tries to send to what they think is their Ethereum address but is actually a Pearl address they pasted.

**Impact:**  
- User sends funds to an address on the wrong chain, resulting in permanent loss if the sending address cannot be recovered (UTXO tx signed, value broadcast on wrong network).
- Confusion between two address formats could be exploited in a phishing + misdirection attack.

**Recommended Fix:**  
1. Add explicit address-format detection in each send flow. If the user pastes a Pearl address into SendETH, show: **"This looks like a Pearl address (prl1p...). Did you mean to send PRL instead? Only send ETH to Ethereum addresses (0x...)."**
2. Symmetrically, if an Ethereum address is pasted into SendPRL, warn: **"This looks like an Ethereum address (0x...). Did you mean to send ETH or WPRL instead?"**
3. Include format hints in the placeholder text: `placeholder="0x..." (Ethereum address)` and `placeholder="prl1p... (Pearl address)"`

---

### M2-M-2: Incomplete Recovery Onboarding Flow
**Severity:** Medium  
**Location:** `src/ui/pages/OnboardingCreate.tsx:102–158`, `src/ui/pages/OnboardingRestore.tsx` (not fully reviewed)  
**Description:**  
The create flow (OnboardingCreate) gates progression from "generate" to "verify" behind a 5-second timer: the user must look at their seed phrase for at least 5 seconds before clicking "I've written it down". This is a good UX friction to prevent clipboard rely.

However, the flow **never explicitly confirms** that the user has written the phrase down or has a backup. After the verify step succeeds, the wallet is created and the user is taken to the dashboard. There is **no explicit gate** like "I have written down and stored my recovery phrase in a safe location" that must be checked before opening the wallet.

Additionally, if the user clears IndexedDB (browser storage), the wallet state is lost. The unlock screen suggests they can "restore from the recovery phrase," but there is **no in-app guidance** on where to find that phrase or what to do if they can't remember the password.

**Impact:**  
- User might complete the create flow, not actually write down the phrase, and later lose access.
- No explicit acknowledgment gate means a distracted user could skip the crucial backup step.
- Recovery flow is left implicit — no walkthrough on restoring from a phrase if localStorage is wiped.

**Recommended Fix:**  
1. Add a mandatory confirmation before "Create wallet": **"☑ I have written down and securely stored my 12-word recovery phrase. I understand that losing this phrase means losing my funds."**
2. After creation, surface a 1-time "Recovery phrase saved?" prompt before allowing dashboard access: *"Please confirm: have you written down the recovery phrase and stored it somewhere safe?"* with buttons "Yes, I have it" / "Show me the phrase again."
3. In Unlock screen or Settings, add a "Restore wallet from recovery phrase" flow that walks the user through re-entering the phrase to re-derive their addresses.

---

### M2-M-3: No Activity/History Tracking Exposes Privacy Risk
**Severity:** Medium  
**Location:** `src/ui/pages/History.tsx`, `src/services/balances.ts`, `src/services/pearl-tx.ts`, `src/services/eth-tx.ts`  
**Description:**  
The wallet's History page is currently empty—it displays "No transactions yet" and is not functional. The wallet broadcasts transactions via RPC but **does not persist a local activity log**. This is partially a privacy win (no local audit trail), but creates a UX gap:

1. User sends PRL and navigates away, then comes back later. They have no in-app record of what they sent, to whom, or when.
2. If a user suspects a transaction was sent in error, they must search a block explorer (leaking their address list to the explorer domain).
3. No CSV export / backup of transaction history for accounting or dispute resolution.

While the absence of a history database is privacy-friendly, the lack of any indication that transactions *should* appear there creates confusion and potential support burden.

**Impact:**  
- Users lose visibility into their transaction history within the app; they must rely on external block explorers.
- Privacy-conscious users appreciate no local history, but non-technical users expect a "Recent transactions" list.
- No transaction receipt or confirmation in-app (only the txid shown post-send).

**Recommended Fix:**  
1. **Optional local history**: add a toggle in Settings → **"Activity logging"** (default off). When enabled, store send/receive txids + amount + recipient + timestamp in IndexedDB (not in localStorage, which persists across clears). Clear on logout.
2. **Transparent non-logging**: if history is off (default), display in History.tsx: *"Activity logging is disabled. To see a history of your sends, enable Activity logging in Settings. (Activity is never uploaded; it stays on your device.)"*
3. **Transaction receipt**: after a send, before returning to dashboard, display a detailed summary card (recipient, amount, fee, txid, timestamp) with an option to "Copy receipt" or export as JSON.

---

### M2-M-4: Cross-Origin RPC Allowlist Doesn't Cover Favicon/Resource Leaks
**Severity:** Medium  
**Location:** `public/_headers`, `index.html:21–24`, `src/chains/ethereum/rpc.ts:1–12`  
**Description:**  
The CSP in public/_headers restricts `img-src 'self' data: blob:` and `connect-src` to a strict allowlist (rpc.pearlwallet.xyz, ethereum-rpc.publicnode.com, eth.drpc.org, pearlbridge.xyz). This is strong.

However, favicons are loaded from `/favicon-32.png` and `/favicon-64.png`, which are same-origin and safe. The manifest references logo-192.png and logo-512.png, also same-origin.

A non-Cloudflare mirror or IPFS deployment might strip the `_headers` CSP enforcement, and an attacker could inject a malicious favicon fetch or replace assets to leak user addresses. The wallet does **not pin any cryptographic hash of core assets**, so a compromised CDN or IPFS node could silently modify the UI.

**Impact:**  
- IPFS or non-CF mirror users rely entirely on CSP headers for security. If headers are stripped (possible on some IPFS gateways or S3-backed mirrors), address leaks via modified UI are possible.
- No SRI (Subresource Integrity) on JS bundles, so a malicious CDN could inject key-stealing code.

**Recommended Fix:**  
1. **Add SRI to main JS bundle** in index.html:
   ```html
   <script type="module" src="/src/main.tsx" integrity="sha384-..."></script>
   ```
2. **Document non-CF deployment risks**: in README.md, explicitly state: *"Non-Cloudflare mirrors (IPFS, S3, local) must preserve CSP headers in HTTP response. Without them, security is degraded. Recommended: deploy to Cloudflare Pages directly."*
3. **Favicon pinning** (optional but defense-in-depth): use a data: URI or inline SVG for the favicon to prevent external fetch.

---

### M2-M-5: No Gas Reserve Check Before Sending All ETH
**Severity:** Medium  
**Location:** `src/ui/pages/SendETH.tsx:54–74`, `src/services/eth-tx.ts:131–153`  
**Description:**  
SendETH allows the user to specify any amount up to their balance. The gas estimate is fetched after the user enters the amount and clicks "Review." The preview shows "Total (max)" as `amount + worstCaseGas`.

However, there is **no built-in "send all" button with a gas reserve**. A user who manually enters their full ETH balance will be warned by the UI ("Insufficient ETH — amount + gas exceeds your balance"), but if they try to send 99% of their balance, the TX may still fail at broadcast time if gas spikes.

More critically: there is **no explicit warning** that sending most/all of their ETH leaves them unable to fund gas for future operations (e.g., sending WPRL later, which requires ETH for gas).

**Impact:**  
- User sends all ETH, then tries to send WPRL and discovers they have no gas left.
- UX confusion: the preview showed "covered: true" but the user is now blocked.
- Friction: requires top-up and another transaction to unblock.

**Recommended Fix:**  
1. Add a **reserve check** in SendETH preview: if the post-send balance would be < 0.001 ETH (or a configurable low-balance threshold), show a warning:
   ```
   ⚠️ After this send, you'll have less than 0.001 ETH left. 
   You won't be able to send WPRL or pay gas until you top up.
   ```
2. Offer a "Max safe send" button that computes `balance - 0.01 ETH` and auto-fills the amount field.
3. In Dashboard, if ETH balance is very low (< 0.0001), show a banner: **"Fund ETH to send WPRL or PRL tips."**

---

### M2-L-1: Clipboard Clear Timer Doesn't Guarantee Clipboard Wipe
**Severity:** Low  
**Location:** `src/ui/pages/Receive.tsx:45–71`  
**Description:**  
The receive flow copies an address to the clipboard and starts a 60-second timer to auto-clear it by writing an empty string. The implementation checks if the clipboard still contains the same address before clearing:

```typescript
const current = await navigator.clipboard.readText();
if (current === copiedAddr) {
  await navigator.clipboard.writeText("");
}
```

This is good—it respects user actions that overwrite the clipboard. However, the `readText()` call may throw a `NotAllowedError` if the user has revoked clipboard permissions, and the catch silently ignores the error. Thus, the address may never be cleared.

Additionally, **no XSS payload can steal the clipboard anyway** (CSP blocks inline scripts and frame-ancestors), and on mobile platforms (Safari iOS), the Clipboard API sometimes requires explicit user gesture.

**Impact:**  
- Edge case: a user who denies clipboard permission, then copies an address, then tries to access their clipboard 61 seconds later might see the old address.
- Very low risk in practice due to modern permission models and this being a receive address (non-sensitive compared to keys).

**Recommended Fix:**  
1. Log failures in the catch block (for debugging):
   ```typescript
   } catch (e) {
     if (e instanceof Error && !e.message.includes("NotAllowed")) {
       console.debug("Clipboard clear failed:", e.message);
     }
   }
   ```
   (No user-facing change needed; this is defensive instrumentation.)

---

### M2-L-2: Auto-Lock Timer Doesn't Persist Across Tab Visibility Changes Correctly
**Severity:** Low  
**Location:** `src/App.tsx:54–84`, `src/lib/monotonic.ts`, `src/state/wallet-store.ts`  
**Description:**  
The auto-lock mechanism uses `monotonicNow()` (performance.now-backed) to measure elapsed time and locks if > AUTO_LOCK_MS. The visibility handler re-checks elapsed time and locks immediately if the window has expired.

However, there is a **race condition** if the lock timer fires between the visibility handler's read of `lastActivity` and the actual lock call. In practice, this is negligible (milliseconds), but the lock-poll interval is 1 second, meaning a background tab will be checked every second while in the background (not just once per visibility change).

This is primarily an observation, not a functional bug, since the monotonic clock prevents wall-clock-based attacks.

**Impact:**  
- Negligible: the race window is sub-millisecond. A user regaining focus on a tab that's exactly at the timeout boundary might see a 1-second variance in lock timing.
- Not exploitable: monotonic timer prevents wall-clock-jump attacks.

**Recommended Fix:**  
No fix needed. Current implementation is sound. This is an info-level observation.

---

### M2-L-3: Password Reset Via Recovery Phrase Not Documented
**Severity:** Low  
**Location:** `src/ui/pages/Unlock.tsx`, `src/ui/pages/OnboardingRestore.tsx`, `docs/` (if exists)  
**Description:**  
If a user forgets their unlock password, they can restore the wallet by entering their recovery phrase (this is the intended design). However, **no in-app instruction guides them to this flow**. The Unlock page only shows a password field; there is no "Forgot password?" link or indication that they can restore the wallet.

**Impact:**  
- A user who forgets their password might assume their funds are lost, when in fact they can restore via the recovery phrase.
- Support burden: users will contact support asking if their funds are recoverable.

**Recommended Fix:**  
1. Add a link under the password field in Unlock: **"Forgot your password? [Restore from recovery phrase →](#)"**
2. This navigates to `/onboarding/restore` with a pre-filled warning: *"Restoring from your recovery phrase will allow you to set a new password. Your existing wallet will be replaced."*
3. Document in the About page (or a FAQ): **"I forgot my password. Can I recover my wallet?"**

---

### M2-L-4: No Certificate Pinning on RPC Endpoints
**Severity:** Low  
**Location:** `src/chains/ethereum/rpc.ts`, `src/chains/pearl/network.ts`, CSP in public/_headers  
**Description:**  
The wallet connects to hardcoded RPC endpoints (rpc.pearlwallet.xyz, ethereum-rpc.publicnode.com, eth.drpc.org) over HTTPS. The CSP restricts connect-src to these hosts, preventing XSS from injecting new RPC endpoints.

However, there is **no certificate pinning** (HPKP or similar). A compromised or MitM attacker with access to a CA could issue a valid cert for these domains and intercept RPC traffic, seeing all addresses and even manipulating balance reports.

This is a known limitation of the Web platform (no programmatic cert pinning available), but documenting the threat model is important.

**Impact:**  
- A sophisticated attacker with CA compromise could MitM RPC calls and see user addresses.
- Risk is mitigated by Cloudflare's DDoS + origin protection on rpc.pearlwallet.xyz.
- Users on untrusted networks (public WiFi) are at higher risk; a custom RPC on a compromised network could leak addresses.

**Recommended Fix:**  
1. Document in Settings → Pearl RPC endpoint: **"A malicious RPC can see your addresses and lie about your balance. Only use RPC endpoints from trusted providers."**
2. For paranoid users, recommend: **"Run your own Pearl sentry node and point the wallet to http://localhost:18332 over a trusted VPN."**
3. (No code change needed; this is a documentation/threat-model clarification.)

---

### M2-I-1: Tip Address Hard-Coded, Not Configurable
**Severity:** Info  
**Location:** `src/chains/pearl/tip.ts`, `src/ui/pages/SendPRL.tsx:200–220`  
**Description:**  
The tip address (for PearlBridge dev funding) is hard-coded in the binary and cannot be changed by users. While this is the intended design (ensure tips go to the intended beneficiary, not a phishing address), users cannot redirect tips to their own address or disable tips entirely.

The UI does offer a per-transaction toggle ("Tip the PearlBridge dev team 10 bps"), and a global setting (Settings → tip enabled), which is good.

**Impact:**  
- No impact. Tip destination is immutable and controlled by the dev team, which is appropriate.
- Non-technical users may not realize what the tip is for and may complain about "unexpected fees."

**Recommended Fix:**  
1. In SendPRL preview, clarify the tip purpose: **"Tip to PearlBridge (10 bps, min 1 PRL) — funds the development team."**
2. In Settings, add: **"PearlBridge Tip: 10 basis points (0.1%) per send, optional. [Learn more →](https://pearlbridge.xyz/about)"**

---

### M2-I-2: Degraded Balance Flag Not Surfaced in Send Preview
**Severity:** Info  
**Location:** `src/services/pearl-tx.ts:93–145`, `src/ui/pages/SendPRL.tsx:136–198`  
**Description:**  
When composing a Pearl send, the `composePearlSend()` function returns `degraded: true` if the UTXO walk hit MAX_UTXO_WALK_PAGES or MAX_RPC_PAGE_LENGTH before exhausting the receive-pool history. This flag is surfaced in the preview UI:

```tsx
{composed?.degraded && (
  <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
    Some receive addresses returned partial UTXO sets. The send may not use every available coin;
    consider retrying if it fails for insufficient funds.
  </div>
)}
```

However, the flag is also set on SendPRL.tsx, but **not prominently highlighted in the compose stage**. A user might input an amount, click "Review," and only then see the warning. If the send fails for E_INSUFFICIENT_FUNDS, the warning would have been valuable earlier.

**Impact:**  
- Minor UX friction: user might waste time entering an amount, clicking Review, only to see a degraded-RPC warning.
- Could be mitigated by showing the warning in the compose stage if a degraded balance was detected.

**Recommended Fix:**  
1. Add a loading state in the compose view: *"Checking your address pool… (may take up to 30s if you have many addresses)"*
2. Once balances load, if degraded flag is detected, show a banner in the compose stage: **"⚠ Partial balance report: couldn't fetch UTXOs from all addresses. You may have more PRL available than shown."**
3. This allows users to make an informed decision before clicking "Review."

---

## Threat Model Gaps & Observations

### Phishing + Domain Typosquat
The wallet's UI (iframe-bust, CSP, SRI absence) is hardened against embedding and frame-based attacks. However, a typosquat domain (pearlwallet.xyz → walletmrb.xyz) would look identical to users. The manifest and metadata don't include signature verification or domain pinning that could be checked by a user's browser security tools.

**Mitigation:** Domain registration with trademark/privacy protection; browser warnings for lookalike domains (browser vendors' responsibility).

### Mobile Safari Clipboard API
On iOS Safari, clipboard access requires explicit user gesture and may fail silently. The wallet's Receive.tsx auto-clear timer catches exceptions, but a user might expect the address to be cleared and it silently doesn't.

**Mitigation:** Document in About: *"On iOS, clipboard access requires your permission each time. Manually clear your clipboard after 60 seconds for best privacy."*

### Shared Device Recovery
If a user restores a wallet on a shared device (family computer), the recovery phrase is briefly in memory during restore. If the device is compromised, an attacker could extract it. The wallet zeros the phrase after derive (good), but during the restore process itself (UI display + keyboard input), it's visible.

**Mitigation:** Document in OnboardingRestore: *"Never restore a wallet on a shared device. The recovery phrase will be briefly visible on-screen."*

---

## Resolved Issues from Prior Audits

The following v0.1.8 findings are confirmed fixed:
- **Opus2 H-1 / Minimax2 H-1**: iframe-bust moved to external script (public/iframe-bust.js) ✓
- **Opus2 H-2**: pearlParams re-validates RPC override on every read ✓
- **Opus2 M-1**: Auto-lock uses monotonicNow() ✓
- **Opus2 M-3 / H-2**: Settings.saveRpc catches E_RPC_OVERRIDE_NOT_ALLOWED ✓
- **Opus1 M-1 / Minimax1 M-1**: passwordAcceptable rejects degenerate long inputs ✓

---

## Recommendations Summary

| Priority | Action | Effort |
|----------|--------|--------|
| High | Implement address-reuse warning for Pearl sends | Low |
| High | Cap ETH fee estimate drift between preview and broadcast | Medium |
| Medium | Add cross-chain address format detection | Low |
| Medium | Gate wallet creation on recovery-phrase backup confirmation | Low |
| Medium | Implement optional local activity logging (off by default) | Medium |
| Medium | Document non-CF deployment security assumptions | Low |
| Medium | Add gas-reserve warning for SendETH | Low |
| Low | Improve password-recovery discoverability | Low |
| Low | Clarify tip purpose and RPC threat model in docs | Low |
| Info | Add degraded-balance indicator to compose stage | Low |

---

## Conclusion

v0.1.9 is functionally sound with strong cryptographic and network security hardening. The identified gaps are primarily **user experience and privacy education** issues rather than protocol or implementation flaws. The most impactful fixes are:

1. **Address reuse warning** (Pearl UTXO privacy)
2. **Fee estimate drift protection** (ETH/WPRL gas surprises)
3. **Cross-chain address detection** (prevents accidental sends to wrong chain)
4. **Recovery flow gatekeeping** (prevents fund loss from incomplete onboarding)

All findings are low-to-medium risk in the context of a non-custodial wallet where the user has sole custody of their keys. Custody and signing remain strong.
