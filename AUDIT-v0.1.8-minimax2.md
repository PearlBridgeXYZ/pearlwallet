# Security Audit Report: Pearl Web Wallet v0.1.8

**Auditor:** MiniMax-M2 (Independent Security Auditor)
**Target:** Pearl Web Wallet v0.1.8
**Date:** May 20, 2026
**Context:** Non-custodial pure-web wallet (Vite/React/TS + Zustand + Dexie + viem) for PRL (Pearl mainnet, BIP-86 P2TR) and WPRL (Ethereum ERC-20). Crypto runs in a Web Worker. Mainnet only.

---

## Executive Summary

This audit takes the **usability/UX-security + threat-modeling** angle — onboarding ergonomics, send/receive attack surfaces, settings UX traps, lock/unlock state machine behavior, cross-tab consistency, and a head-to-head check that the documented threat model (`docs/03-THREAT_MODEL.md`) actually matches the code shipped at HEAD (`79d7890`).

v0.1.8 is a substantive hardening release: RPC override allowlist, AAD context binding, `crypto-quiet`-style cross-tab idempotency on the BroadcastChannel sender id, framing/COOP/COEP headers, strict `coerceUint`. The crypto worker and bridge-signature verifier are solid. **However, the v0.1.8 batch introduced two new UX-security holes that prior auditors did not surface**, plus a structural problem with the new iframe-bust script that's worth flagging explicitly because it's load-bearing for non-Cloudflare mirrors.

**The headline finding is HIGH-1:** the inline iframe-bust `<script>` newly added to `index.html` is silently blocked by the meta-CSP `script-src 'self'` directive on the very deployments (IPFS / S3 / local mirrors) it claims to protect. The CF Pages deploy has `X-Frame-Options: DENY` + `frame-ancestors 'none'` in `_headers` and is unaffected — but the documented purpose of the inline script is the mirror fallback, and that fallback does not execute. A user running the wallet from an IPFS gateway today is framed-clickable despite the apparent defense in `index.html`.

The threat model promises in `docs/03-THREAT_MODEL.md` § T5 ("address poisoning") are also not implemented in the Send flow — no identicon, no last-sent-similarity warning, no address-book label preview. The History page is a stub, so the wallet has no mechanism to enforce "warn if destination differs from previously-sent address by only a few chars."

Other significant issues are bounded: a Settings UI crash on a typo'd custom RPC, a broken "Wipe this wallet" deep-link from `/unlock`, an incomplete mnemonic-verification challenge (24-word phrases only get 3 words from positions 3/7/11 — index 11–23 are never tested), and the `passwordStrength` heuristic labels weak passwords as "strong."

No findings would cause loss of funds in v0.1.8 today (broadcast is gated behind a disabled button). The flags below are the v0.2-broadcast-readiness gaps and the UX-security gaps that already affect users at HEAD.

---

## Findings Summary

| Severity | Count | Area                                                                        |
|----------|-------|-----------------------------------------------------------------------------|
| HIGH     | 2     | Iframe-bust dead on mirrors; Settings crash on rejected RPC                 |
| MEDIUM   | 5     | 24-word verify gap; address-poisoning gap; Wipe-from-locked link; receive-pool privacy; clipboard read-back prompt |
| LOW      | 5     | Password strength meter; placeholder fee UI; mnemonic copy/paste; export-password autocomplete; auto-lock during in-flight ops |
| INFO     | 4     | localStorage scope; QR contents; telemetry; threat-model drift              |

---

## Detailed Findings

### HIGH

#### H-1. Inline iframe-bust script is blocked by the wallet's own meta-CSP on every non-Cloudflare deployment

**Files:** `index.html:29-56`, `dist/index.html` (built), `public/_headers`

The v0.1.8 batch added a defense-in-depth inline iframe-bust to `index.html`:

```html
<script>
  (function () {
    try {
      if (window.top !== window.self) {
        document.documentElement.innerHTML = '...refused...';
        throw new Error("PearlWallet refused to run framed");
      }
    } catch (e) { ... }
  })();
</script>
```

The comment immediately above it explains why the script exists:

> CSP `frame-ancestors` lives in `public/_headers` (the Cloudflare deploy enforces it) but a non-CF mirror — local static server, IPFS gateway, S3 bucket — would not serve those headers and a malicious page could embed pearlwallet.xyz in a hidden iframe to overlay/click-jack the unlock or send confirm. Inline so it runs before main.tsx mounts React; throws to halt further script evaluation in the framed context.

The meta-CSP six lines above defeats this:

```
script-src 'self'
```

No `'unsafe-inline'`. Browsers honoring CSP refuse to execute inline `<script>` blocks under `script-src 'self'` — and they refuse silently (a CSP violation report is emitted, no user-visible message). The dist artifact verifies the inline tag is in the served HTML at `dist/index.html` line ~30+.

Compounding this on the same mirrors:

- `X-Frame-Options: DENY` is **only** set in `public/_headers` — i.e., **only** on Cloudflare. It is not in `index.html` (cannot be set there; X-Frame-Options is not a `<meta>` directive per spec, though some browsers honored it historically).
- `frame-ancestors 'none'` is **only** in the `_headers` `Content-Security-Policy` value — the meta-CSP in `index.html` omits `frame-ancestors`, and **`frame-ancestors` is ignored when delivered via `<meta http-equiv>` per CSP3 spec**. Even adding it to the meta would not help.

Net effect on a non-CF mirror (the explicit fallback case the comment names):

| Defense          | Present on mirror? | Why it fails                                                 |
|------------------|--------------------|--------------------------------------------------------------|
| `X-Frame-Options`| No                 | Only in `_headers` (CF-only)                                 |
| `frame-ancestors`| No                 | Only in `_headers`; meta-CSP is silent and would be ignored  |
| Inline JS bust   | No                 | Blocked by meta-CSP `script-src 'self'` (no `'unsafe-inline'`) |

→ **A user running PearlWallet from an IPFS gateway, S3 bucket, or local static server today CAN be framed**, despite the inline script and the comment that claims it's the mirror fallback.

The CF Pages deploy is unaffected because `X-Frame-Options: DENY` and the header-CSP `frame-ancestors 'none'` both fire. But the wallet's stated security posture is "the served bundle is the same from any mirror" (per `docs/03-THREAT_MODEL.md` § T2 mention of reproducible builds). If a user verifies the bundle hash and serves it from their own static host, they lose framing protection without knowing.

**Severity rationale:** HIGH because (a) the defense is documented as load-bearing for mirrors in the inline comment, (b) it is silently ineffective rather than loudly broken (no visible error), and (c) framing enables clickjack overlay attacks on the unlock password field and send-confirm buttons — both real loss-of-funds vectors when broadcast lands in v0.2.

**Fix:** Either of:

1. **Compute an inline-script hash and add `'sha256-…' ` to `script-src`** in both `_headers` and the meta-CSP. The hash for this exact `<script>` body is computable at build time; Vite has plugins for this.
2. **Move the iframe-bust to the first line of `main.tsx`** (already same-origin, executes under `script-src 'self'`). Acknowledges it runs slightly later than truly-inline but still blocks framed clicks before any handler binds.
3. **Document explicitly** that non-CF mirrors require the user to add `X-Frame-Options: DENY` in their server config, and remove the dead inline script so it doesn't create a false sense of security.

Option (2) is the cheapest correct fix and what most React-shipped wallets do.

---

#### H-2. Settings page crashes (uncaught exception) when user types a custom RPC URL that's valid HTTPS but not on the allowlist

**Files:** `src/ui/pages/Settings.tsx:142-164`, `src/state/ui-store.ts:88-98`

v0.1.8 added a strict host allowlist for the Pearl RPC override (`isAllowedRpcOverride`) and made `setPearlRpcOverride` **throw** `E_RPC_OVERRIDE_NOT_ALLOWED` on rejection:

```ts
// src/state/ui-store.ts:88-95
setPearlRpcOverride(url) {
  if (!isAllowedRpcOverride(url)) {
    throw new Error("E_RPC_OVERRIDE_NOT_ALLOWED");
  }
  set({ pearlRpcOverride: url });
  saveUI({ ...persistedSnapshot(get()), pearlRpcOverride: url });
},
```

The Settings UI's `saveRpc` only validates `https:` protocol — it does **not** check the host allowlist before calling the setter:

```tsx
// src/ui/pages/Settings.tsx:142-164
function saveRpc(rawValue?: string) {
  setRpcStatus(null);
  const trimmed = (rawValue ?? rpcDraft).trim();
  if (trimmed === "") {
    setPearlRpcOverride("");
    setRpcStatus(`Using default (${defaultRpcUrl}).`);
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    setRpcStatus("That's not a valid URL.");
    return;
  }
  if (parsed.protocol !== "https:") {
    setRpcStatus("RPC URL must use https://.");
    return;
  }
  setPearlRpcOverride(parsed.toString());   // ← can throw, not caught
  setRpcDraft(parsed.toString());
  setRpcStatus(`Using custom: ${parsed.toString()}`);
}
```

**Reproduction:** Type `https://example.com/` (valid HTTPS, not on allowlist `rpc.pearlwallet.xyz` / `ethereum-rpc.publicnode.com` / `eth.drpc.org` / `pearlbridge.xyz`) and click Save. Result: uncaught `Error: E_RPC_OVERRIDE_NOT_ALLOWED` propagates to React's render. There is no error boundary in `App.tsx` or `main.tsx`. The entire Settings panel goes blank (React unmounts the failed tree); the only recovery is a full page reload.

**Why HIGH:** Settings is the page that hosts mnemonic export, password change, and the wipe form. A user mid-export who fat-fingers an RPC URL loses their export progress (the mnemonic state is dropped — the 60s timer is cleared by the unmount, but the on-screen string vanishes mid-write-down). They also can't lock/wipe from the UI until reload. The fact that the failure mode is an *uncaught throw on an unrelated user action* is the issue.

**Severity rationale:** Settings UX crash + recovery requires reload + can be reached by a one-letter typo (`https://rpc.pearlwallet.xy`, missing `z`).

**Fix:** Two compatible options:

1. Wrap the `setPearlRpcOverride` call in a try/catch and surface the rejection through `setRpcStatus` like other validation paths:

   ```tsx
   try {
     setPearlRpcOverride(parsed.toString());
     setRpcDraft(parsed.toString());
     setRpcStatus(`Using custom: ${parsed.toString()}`);
   } catch (e) {
     if (e instanceof Error && e.message === "E_RPC_OVERRIDE_NOT_ALLOWED") {
       setRpcStatus(`Host not on the allowlist. Permitted: ${RPC_OVERRIDE_ALLOWED_HOSTS.join(", ")}`);
     } else {
       setRpcStatus(e instanceof Error ? e.message : "Save failed.");
     }
   }
   ```

2. Better: check `isAllowedRpcOverride` from the UI **before** calling the setter, with a human-readable rejection that lists the allowlist. Drop the throw to a soft return for caller convenience (or keep it for the programmatic path).

3. Optional but recommended: add a top-level React error boundary in `main.tsx` so a future throw doesn't unmount the whole wallet to a blank screen.

---

### MEDIUM

#### M-1. 24-word recovery phrase verification only tests positions 3 / 7 / 11 — words 12-24 are never confirmed

**File:** `src/ui/pages/OnboardingCreate.tsx:62-68, 168-188`

The verify step is hard-coded to positions 3, 7, 11 regardless of mnemonic length:

```tsx
function checkVerify(): boolean {
  return (
    verifyInputs.w3.trim().toLowerCase() === words[2] &&
    verifyInputs.w7.trim().toLowerCase() === words[6] &&
    verifyInputs.w11.trim().toLowerCase() === words[10]
  );
}
```

For a 12-word phrase this samples 25% of the words across the full length, which is reasonable. For a **24-word phrase**, this samples 12.5% concentrated in the **first half** (positions 1-11). Words 12 through 24 are never tested. A user who copies positions 1-11 correctly into a notebook but botches the second half passes verification and proceeds to set a password, then discovers on restore that their 24-word phrase is unrecoverable.

24-word mode is the strength the UI **recommends for security-conscious users** (it's the higher-entropy option). Making it the laxer test inverts the protection — verification quality should scale up with phrase length, not stay flat.

**Severity rationale:** A 24-word user who got positions 12-24 wrong has no in-app signal until restore. Loss-of-funds is real-but-conditional on the user's pen-paper accuracy; if every user copies cleanly, this never bites. Industry baseline (Trezor, Ledger) sample at least one word per quartile.

**Fix:** Sample positions proportional to phrase length. E.g., for 12-word: positions 3, 7, 11. For 24-word: positions 3, 8, 15, 22 (one per quartile, four total). Or: pick three positions at random from the second half too when `words.length === 24`.

---

#### M-2. Address-poisoning protections promised in the threat model are not implemented

**Files:** `src/ui/pages/SendPRL.tsx`, `src/ui/pages/SendWPRL.tsx`, `docs/03-THREAT_MODEL.md` § T5

`docs/03-THREAT_MODEL.md` § T5 enumerates four explicit mitigations against address poisoning / clipboard hijack:

> - When user pastes an address, show first 6 / last 6 chars in large monospace + a derived 4-color identicon. User must check it matches their intent.
> - Address book: user can save trusted addresses with a label; saved addresses show their label in the preview.
> - If the destination is a known bridge address, label it as such.
> - Warn if destination differs from previously-sent address by only a few chars.

None of these are present in v0.1.8. Both SendPRL and SendWPRL show a plain monospaced full address in the preview, with no:
- Identicon
- First/last large-font emphasis
- Address book lookup or "saved as: <label>"
- Bridge-address recognition (despite `chains/pearl/tip.ts` knowing the tip address and `services/bridge.ts` knowing the bridge contracts)
- Comparison against `txCache` history (the History page is a stub returning "No transactions yet")

The threat model is explicit that this is a **shipping** mitigation, not a roadmap item. The IPL between the docs and the code has drifted.

**Compounding factor — clipboard hijack:** A clipper malware swapping one char in `prl1pXXXX` produces a *valid* bech32m address (the checksum would have to coincidentally match — possible at ~1/2^30, low but not nil; more realistically the attacker pre-computes a vanity address with the same prefix/suffix). The user pastes, sees `prl1ptzr...ldnxh` in the preview (matches their visual memory of the tip address!), and clicks Send. Without an identicon or saved-label check, the only defense is visual character-by-character read of the middle of the address, which users empirically don't do.

**Severity rationale:** MEDIUM because broadcast is not live in v0.1.8 (so this isn't a real loss vector today), but it **must** land before v0.2 broadcast ships. The docs are explicit that these defenses are part of the shipped wallet's promise — current state is documentation drift.

**Fix priorities (in order):**

1. Implement identicon (deterministic hash of address → 4-color 8×8 grid) in the Send preview. Self-contained, no deps beyond `@noble/hashes` already in `package.json`.
2. Label known-recipient addresses in preview: tip address, bridge contracts. Module: `chains/pearl/tip.ts` exports the tip address, `services/bridge.ts` exports the bridge contract addresses — easy lookup.
3. Implement the address-book Dexie table that's already in `db.ts` (`addressBook`) but never written-to. Add a "Save to address book" option after a successful send.
4. Once History is wired, add the "differs by <= N chars from last send" Levenshtein warning.

---

#### M-3. "Wipe this wallet" deep-link on the Unlock page is broken — clicking it does nothing visible

**Files:** `src/ui/pages/Unlock.tsx:53-55`, `src/App.tsx:101-119`

`Unlock.tsx` offers a helper link for users who forgot their password:

```tsx
<Link to="/settings" className="text-ink-500 hover:underline">
  Wipe this wallet
</Link>
```

But `App.tsx` auto-route forces locked users back to `/unlock`:

```tsx
} else if (status === "locked" && path !== "/unlock") {
  navigate("/unlock", { replace: true });
}
```

Clicking the link routes to `/settings`, the auto-route effect fires on the next render and bounces back to `/unlock`. The user sees a half-second flicker and is back where they started. No error, no toast, no explanation. The only way to actually wipe is to know the password (which contradicts the link's purpose — wipe is the recovery from forgotten password) **or** know the workaround of "Restore from recovery phrase" which is also linked but, per `OnboardingCreate`'s logic, would correctly throw `E_WALLET_EXISTS` first and require an `allowOverwrite` opt-in not exposed in the UI.

So a user who:
1. Forgot their password
2. Has the recovery phrase
3. Clicks "Wipe this wallet" expecting to clear the keystore and re-onboard

…cannot reach the wipe action through the UI. The actual recovery path is: click the *other* link ("Wrong password? Restore from recovery phrase"), and pray that flow handles E_WALLET_EXISTS gracefully — which it does not currently expose an override for, so it throws an error message that doesn't tell the user what to do.

**Severity rationale:** MEDIUM because it's a recovery-path dead-end. A user with the phrase but not the password is locked out of the wallet on this device with no in-UI escape hatch. They must reload, clear browser storage manually, then re-onboard — a non-discoverable workflow.

**Fix:** Two options:

1. **Add a "Wipe without password (requires recovery phrase)" route** that requires the user to enter the phrase, which is then compared against the address derived from the keystore (without ever decrypting it — just check that the pubkey derived from the phrase matches the on-disk `publicData.pearlAddress`). On match, wipe is allowed. On mismatch, refuse.

2. **Allow the "Wipe this wallet" link from Unlock to deep-link to a wipe-only sub-page** that bypasses the auto-route guard. The auto-route logic checks `path !== "/unlock"` — extend to `path !== "/unlock" && path !== "/wipe-recovery"` (or whatever the dedicated route is).

The first is the proper fix; the second is acceptable in the short term.

---

#### M-4. Receive-page address-pool selector exposes all 20 derived addresses on a single page — privacy regression for UTXO L1

**File:** `src/ui/pages/Receive.tsx:121-157`

The Receive page renders a "Show all (N)" toggle that, when expanded, lists every address in the receive pool (RECEIVE_GAP_LIMIT = 20) on a single screen with full bech32m strings. This is **good** for the UTXO recovery use case (user can verify funds at any derived address), but **bad** for the privacy of a UTXO chain.

UTXO chains rely on address-graph unlinkability: a watcher who learns address #3 cannot trivially conclude it shares a wallet with address #7 unless those addresses spend in the same transaction. By showing all 20 addresses *concurrently* in the same DOM, the wallet:

- Creates a screenshot-shareable artifact that links the entire pool to a single user (e.g. user opens to copy address #5, screen-shares to a friend or accidentally tweets the screenshot — the friend now knows the full 20-address pool).
- Lets a shoulder-surfer or screen-capture-malware enumerate the pool in one shot, instead of one address per receive event.
- Lets an extension reading DOM (`document.body.innerText`) harvest the full pool on Receive view.

Compare to Trezor Suite / Sparrow Wallet, which require an explicit "show derivation N" click per address and never render the full pool on one page.

**Severity rationale:** MEDIUM (privacy class, not loss-of-funds). UTXO privacy is a documented Pearl L1 property; the receive-page UX undermines it.

**Fix:**

1. Default to showing only the current "active" address (index `prlIndex`), not the full list.
2. Replace "Show all (20)" with a pager: "Address N of 20" with next/prev arrows.
3. If the user actually needs the full list (a recovered wallet checking which derivation funds went to), gate it behind a confirmation: "This will display all 20 derived addresses. Anyone who sees your screen will learn your full receive pool."

---

#### M-5. Clipboard auto-clear in Receive triggers a clipboard-read permission prompt that confuses users

**File:** `src/ui/pages/Receive.tsx:46-71`

The Receive page auto-clears the clipboard 60s after a copy:

```tsx
clipboardClearTimerRef.current = setTimeout(async () => {
  try {
    const current = await navigator.clipboard.readText();
    if (current === copiedAddr) {
      await navigator.clipboard.writeText("");
    }
  } catch { /* best-effort */ }
}, 60_000);
```

The `navigator.clipboard.readText()` call on Chromium-family browsers triggers a permission prompt if not already granted — the prompt fires 60 seconds **after** the user clicked Copy, when they have likely switched to another tab to paste the address into an exchange or send form. The prompt appears unexpectedly while the user is doing something else, asking for a permission they did not understand they were granting.

Cases this creates:

- **User denies the permission.** The address sits in the OS clipboard indefinitely (until they copy something else). The "auto-clear" guarantee is silently broken.
- **User grants the permission.** PearlWallet now has clipboard-read permission for future sessions; from then on it can read anything the user copies while the tab is open — which is a much larger privilege than the wallet needs.
- **User is mid-paste on another site** when the prompt fires. They click the wrong button.

There's a simpler implementation that avoids the permission entirely:

```ts
// 60s later: just overwrite. If the user copied something else in
// between, we clobber their new clipboard. Trade-off, but better than
// asking for clipboard-read permission for an auto-clear.
clipboardClearTimerRef.current = setTimeout(async () => {
  try {
    await navigator.clipboard.writeText("");
  } catch { /* permission denied or focus restriction */ }
}, 60_000);
```

This loses the "only clear if it's still ours" property but doesn't ask for clipboard-read. Most password managers (1Password, Bitwarden) take exactly this approach for the same reason.

Alternatively: drop the auto-clear entirely and document in `About` that the user should clear their clipboard manually. Auto-clear is a courtesy, not a defense — a clipper malware on the same device reads the address the millisecond it's copied, before any 60s clear runs.

**Severity rationale:** MEDIUM (UX-security). The permission prompt is surprising-on-a-wallet (red flag for users trained to be suspicious of wallet permissions), and the silent failure path means the auto-clear is unreliable.

**Fix:** Use write-only `writeText("")` without the read-back check, accepting the trade-off. Or remove the auto-clear and document clipboard hygiene in the About page.

---

### LOW

#### L-1. `passwordStrength()` labels weak passwords as "strong" — heuristic is misleading

**File:** `src/lib/validate.ts:22-32`

```ts
export function passwordStrength(password: string): PasswordStrength {
  const len = password.length;
  let score = 0;
  if (len >= 8) score++;
  if (len >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  const labels = ["too short", "weak", "ok", "strong", "very strong"];
  return { score: Math.min(score, 4) as PasswordStrength["score"], label: labels[Math.min(score, 4)]! };
}
```

`"Abc1234!"` (8 chars, all four classes) scores 1+0+1+1 = 3 → "strong." It is **not** strong; it has ~25 bits of entropy at best and falls to a list-based attack.

`"correctness"` (11 chars, lowercase-only) scores 1+0+0+0 = 1 → "weak." It's actually ~50 bits of entropy if drawn from a 7k-word dict — but the meter says weak.

The comment in the file acknowledges this:
> `(zxcvbn deferred to keep bundle small in v1 scaffold.)`

The meter therefore actively misinforms users. A user reading "strong" trusts the meter and picks an 8-char keyboard-walk that PBKDF2-600k cracks in hours on a GPU.

**Severity rationale:** LOW because `passwordAcceptable` (the actual gate) is stricter — it requires 10 chars + 2 classes OR 16+ chars. The meter is purely advisory, but it's advising incorrectly.

**Fix:** Either (a) ship `zxcvbn-ts` (the ESM port, ~150KB gzipped — material but acceptable for a security-critical surface) and use its score, or (b) downgrade the labels to match what the heuristic actually measures: "minimum length met / class-mix met" rather than "strong." Something honest: replace `["too short", "weak", "ok", "strong", "very strong"]` with `["needs more characters", "needs more variety", "meets minimum", "meets minimum + class mix"]`.

---

#### L-2. Send preview displays fixed fee placeholders that don't match what live broadcast will charge

**Files:** `src/ui/pages/SendPRL.tsx:12-16`, `src/ui/pages/SendWPRL.tsx:9-13`

```ts
const FEE_BY_TIER: Record<FeeTier, bigint> = {
  low: 1000n,      // 0.00001 PRL placeholder
  normal: 5000n,   // 0.00005 PRL
  high: 20000n,    // 0.0002 PRL
};
```

The preview banner says "Preview only — live PRL broadcast from the wallet UI ships in v0.2," but it also shows specific fee numbers as if they were authoritative. A user reading "Fee (normal): 0.00005 PRL" walks away with that as their mental model of PearlWallet's fee schedule — then v0.2 ships with real UTXO coin-selection and a per-input/output fee structure, which will not be 5000 grains flat.

The same applies to SendWPRL with literal `"1 gwei"` / `"2 gwei"` / `"3 gwei"` strings — these are not what `eth_gasPrice` will return on a live mainnet send.

**Severity rationale:** LOW (anchoring/expectation, not a bug today). Concrete cost: if a user budgets based on the placeholder and v0.2 has materially higher fees, they're surprised.

**Fix:** Replace numeric fees in the preview with the word "estimated" and an em-dash until v0.2 wires real fee estimation. E.g., `Fee (normal): — PRL (estimated at broadcast)`. The tier radio buttons can stay as-is.

---

#### L-3. Mnemonic display in Settings → Export is selectable / copyable text without an explicit "Don't copy this" UX

**File:** `src/ui/pages/Settings.tsx:264-272`

```tsx
{mnemonicValue ? (
  <>
    <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">
      {mnemonicValue}
    </pre>
    <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
      Auto-hiding in {mnemonicSecondsLeft}s.
    </p>
  </>
) : ( ... )}
```

The `<pre>` is selectable/copyable by default. The warning "Don't screenshot this. Write it down." is just above the box. There's no "Don't copy this" — and the default cursor on `<pre>` is the text cursor, which invites selection. The `OnboardingCreate` page is structured so each word is in its own `<li>` (not trivially copyable as a one-shot select), but the export view is a single `<pre>` blob that's one Cmd-A away from clipboard.

A user who reads "don't screenshot" but doesn't read "don't copy" Cmd-A → Cmd-C → pastes into a notes app to "save it for later" — and now their phrase lives in iCloud Notes / Notion / wherever, syncing across devices.

**Severity rationale:** LOW. The Onboarding flow is the higher-friction time when users decide their storage strategy; the Export flow is for users who already chose their strategy. Still, defense in depth.

**Fix:** Either (a) split the mnemonic into 12/24 individual elements like Onboarding (preserving the "no easy copy" property), or (b) add `user-select: none` on the `<pre>` plus a "Tap and hold to copy" affordance gated behind a confirmation. Add explicit "Don't copy this — write it on paper." to the amber warning text.

---

#### L-4. Mnemonic-export password input lacks `autocomplete="current-password"` — browsers may treat it as a new-credential field

**File:** `src/ui/pages/Settings.tsx:250-256`

```tsx
<input
  className="input"
  type="password"
  placeholder="Password"
  value={pwExport}
  onChange={(e) => setPwExport(e.target.value)}
/>
```

No `autocomplete` attribute. Chromium's default behavior for `type="password"` without a hint is to offer to save the password as a "new" credential when the user types one in — and PearlWallet has no `<form>` semantics around this input, so the heuristic varies by browser. On some configurations the browser saves the password under the wallet's domain, then offers to autofill it next time, potentially across other inputs.

The wipe password input has `autoComplete="current-password"` (line 391). The change-password old/new inputs (lines 217-237) also lack any `autocomplete` hint, which is more concerning — `autocomplete="new-password"` on `newPw`/`newPw2` would suppress the autofill prompt that "you just changed your password — save the new one?" — which **is** behavior we want for those.

**Severity rationale:** LOW. Browser password managers are not unsafe, but the inconsistency creates UX confusion and potential cross-form autofill bleed.

**Fix:**

- Export password input: `autoComplete="current-password"` (same as Unlock and Wipe).
- Change-password old field: `autoComplete="current-password"`.
- Change-password new + confirm fields: `autoComplete="new-password"` (signals to the password manager that this is a new credential and to update its store).

---

#### L-5. Auto-lock during in-flight wallet operations rejects awaiters via `E_WORKER_RESET` without UI surfacing

**File:** `src/crypto/worker-client.ts:48-57`, `src/App.tsx:85-95`

The `cryptoWorker.reset()` path correctly rejects all in-flight promises with `E_WORKER_RESET`:

```ts
reset(): void {
  if (this.worker) {
    this.worker.terminate();
    this.worker = null;
  }
  for (const { reject } of this.inflight.values()) {
    reject(new Error("E_WORKER_RESET"));
  }
  this.inflight.clear();
}
```

…but no caller in `wallet-store.ts` distinguishes `E_WORKER_RESET` from other errors. If the user is mid-`changePassword` and the auto-lock fires (5 minutes of inactivity is possible during a typed-password contemplation), the user sees `setError("E_WORKER_RESET")` in the Settings UI — a raw error string with no recovery guidance. The error message is *displayed verbatim* via `e.message` on the catch in `doChangePassword` and `doExport`.

Same issue if the user is mid-`exportMnemonic` and the auto-lock fires: their export password is wiped, the mnemonic display goes blank, and they see "E_WORKER_RESET" — no hint that they should reload Settings and re-export.

**Severity rationale:** LOW (UX, not security). The defense itself is correct — auto-lock should terminate in-flight worker ops. The polish is the error message.

**Fix:** Map `E_WORKER_RESET` in catch blocks of Settings (and any other surface that calls into the worker) to a friendly message: "Wallet auto-locked while this was running. Unlock and try again." Same translation pattern as `E_PASSWORD_WRONG → "Incorrect password."` already in those handlers.

Bonus: the timeout countdown in TopBar could *pause* while a worker call is in flight, so users aren't penalized by the auto-lock during a multi-step export. Add `inflight > 0 → don't tick down`.

---

### INFO

#### I-1. localStorage scope is well-contained — `pearl-wallet-ui-v3` is the only key, and `wipeKeystore` removes it

**File:** `src/storage/db.ts:85-87, 89-108`

Verified: only one localStorage key is used (`pearl-wallet-ui-v3`), and v0.1.8's `wipeKeystore` now scrubs it via the `LOCAL_STORAGE_KEYS` table in a try/finally. The keystore itself is in IndexedDB as ciphertext only. `sessionStorage` is not used. This matches the threat model invariant ("All sensitive data is ciphertext").

The `crypto.randomUUID() / Math.random()` fallback for `SENDER_ID` (wallet-store.ts:82-85) is correctly scoped — it's a per-tab BroadcastChannel tag, never written to disk and never used as a secret. The fallback to `Math.random` is acceptable.

No finding; documenting for the audit-trail since prior audits raised this surface.

---

#### I-2. QR codes contain only the bare address — no extra metadata

**File:** `src/lib/qr.ts`, `src/ui/pages/Receive.tsx:29-32`

`QRCode.toDataURL(text)` is called with `text === addr` — the raw bech32m (for PRL) or hex (for ETH) address. No amount, no label, no timestamp, no per-render randomness. The `qrcode` lib's data-URL output is deterministic for a given input + options (error-correction level "M", width 300, margin 1, fixed colors). Two renders of the same address produce identical PNG bytes.

This is **the correct behavior** for a receive QR — no `bitcoin:`-style URI scheme leakage, no label-correlation across receivers. Verified per the brief's question. No finding.

---

#### I-3. No telemetry / analytics / Sentry / beacon — confirmed by grep

**Searched:** `fetch`, `XMLHttpRequest`, `sendBeacon`, `navigator.sendBeacon`, `gtag`, `plausible`, `Sentry`, `analytics`.

Only three `fetch` call-sites: `/api/prl-price` (CF Pages Function proxy, same-origin), the Pearl RPC URL (`rpc.pearlwallet.xyz` or allowlisted override), and the relay API (`pearlbridge.xyz`-domain). All three are within the CSP `connect-src` allowlist. No external beacons, no error-reporting service, no analytics. The only `console.error` is in `worker-client.ts:27` for worker fatal errors — local devtools only, not networked.

Matches the threat model § T1 ("Keys NEVER leave the browser") and § T2 ("CSP `connect-src` allowlist limits where the bundle can `fetch`"). No finding.

---

#### I-4. Threat model has drifted from code in two minor places

**Files:** `docs/03-THREAT_MODEL.md`, code

- § T2 promises "Sub-Resource Integrity (SRI) on the served `index.html`'s script tags. If the deployed bundle is tampered with post-build, browsers refuse to load it." → `dist/index.html` ships `<script type="module" crossorigin src="/assets/index-DOx6EAJu.js"></script>` with no `integrity=` attribute. Vite does not emit SRI hashes by default. Confirmed via grep on the built artifact.
- § T6 promises "Detect if known wallet extensions are present (`window.ethereum`, `window.bitcoin`, etc.) and warn that *another* wallet is injecting into the page." → No such detection in `App.tsx`, `Splash.tsx`, or any onboarding/unlock surface.

Both are explicit shipping promises in the doc. They're tracked here as INFO so v0.2 planning can either implement them or update the doc to reflect them as roadmap items.

**Fix:** Update `docs/03-THREAT_MODEL.md` to mark these as "deferred to vNext" with a target version, OR implement them. SRI specifically is a `vite-plugin-sri`-shaped problem and small; the wallet-extension probe is ~20 lines. Both should land before the wallet is broadly marketed.

---

## Confirmed v0.1.7 → v0.1.8 fixes

Audited the diff between `6438e48` (v0.1.7) and `79d7890` (v0.1.8) and verified the following prior findings are closed at this HEAD:

- **Sourcemap leak (v0.1.7 H, all four auditors):** `vite.config.ts:21` is `sourcemap: false`. `dist/assets/*.map` files are absent.
- **AAD JSON.stringify non-determinism (v0.1.7 opus2 H):** `keystore.ts:21-30` switched to a fixed pipe-delimited string `pearl-wallet/aad|v=…|kdf=…|iter=…|cipher=…`. Stable across V8/JSC/Bun.
- **Self-broadcast force-lock (v0.1.7 opus2 H3):** `wallet-store.ts:82-85` introduces `SENDER_ID` per-tab; `onmessage` filters `ev.data.sender === SENDER_ID` before processing.
- **`coerceUint` JSON-number precision loss (v0.1.7 opus1 M-1, minimax1):** `bridge.ts:106-127` now rejects `number` type entirely and accepts only canonical decimal strings via `/^(0|[1-9]\d*)$/`.
- **`setTimeout` leak on strength toggle (v0.1.7 opus1 M-5):** `OnboardingCreate.tsx:35-57` lifts the timer ref outside the IIFE so cleanup actually fires.
- **`wipeKeystore` doesn't clear localStorage (v0.1.7 cross-finding):** `db.ts:89-108` wraps the Dexie ops in try/finally and removes `pearl-wallet-ui-v3` regardless of Dexie success.
- **PASSPHRASE_MIN_LENGTH escape hatch (v0.1.7 minimax2 Low):** `validate.ts:43-71` allows 16+ char passphrases with single-class entropy. Comment cites the prior audit explicitly.
- **RPC override host allowlist (v0.1.7 cross-finding on a stale localStorage value):** `ui-store.ts:7-27` adds `isAllowedRpcOverride`, re-validates on `loadUI`, throws at setter, and the CSP `connect-src` matches the allowlist.
- **COOP / COEP / CORP headers (v0.1.7 minimax2 LOW):** `public/_headers` now sets all three.

The v0.1.8 batch is a clean fix-up of the v0.1.7 audit slate. The HIGH findings above are issues either introduced by this batch (H-1, H-2) or pre-existing UX-security gaps that no prior auditor's angle surfaced (M-1 through M-5).

---

## Recommended priority order for v0.1.9

1. **H-2** (Settings crash on rejected RPC) — single try/catch, ~5 lines.
2. **H-1** (iframe-bust dead on mirrors) — move to `main.tsx` first line, or add `script-src 'sha256-…'`.
3. **M-3** (Wipe-from-locked link broken) — add a dedicated wipe-with-phrase route.
4. **M-1** (24-word verify gap) — sample positions by length.
5. **M-5** (clipboard read-back permission prompt) — drop the read-back.
6. **M-2** (address-poisoning defenses) — identicon + bridge-address labels are quick wins; address-book + Levenshtein are larger and can be staged.
7. **L-1 through L-5** — polish.
8. **I-4** — reconcile doc with code.

If broadcast is targeted for v0.2, **M-2 must land first** — the threat model is explicit that those defenses are part of the shipping wallet, and broadcast without them ships a wallet that's strictly less safe than the document promises.

---

*End of report.*
