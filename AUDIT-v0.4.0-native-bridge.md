# AUDIT — PearlWallet v0.4.0 native bridging

Two independent adversarial audits (2026-06-10) of the native PRL↔WPRL
wrap/unwrap feature. Threat model: `api.pearlbridge.xyz` may be MITM'd or
compromised; the wallet handles real mainnet funds. Both auditors converged
on the same loss-of-funds class. All findings below are **fixed** in this
commit unless marked otherwise.

## Findings + dispositions

### C1 / H-1 — wrap & unwrap sent the API's echoed amount, not the user's input. FIXED.
The send/burn principal was read from `quote.amount` (the API echo). A
compromised API could inflate it and over-send. **Fix:** the locally-parsed
`grains` is the only amount ever signed; both flows assert `quote.amount ===
grains` at preview AND re-assert at confirm time; mismatch throws
`E_QUOTE_AMOUNT_MISMATCH`. Tests cover the round-trip and the mismatch
rejection.

### H-2 — wrap deposit address is API-controlled; same-session re-fetch was theater vs a persistent compromise. MITIGATED.
The wallet cannot derive the relay's HD deposit address independently, so a
persistent compromise returning the same attacker `prl1…` on every fetch
defeated the re-fetch check. **Mitigations shipped:**
- **Trust-on-first-use:** `resolveDepositAddress` pins the first address seen
  per eth-address (in the addressBook table) and refuses forever if it ever
  changes (`E_DEPOSIT_ADDRESS_CHANGED`). Test covers the persistent-swap
  refusal.
- **Visible verification:** the deposit address is shown in the wrap card
  with a prompt to verify against pearlbridge.xyz before sending.
- **Honest comment:** the overclaiming "compromised API cannot redirect
  funds" header was corrected — that guarantee holds for unwrap, not wrap.
- **Residual:** a compromise active during the *very first* wrap for an eth
  address. Real fix = relay publishes the derivation xpub for local
  verification — tracked as a follow-up task, not in scope for the beta.

### H-2 (burn side) — VERIFIED SOUND, no change.
Both auditors confirmed: approve/requestBurn target only the PINNED
network.ts constants, never API addresses; the quote plan is cross-checked
against them (catches reordered steps); payout Pearl address is the wallet's
own. No API-supplied address reaches the signer on unwrap.

### H2 (orphan) — record persisted after the irreversible send. MITIGATED.
A crash between broadcast and the local `put` orphaned the crossing.
**Fixes:** (a) a recovery tick calls `/v1/deposits/recent?ethAddress=` and
re-adopts any relay-indexed deposit with no local record; (b) a failed
post-send `put` now surfaces a loud "SAVE THIS txid" error instead of a
generic failure. Burn side: same loud-save on post-burn `put` failure.

### H3 / M1 — burn lifecycle sets contained doc-vocabulary, missed `reorged`. FIXED.
`BURN_TERMINAL_OK` was `{unlocked,finalized,succeed}` (only `finalized`
real); `reorged` (relay watcher emits it) was unclassified → crossing stuck
on "bridging" forever. **Fix:** sets pinned to the relay's actual emitted
states — OK=`{finalized}`, FAIL=`{failed,reorged}` — with a test asserting
in-progress states (`pending/signing/submitted/under_review`) stay
non-terminal.

### M2 — paused check was preview-only. FIXED.
`wrap()`/`unwrap()` now re-read the quote (which carries `paused`) at confirm
time and refuse if the bridge paused after the page loaded.

### M3 — pre- vs post-broadcast errors indistinguishable. FIXED.
Post-send `put` failures get a distinct "funds moved, save this txid"
message; an approve-landed-but-burn-failed case names the approve tx and
says no re-approve is needed.

### M1 (nonce race, second auditor) — ACCEPTED, low residual.
Approve and burn each re-read the pending nonce; normally correct ordering.
A fallback-failover between the two reads could collide nonces and drop the
burn broadcast — no fund loss (approve stands, retry skips it). Noted; not
blocking for beta.

### L1 — `bridgeCrossings` grows unbounded. ACCEPTED for beta.
Done/failed rows are never pruned. No corruption (keyed by primary id;
poller excludes terminal rows). A "clear settled" action is a follow-up.

### L3 — CSP divergence between index.html and _headers. FIXED.
The sentry RPC hosts present in `_headers` were mirrored into the index.html
meta CSP so non-Cloudflare deploys don't break Pearl RPC.

## What both auditors confirmed sound
- Decimal handling: WPRL consistently 8-decimal grains; no 18-decimal trap,
  no BigInt/Number precision loss anywhere in the bridge path.
- Approval is exact-amount (not infinite); no infinite-approval drain.
- Unwrap path is API-substitution-proof for addresses.
- Poller writes are per-record; no cross-record corruption or phase
  regression.

## Test coverage
`tests/bridge-v1.test.ts` — 15 tests: amount round-trip + precision, quote
parsing + hostile-shape rejection, burn-plan address extraction, deposit
address shape + rate-limit, TOFU pin + persistent-swap refusal, lifecycle
classification (incl. reorged), 404 tolerance. Full wallet suite: 617 passed.

## Round 2 (verification re-audit) + round-3 fixes

A second pass verified every round-1 fix against the relay source and found
two beta-blockers the first round introduced/missed, now fixed:

- **H3/M1 (reworked):** lifecycle replaced with `classifyMint`/`classifyBurn`.
  `under_review` (both directions) is its own non-terminal "review" phase
  (can still resolve to minted/refunded) instead of hanging silently as
  "bridging". A mint with `refundedAt` set terminalizes as "refunded"
  regardless of state (relay F-13). **Any unknown future state classifies
  as "review", never a silent hang.**
- **N1 (fixed):** recovery tick only adopts `MINT_IN_FLIGHT` states, so a
  failed/cancelled/under_review/refunded mint is never resurrected as a
  fresh "confirming" zombie.
- **N2 (fixed):** unwrap re-reads WPRL allowance at confirm time and gates
  the approve on the fresh value, not the preview's `needsApprove`.
- **N3 (fixed):** TOFU pins moved to a dedicated `bridgeDepositPins` table
  (db v4, idempotent put), no longer overloading the address book.
- **Round-2 item 1 (fixed):** `wipeKeystore` now clears `bridgeCrossings`
  and `bridgeDepositPins` — no bridging-history leak, no inherited deposit
  pin on a same-browser re-import.

Round-2 verdict: both beta-blockers closed, N2/N3 addressed, no regressions
from the refactor. Verified states walked exhaustively through the
classifiers and pollers. Tests: `tests/bridge-v1.test.ts` 16, full suite
618 passed.
