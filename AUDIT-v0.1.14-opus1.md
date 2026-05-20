# Audit — v0.1.14 (single-pass focused reaudit)

**Auditor:** Opus 4.7 (single pass).
**Date:** 2026-05-20.
**Scope:** the v0.1.13 → v0.1.14 diff only. Adjacent code is in scope
only as far as the diff touches it. Prior-version Highs are tracked in
the cross-audit table at the end.

## What changed

- `src/services/activity.ts:searchrawtransactions` — mirror the 3-attempt
  5xx retry policy from `src/services/pearl-rpc.ts:call()`. Justification:
  measured 9/20 transient nginx 503s under concurrent load against the
  public sentry on 2026-05-20. The previous direct-fetch shape would
  flag the entire pool walk `partial` on a single 5xx, surfacing
  "Pearl scan partial — sentry errors on some addresses" to users
  with a healthy wallet.

- `tests/activity.test.ts` — new test "retries transient 5xx and keeps
  pearlSource='live' when sentry recovers". Asserts the retry layer
  absorbs two 503s on a pool address and round-trips live. The
  pre-existing "marks pearlSource='partial' when a pool address errors
  but the rest succeed" test remains green because the mock there
  returns 503 *forever*, exhausting all three attempts.

## Findings

**0 Critical, 0 High, 0 Medium, 0 new Low.**

The diff is narrow, mirrors a long-standing pattern in `pearl-rpc.ts`
(in production since v0.1.7), and is bounded by `ACTIVITY_RPC_ATTEMPTS
= 3` so it cannot infinite-loop. The retry only fires on 5xx — any
4xx (incl. CORS denials) still throws on the first attempt, so the
fix does not paper over a genuinely unreachable sentry. The fail-soft
boundaries (`failures++` on hard error, `failures > pool.length / 2`
flip to `error`) are unchanged: the retry only changes whether a
transient blip *becomes* a hard error.

### Considered and rejected

- **L (rejected): retry adds 0–750ms per failing address — could the
  pool walk now block the UI longer?** No. The walk runs in React
  Query under a 90s refetch with `enabled: !!addresses` and the
  ActivityList already shows a "Scanning Pearl + Eth…" skeleton during
  the load. Worst case 20 pool addresses × 750ms = 15s, well inside
  the existing UX expectation. Caller still resolves to live data,
  not an error.

- **L (rejected): could the retry cascade with the per-address
  300ms `await` cushion to amplify load on a struggling sentry?** No.
  The 300ms cushion sleeps *between* pool addresses; the new retry
  only retries *one* failing call before moving on. Total RPS to
  the sentry is bounded by (1 call per address) × (≤3 retries) × (one
  address in flight), which is strictly less aggressive than the
  balance walk (already in production, no observed sentry trouble).

- **L (rejected): does the retry leak the previous response body
  on retry?** No — `fetch` discards the prior Response when we
  `continue` the loop. No reader was started.

## Cross-audit Highs status (carried)

Tracking the prior multi-auditor cross-Highs that earlier versions
flagged but had not closed before v0.1.14:

| Finding                                   | Status                  |
| ----------------------------------------- | ----------------------- |
| O1-H-1 (insane baseFee DoS)               | FIXED v0.1.9 (MAX_BASE_FEE_WEI) |
| O2-H-1 ≡ M2-H-2 (sign-what-you-saw)       | FIXED v0.1.9 (FrozenEthGas)    |
| O1-H-2 (signature freshness via Eth time) | Open — UX only, deferred       |
| O2-H-2 (chainId binding from RPC)         | Open — defense-in-depth        |
| M2-H-1 (auto-lock countdown UX)           | FIXED v0.1.5                   |

No v0.1.14 diff regression on any of the above.

## Verdict

**Ship.** The retry mirror is the minimum-surface fix to the
load-induced false-partial. Both the new and pre-existing partial
tests pass, full suite 214/218 (4 skipped live-RPC tests).
