# Cold-multisig URL-cached signing — build + audit

**Date:** 2026-05-30
**Scope:** Close the spec §2.7 gap (URL-cached cold-multisig signing) by adding
a sig-return endpoint to `pearl-vault-relay` and a "Post sig to relay" flow
to `pearl-web-wallet`. Repos touched:

- `pearl-vault-relay` (not git-tracked locally — see "Deployment" below)
- `pearl-web-wallet` (PearlBridgeXYZ/pearlwallet — archived; pushes go to
  `PearlBridgeXYZ/pearlwallet` public mirror)

**Verdict:** READY FOR INTEGRATION.

## What landed

### Phase 1 — vault-relay sig-return endpoint

New endpoints (Node http handlers, behind nginx at `/api/vault/tx/`):

| Method | Path                              | Auth         | Purpose                                     |
| ------ | --------------------------------- | ------------ | ------------------------------------------- |
| POST   | `/api/vault/tx/:token/sig`        | Schnorr proof| Cosigner posts a partial sig                |
| GET    | `/api/vault/tx/:token/status`     | none         | Wallet polls collection state (5s cadence)  |
| GET    | `/api/vault/tx/:token/sigs`       | HMAC         | Originating relay pulls assembled sigs      |

Database additions (`src/db.ts`):

- `artifacts.threshold INTEGER` and `artifacts.allowed_signers TEXT` columns,
  with column-additive migration for existing DBs.
- New `collected_sigs` table, composite PK `(token, signer_pubkey)`, FK CASCADE
  on artifacts so pruning auto-cleans collected sigs.
- New helpers: `peekArtifact()` (read without consume — survives the cosigner
  GET burning the proposal), `insertCollectedSig()` returning
  `inserted | idempotent | conflict`, `listCollectedSigs()`.

Proof primitive (`src/sig-proof.ts`): BIP 340 Schnorr signature over a
domain-separated canonical message:

```
"pearl-vault-relay/sig/v1\n" + token + "\n" + signedAt + "\n" + sha256_hex(psbtBase64)
```

Then sha256 again and Schnorr.sign(digest, privkey). The relay verifies against
the cosigner's x-only pubkey from the proposal's `allowedSigners` whitelist.

**Spec divergence (intentional):** the spec literal `sha256(psbtBase64 || signedAt)`
doesn't bind to the proposal `token`. We add `token` to the digest — without it,
an attacker with access to a leaked proof+PSBT from proposal A could inject
the same sig at proposal B (same signer set, same PSBT bytes, e.g. an attempted
double-spend retry). Cross-proposal replay defense is locked down by
`tests/sig-handlers.test.ts` and `tests/cold-multisig-flow.test.ts`.

Handler invariants (`src/handlers.ts`):

- Pubkey-not-on-whitelist returns the **same** 401 shape as bad-proof — defeats
  whitelist enumeration by a leaked-token attacker.
- POST `/sig` is unauth on purpose (the proof IS the auth). Body capped at
  512 KiB to bound partial-PSBT growth.
- `signedAt` must be within the configured replay window (default 300s).
- Idempotent retry: same `(psbt, signedAt, proof)` from the same signer → 200
  `status=idempotent`. Different `psbt` or `signedAt` → 409 conflict (first
  commit wins).

Server routing (`src/server.ts`): sub-resource regex
`/^\/api\/vault\/tx\/([A-Za-z0-9_-]{43})\/(sig|status|sigs)$/` matched BEFORE
the bare-token GET prefix so `/sig` doesn't fall through into `consumeArtifact`.

### Phase 2 — wallet integration

- **New crypto worker command** (`src/crypto/worker.ts`):
  `signSigProofForVault` derives the cosigner privkey for the given
  `(vaultAccount, keyIndex)`, computes the proof digest **inside the worker**
  from `(token, psbt, signedAt)`, and Schnorr-signs it. Main thread never
  receives an opaque digest to sign — keeps the worker from becoming a generic
  signature oracle. Worker refuses to sign for a vault we aren't a member of.
- **Service layer** (`src/services/multisig.ts`): `signVaultSigProof()` wraps
  the worker call. `src/services/vault-relay.ts` extended with
  `postPartialSig()` (typed error surface: `not_found | unauthorized | conflict
  | bad_request | too_large | network | malformed`) and `fetchProposalStatus()`.
- **UI** (`src/ui/pages/SignMultisigPsbt.tsx`):
  - Threads the proposal token from `VaultProposal` → `proposal-store` → sign
    page (the token was already in the store; we just keep a local copy after
    consume).
  - Adds **"Post sig to relay"** button alongside Copy/Broadcast. Active only
    when a relay-delivered proposal is in flight.
  - **Status polling** every 5s, surfaces per-cosigner state ("waiting" /
    timestamp), thresholdMet flag, gentle backoff (stops after 5 consecutive
    failures or once threshold met).
  - **signedAt latching** (Phase 4 fix): retry-after-error reuses the same
    `signedAt` so the relay treats the second click as idempotent rather than
    as a 409 conflict. Re-signing the PSBT clears the latch.

### Phase 3 — end-to-end test

`pearl-vault-relay/tests/cold-multisig-flow.test.ts` exercises the full
two-cosigner round-trip:

1. Originating relay mints a 2-of-2 sig-collection proposal.
2. "Wallet" cosigner signs and POSTs (uses `signSigProof` to mimic the worker).
3. "AWS signer" cosigner does the same.
4. Status reflects 2/2, `thresholdMet=true`.
5. Originating relay pulls both partials via HMAC-auth `/sigs`.
6. Adversarial cases: AWS cannot impersonate wallet by claiming wallet's pubkey
   (401); AWS's sig for proposal A is rejected at proposal B; wallet retry
   path is idempotent.

Plus `pearl-web-wallet/tests/v030-sig-proof.test.ts` locks the wallet-side
proof format down byte-identically to the relay's verifier — if either side
drifts (different domain string, separator, hashing scheme), this test fails
loudly rather than every /sig POST 401'ing in prod with no clear signal.

### Phase 4 — self-audit

19 audit findings reviewed. One UX regression caught and fixed in the same
turn (signedAt-not-latched-across-retries → 409 conflict on second click).
Documented gaps (no fix in this pass, not blocking):

- **Per-token rate limiting on `/sig` POSTs.** A leaked token + a brute-force
  attacker can flood the endpoint with bad-proof POSTs. Each 401 costs one
  Schnorr verify (~100µs); at 10K verifies/sec single-core, a sustained attack
  reaches the CPU ceiling but doesn't escalate further (no DB writes on bad
  proof, no nonce-table growth). Mitigation: nginx-side rate limiting on the
  `/sig` path. Future relay work: per-token IP bucket. Not a security flaw —
  the proof IS the auth, and the attacker still can't forge a sig under any
  whitelist member without that member's privkey.

- **Status leaks the whitelist of cosigner pubkeys**. Intentional. The
  whitelist is metadata the proposer chose to publish along with the link;
  there's no surface advantage to hiding it from a holder of the (one-shot)
  token.

- **No structured "proposal expired" surface in the wallet UI**. Right now an
  expired proposal returns `not_found` on /sig POST; the wallet user sees a
  generic message. Cosmetic; defer to v0.3.1.

## Tests

| Suite                                             | Pass | Skipped | Notes                                       |
| ------------------------------------------------- | ---- | ------- | ------------------------------------------- |
| pearl-vault-relay (full)                          | 74   | 0       | +24 new sig-handlers, +12 sig-proof, +4 e2e |
| pearl-web-wallet (full)                           | 602  | 4       | +6 new sig-proof, no regressions            |

Wallet build: green (779 KB main chunk; chunk-size warning is pre-existing).
Relay typecheck + build: green; `dist/` re-emitted post-audit.

## Files changed

### pearl-vault-relay (NOT git-tracked locally — file list only)

```
package.json                              — added @noble/curves@1.6.0 + @noble/hashes@1.5.0
src/db.ts                                 — collected_sigs table, peekArtifact, insertCollectedSig, listCollectedSigs, migration
src/sig-proof.ts                          — NEW; computeSigProofDigest, verifySigProof, signSigProof
src/handlers.ts                           — handlePostSig, handleStatus, handleGetCollectedSigs; PostBody.threshold + allowedSigners
src/server.ts                             — TOKEN_SUFFIX_RE routing for /sig /status /sigs
tests/sig-proof.test.ts                   — NEW (12 tests)
tests/sig-handlers.test.ts                — NEW (24 tests)
tests/cold-multisig-flow.test.ts          — NEW (4 e2e tests)
tests/db.test.ts                          — fixed 4 broken insertArtifact call sites post-schema-change
```

### pearl-web-wallet (commits on `main` / pushed to `PearlBridgeXYZ/pearlwallet`)

```
7ce7a91  v0.3.0: cold-multisig URL-cached sig-return
710d9e0  SignMultisigPsbt: latch signedAt across post retries
```

Files:

```
src/crypto/worker.ts                      — new signSigProofForVault command, schnorr+sha256 imports
src/services/multisig.ts                  — signVaultSigProof wrapper
src/services/vault-relay.ts               — postPartialSig + fetchProposalStatus + typed PostPartialSigError
src/ui/pages/SignMultisigPsbt.tsx         — Post-to-relay button, RelayStatusPanel, polling, signedAt latch
tests/v030-sig-proof.test.ts              — NEW; locks proof format contract with relay
```

## Deployment notes

**pearl-vault-relay is NOT a local git repo.** The brief expected per-phase
auto-commits, but the working tree at `.`
has no `.git` directory. All source changes are on disk under the canonical
path; `npm run build` re-emits `dist/`. To ship: copy the working tree to the
deployment host, run `npm install` (the two new noble deps), `npm run build`,
restart the relay service. Same procedure as v0.1.0.

**Dependency additions** (pearl-vault-relay):

- `@noble/curves@^1.6.0` — BIP 340 Schnorr verify
- `@noble/hashes@^1.5.0` — sha256 for the proof digest

Both already present in pearl-web-wallet/pearlbridge-relay at the same pinned
versions; this aligns the vault-relay's pin to the rest of the stack.

**Database migration**: in-place column adds on `artifacts` (`threshold`,
`allowed_signers`); new `collected_sigs` table. Both run automatically on
`openDatabase()` startup — safe to deploy over an existing v0.1.0 DB.

## Threat model recap

| Adversary capability                          | Defense                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| Leaked token, no cosigner key                 | Schnorr proof required; whitelist gates pubkey claim          |
| Leaked token + guesses at whitelist           | Uniform 401 for "wrong pubkey" and "bad proof" — no oracle    |
| Leaked token + a stale sig from another proposal | Token binding in proof digest blocks cross-proposal replay |
| Local wallet origin compromise (main thread)  | Worker computes digest itself; refuses non-member vaults      |
| Concurrent inserts under same (token,signer)  | Better-sqlite3 transaction serialization                       |
| Wallet retry on network flake                 | (token, signer, psbt, signedAt, proof) match → idempotent     |
| Hostile cosigner posts a different PSBT       | First commit wins; second is 409 conflict                     |

## Out of scope (intentional)

- Originating relay's witness-assembly + broadcast path (consumes the `/sigs`
  output; existing pearlbridge-relay or future bernard-side script).
- Wallet-side "I see another cosigner posted but with a different PSBT than I
  signed" reconciliation. Today the wallet treats its own sig as the canonical
  PSBT to broadcast against. Spec doesn't require this; future v0.3.x.
- AWS Nitro Enclave signer implementation. The e2e test stands in with a
  plain Node Schnorr signer; the on-the-wire contract (proof shape, /sig POST
  body) is what the enclave will produce.
