# Audit — v0.3.0 (vault proposal relay deeplink)

**Auditor:** Opus 4.7 (single pass).
**Date:** 2026-05-28.
**Scope:** v0.2.11 → v0.3.0. Two artifacts:

1. **`pearl-vault-relay`** — new Node service (Node `http` + better-sqlite3, no Express). One-time mailbox for vault transaction proposals. HMAC-authenticated POST; unauthenticated, one-shot, token-keyed GET.
2. **Wallet additions** — `/vault/tx/:token` route, `VaultProposal` page, `proposal-store` (Zustand transient slice), `vault-relay` client, `safeNext` open-redirect guard on `Unlock`, `routeGuardTarget` deeplink rule, prefill hooks in `SignMultisigPsbt` and `SendFromVault`.

The relay is an ephemeral mailbox by design — a "one-time transfer to the signer". No machine wallet, no key custody server-side. The proposer composes an *unsigned* intent (or a PSBT handed in out-of-band) and the wallet on the cosigner's machine does all signing.

## Threat model recap

The relay sees one of two artifact kinds:

- **`tx-intent`** — JSON `{vaultAddress, destination, amountGrains, network?, memo?}`. Unsigned. Worst case if leaked: an attacker knows the cosigner is about to send X PRL from a known vault to a known destination — privacy hit, not a custody hit.
- **`psbt-base64`** — base64 PSBT, may be unsigned or partially-signed. Worst case if leaked: signatures present on the PSBT become public. Threshold isn't breachable from the PSBT bytes alone, but partial sigs leak signer identities and the unsigned tx outputs.

Both kinds are bounded by the wallet's *own* m-of-n threshold check at finalisation. Nothing on the relay can authorise spending.

**Trust boundaries:**

- The HMAC secret is shared between the relay process and authorised proposer CLIs. Anyone with it can mint tokens; anyone without it cannot.
- Tokens are 32-byte random base64url (`/^[A-Za-z0-9_-]{43}$/`). 256-bit entropy — enumeration is not the attacker's path.
- The wallet fetch is unauthenticated. Whoever holds the link is the consumer. This is the *whole point* of "send a link to the cosigner" — but it means anyone who intercepts the URL gets one shot at the contents.

## Findings

### Critical

**None.**

### High

**None.**

### Medium

#### M1. **CSP `connect-src 'self' https:` is broader than the v0.3.0 surface needs**

**Location:** nginx site config on `pearlwallet.xyz` and `pearlwallet.xyz`. Live CSP (verified `curl -sI https://pearlwallet.xyz/`):

```
content-security-policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data:; connect-src 'self' https:; worker-src 'self' blob:;
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
```

**What's the gap:**

The relay client only ever fetches same-origin (`/api/vault/tx/:token`). Everything in the wallet's runtime XHR/fetch surface is same-origin (RPC pool URLs are configured at build time and rewritten at the worker boundary). The current `connect-src 'self' https:` allows a future XSS to exfiltrate over any HTTPS endpoint — vault descriptors, partial signatures, addresses — to an attacker-chosen server.

**Why this matters more in v0.3.0:**

Pre-v0.3.0 the wallet had narrow input surfaces. Now there's a relay-delivered prefill path (`/vault/tx/:token` → proposal-store → `SendFromVault` / `SignMultisigPsbt`). The proposal-store is in-memory only and the consume-once dispatcher prevents replays. But the path widens the failure mode of *any* future XSS: an attacker who lands a script can now also race the wallet to consume tokens from the relay and post elsewhere.

**Severity rationale:**

Medium, not High. The injection prerequisite (XSS on the wallet origin) hasn't been demonstrated, and the relay endpoint itself is same-origin + HMAC-write-only. But narrowing `connect-src` costs nothing and would limit blast radius substantially.

**Recommended fix (post-deploy):**

Tighten `connect-src` to `'self'` only. If the RPC pool needs explicit hosts, list them:

```nginx
connect-src 'self' https://rpc.pearlwallet.xyz https://pearl-rpc.publicnode.com;
```

Filed as a v0.3.1 follow-up. Non-blocking for v0.3.0 ship.

#### M2. **Relay 410 response leaks `consumedAt` timestamp without rate-limiting**

**Location:** `pearl-vault-relay/src/handlers.ts:171–174`

**What's the design:**

When a token is fetched twice, the second response is `410 Gone` with `{consumedAt: <unix>}`. This is deliberate — the originator needs to detect a race / hostile pickup. If the link is intercepted and consumed before the cosigner clicks it, the 410 with `consumedAt` is the *only* signal that something went wrong.

**The minor concern:**

There is no rate limit on the GET endpoint. An attacker who guesses a token via leaked log line (or, vanishingly more likely, brute force) gets a precise consumption timestamp on every probe. With 256-bit entropy, this is theoretical — but a future log handler that prints token prefixes would erode that margin.

**Mitigations already in place:**

- Tokens are 256-bit random — brute force is not a practical attack.
- The relay never logs payloads or tokens (verified by grepping `src/server.ts` and `src/handlers.ts` for `console.log` / `console.error` on token or body content — only structural messages like "request error" are logged).
- nginx fronts the endpoint and could be configured with rate-limit zones if a pattern emerges.

**Recommended follow-up (NOT blocking):**

If the deployment ever pushes traffic logs to a shared sink, add a `limit_req_zone` in nginx keyed on remote IP for the GET path. Not justified for v0.3.0.

### Low

#### L1. **`amountGrains` parsed as JS number could overflow for cosmic amounts** — N/A

**Investigated:** `VaultProposal.tsx:84` does `BigInt(pending.intent.amountGrains)`. Confirmed: the value travels as a string through JSON, parsed as BigInt, never coerced to number on the consumer side. No overflow.

#### L2. **`safeNext` accepts any whitelisted path verbatim — no path normalisation**

**Location:** `src/ui/pages/Unlock.tsx:13–18`

The whitelist matches `/vault/tx/<43 base64url>`. Confirmed `/vault/tx/AAAA…AAAA/extra`, `/vault/tx/AAAA…AAAA?evil=1`, and `/vault/tx/AAAA…AAAA#frag` are all rejected because the regex is anchored. The matrix is tight.

**One subtle case:** `/vault/tx/AAAA…AAAA` followed by `%00` or other URL-encoded chars — the regex character class `[A-Za-z0-9_-]` rejects `%`, so the encoded path is blocked. Verified at line 15 character class.

**Verdict:** clean.

#### L3. **`VaultProposal` strict-mode double-invocation guard uses module-scope-free useRef**

**Location:** `src/ui/pages/VaultProposal.tsx:48–53`

The `fetchedRef.current` guard prevents the one-time GET from firing twice under React 18 strict-mode dev double-mount. Confirmed by code reading. Production strict-mode is off, but having the guard means dev sessions don't accidentally burn a real relay token. Cleanly handled.

#### L4. **`vault-relay.ts` rejects `/api/vault/tx/<token>` if token shape is wrong WITHOUT calling network**

**Location:** `src/services/vault-relay.ts:30`

Token format validated client-side before fetch — minor DoS-mitigation (a malformed deeplink never wakes the server). Tight.

#### L5. **Wallet stamps `credentials: "omit"` on relay GET**

**Location:** `src/services/vault-relay.ts:39`

Defends against a future cookie-bearing extension surface that might inject auth onto same-origin fetches. Belt-and-braces. Clean.

### Informational

#### I1. **Tests cover the surface**

| Surface | File | Cases |
| --- | --- | --- |
| Relay DB layer | `pearl-vault-relay/tests/db.test.ts` | 7 |
| Relay HMAC | `pearl-vault-relay/tests/hmac.test.ts` | 7 |
| Relay handlers | `pearl-vault-relay/tests/handlers.test.ts` | 15 |
| Relay HTTP integration | `pearl-vault-relay/tests/integration.test.ts` | 5 |
| Wallet route deeplink + safeNext + proposal-store | `pearl-web-wallet/tests/v030-vault-proposal.test.ts` | 31 |
| Wallet route guard (regression) | `pearl-web-wallet/tests/v024-route-guard.test.ts` | 66 |

Total wallet suite: 596 pass, 4 skipped (live RPC), no regressions. Relay suite: 34 pass.

#### I2. **No `console.log` of token or payload**

Verified `grep -n "console\." src/handlers.ts src/db.ts src/hmac.ts src/server.ts` shows only `console.error` for structural error paths (DB init failure, prune failure), never with payload or token in the message. The relay never echoes artifact contents to stdout/stderr.

#### I3. **TTL clamp enforced server-side**

Default TTL 86400s (24h); max 604800s (7d). Confirmed `handlers.ts:138` clamps `Math.min(parsed.ttlSeconds, ctx.config.maxTtlSeconds)`. A proposer requesting a 1-year TTL gets 7 days — bounded blast radius if the relay's nonce table is ever lost.

#### I4. **HMAC constant-time compare uses Node's `timingSafeEqual`**

`pearl-vault-relay/src/hmac.ts:32–38` — `constantTimeEqualHex` decodes both hex strings to Buffers (rejecting size mismatch) and calls `timingSafeEqual`. No early-return string compare in the hot path.

#### I5. **One-time consumption is atomic in SQLite**

`pearl-vault-relay/src/db.ts` (`consumeArtifact`) wraps SELECT + UPDATE in a `db.transaction(...)` with `consumed_at IS NULL` as the UPDATE predicate. Two concurrent GETs of the same token cannot both succeed; one gets the artifact, the other gets `{status: "gone"}`. Verified by code reading and by the `db.test.ts` "insert+consume once" + "expired-consumed=gone" cases.

#### I6. **No info leak in 410 body**

The 410 returns `{error: "already consumed", consumedAt}` but does NOT include the consumer fingerprint (which embeds a hash of the consumer IP). The fingerprint is stored server-side for incident triage; the wire response is intentionally minimal.

#### I7. **Open-redirect surface is whitelist-only**

`NEXT_PATH_PATTERNS` has exactly one entry. Tests stake the length so adding a new entry forces an audit pass (see `v030-vault-proposal.test.ts:155`).

## Verdict

Ship v0.3.0. The relay design is conservative — one-time GET, HMAC POST, atomic DB consumption, no key custody, ephemeral by construction. The wallet additions are tightly scoped and well-tested.

Two follow-ups for a future pass, neither blocking:

- **M1**: Tighten `connect-src` from `'self' https:` to `'self'` (+ explicit RPC hosts if needed).
- **M2**: Add nginx `limit_req_zone` on the GET path if traffic patterns warrant.
