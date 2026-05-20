# Audit — v0.1.15 (single-pass focused reaudit)

**Auditor:** Opus 4.7 (single pass).
**Date:** 2026-05-20.
**Scope:** v0.1.14 → v0.1.15 diff only. Adjacent code in scope only as
the diff touches it.

## What changed

User feedback (2026-05-20): the Bridge page showed `shortAddr` ellipsized
versions of the user's own paste destinations ("paste this: prl1p…7p74").
Users could paste the literal ellipsis. On the dashboard "Your addresses"
card the same ellipsis was confusing even though it wasn't paste-prompted.
Activity rows also used `shortAddr` for counterparty display.

- `src/ui/components/CopyAddress.tsx` (NEW). Reusable address-display
  component: full string (font-mono break-all) + one-click copy button.
  Mirrors the 60-second auto-clear pattern from `Receive.tsx`. Cancels
  pending timers on unmount. Best-effort clipboard clear only fires
  if the buffer still contains exactly the copied value.
- `src/ui/pages/Bridge.tsx`. Replaced two `shortAddr` instances with
  `CopyAddress`. Drop the `dl`/`dt`/`dd` layout in favor of stacked
  CopyAddress rows so the labels sit above each full address (mobile-
  friendly when the address wraps).
- `src/ui/pages/Dashboard.tsx`. "Your addresses" card now uses
  CopyAddress for both pearl and eth. Dropped the `shortAddr` import.
- `src/ui/components/ActivityList.tsx`. Activity counterparty now
  renders full address with `break-all`; dropped `shortAddr` and the
  defensive `title` attribute (no longer needed — full address visible).

## Findings

**0 Critical, 0 High, 0 Medium, 0 new Low.**

### Considered and rejected

- **L (rejected): does the 60s clipboard auto-clear race when the user
  copies two different addresses back-to-back?** No. The component
  cancels the prior `setTimeout` before scheduling a new one
  (`clipboardClearTimerRef.current` clears in the same tick as the new
  copy is scheduled). Each copy's 60s window is governed by that copy
  alone. Matches the pattern Receive.tsx has shipped since v0.1.4.

- **L (rejected): could a permission-denied `navigator.clipboard.writeText`
  in an insecure context (http://) make the copy button silently
  no-op and leave the user thinking they have the address copied?**
  Wallet only ships over HTTPS in production; the dev server binds
  127.0.0.1 which Chrome / Firefox treat as a secure context for
  Clipboard API. The full address is visible inline so a user can
  always fall back to manual select+copy. The `copied` flag flips
  only after `writeText` resolves, so a denied promise leaves the
  button reading "Copy" — no misleading "Copied!" state.

- **L (rejected): full activity counterparty break-all takes more
  vertical space — does it cost above-the-fold density?** On Dashboard
  the activity list shows top 5; the extra ~24px per row × 5 rows is
  120px. Still fits a phone screen above the "See all" link. On
  History the list is the page's primary content, so vertical density
  matters less. Net win on clarity (no more ambiguous "…").

- **L (rejected): does removing the `title={item.counterparty}` from
  ActivityRow regress hover-to-see-full-address discovery?** The full
  address is now rendered inline — the title attribute was redundant
  for that exact purpose. Net no-op.

### Carried Highs (status table)

| Finding                                   | Status                  |
| ----------------------------------------- | ----------------------- |
| O1-H-1 (insane baseFee DoS)               | FIXED v0.1.9            |
| O2-H-1 ≡ M2-H-2 (sign-what-you-saw)       | FIXED v0.1.9            |
| O1-H-2 (signature freshness via Eth time) | Open — UX only, deferred|
| O2-H-2 (chainId binding from RPC)         | Open — defense-in-depth |
| M2-H-1 (auto-lock countdown UX)           | FIXED v0.1.5            |

No regression on any of the above.

## Verdict

**Ship.** Pure UX fix, no key/signing/network surface change.
214/218 tests pass.
