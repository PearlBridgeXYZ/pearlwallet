# PearlWallet v0.1.12 — focused reaudit (opus pass 1)

**Date:** 2026-05-20
**Auditor:** Opus 4.7 (single-pass, scope-limited to the v0.1.11→v0.1.12 diff)
**Scope:** `src/ui/pages/Bridge.tsx` (rewritten); `package.json` version bump.

## Diff summary

The in-wallet bridge composer (direction toggle, amount entry, fee preview,
confirm-with-password modal, status stepper) is removed and replaced with an
informational page that:

1. Displays both of the user's addresses (Pearl + Eth) via `shortAddr` for
   copy-paste reference.
2. Provides an external link to https://pearlbridge.xyz in a new tab.
3. Provides a back-to-dashboard button.

`src/services/bridge.ts` is untouched and still in use by
`src/services/balances.ts` (WPRL ERC-20 balance reads) and `src/services/eth-tx.ts`
(WPRL transfer config) — the deletion is UI-only.

## Findings

### High — none
No High-severity findings.

### Medium — none
No Medium-severity findings.

### Low

**L-1: External-link hygiene — clean.**
Both `<a>` tags to `https://pearlbridge.xyz` use `target="_blank"` with
`rel="noopener noreferrer"`. Reverse-tabnabbing closed; Referer leak closed.
No remediation required.

**L-2: Forward-looking commitment in copy.**
The footer text reads *"We'll embed the bridge flow directly inside the
wallet in a later release."* This is a soft commitment; if priorities
change and the embed never lands, the copy will eventually drift from
reality. Non-security. Acceptable.

### Informational

**I-1: Address-display parity.**
`shortAddr(addresses.pearl, 12, 8)` and `shortAddr(addresses.eth, 8, 6)`
match the truncation conventions used on Dashboard and Receive. No
inconsistency.

**I-2: No new CSP burden.**
`<a href>` top-level navigation is not subject to `connect-src` /
`script-src` / `img-src`. The wallet's CSP meta is unchanged and remains
valid.

**I-3: Removed remote read on mount.**
v0.1.11's Bridge page called `readBridgeFees("mainnet")` on mount. v0.1.12
removes this call from the UI path. Net effect: one fewer eth_call against
the configured Ethereum RPC per Bridge-page visit. Attack surface
reduction; no regression.

**I-4: Surface tests.**
9 v0.1.11 freshness/ceiling tests untouched. Full suite 204 pass.

## Cross-audit Highs from v0.1.9 — status carried forward

| ID | Title | v0.1.11 | v0.1.12 |
|----|-------|---------|---------|
| O1-H-1 | Hostile baseFee inflation | **FIXED** | unchanged |
| O2-H-1 ≡ M2-H-2 | Preview→broadcast re-quote drift | **FIXED** | unchanged |
| O1-H-2 | iframe-bust 404 silent disarm | open | open |
| O2-H-2 | signPearlTx HRP binding | open | open |
| M2-H-1 | Pearl change-address reuse warning | open | open |

## Conclusion

v0.1.12 is a UX-scope release that narrows the wallet's attack surface
(one fewer remote read on mount, ~200 lines of UI removed). No new
findings. The three open v0.1.9 Highs remain queued for v0.1.13.

— Opus, 2026-05-20
