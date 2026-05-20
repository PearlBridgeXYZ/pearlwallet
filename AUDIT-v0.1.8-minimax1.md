# Security Audit Report: Pearl Web Wallet v0.1.8

**Auditor:** MiniMax Model (Independent Security Review)
**Target:** Pearl Web Wallet v0.1.8 (commit `79d7890`)
**Date:** May 20, 2026
**Scope:**
- `src/services/bridge.ts` — EIP-712 mint signature surface
- `src/services/pearl-rpc.ts` — UTXO walk + degraded handling
- `src/services/balances.ts` — pool aggregation + degraded propagation
- `src/crypto/keystore.ts` — AAD canonicalization, PBKDF2 params, salt
- `src/crypto/worker.ts` — session lifecycle, hex coercion, origin guard
- `src/crypto/hd.ts` + `src/chains/pearl/address.ts` — HD derivation, BIP-86 tweak, bech32m
- `src/chains/pearl/network.ts`, `src/chains/ethereum/network.ts` — chain pins, allowlist, contract addresses
- `src/lib/validate.ts` — bech32m address validation, passphrase escape hatch
- `src/state/ui-store.ts`, `src/state/wallet-store.ts`, `src/storage/db.ts` — RPC override allowlist, localStorage scrub
- `index.html`, `public/_headers`, `vite.config.ts` — framing/COOP/COEP/sourcemap

**Angle:** adversarial protocol & cryptographic — relayer signature replay, EIP-712 domain integrity, AAD canonicalization, hostile-sentry UTXO ledger correctness, HD derivation isolation, bech32m parser strictness. Differentiated from concurrent Opus audits that emphasize web-platform / lifecycle attack surface.

---

## Executive Summary

v0.1.8 lands a focused audit batch that closes the v0.1.7 consensus blockers: sourcemaps are off in production, the AES-GCM AAD is now a deterministic byte sequence (no JSON-key-order dependency), `coerceUint` is now strict canonical decimal, the UTXO walk gives `degraded:true` instead of throwing into the pool, COOP/COEP/iframe-bust are wired, and the mnemonic is wiped from `WorkerSession` once derivation completes.

From the adversarial-protocol angle the bridge mint pipeline is in good shape: EIP-712 domain pins (`name`/`version`/`chainId`/`verifyingContract`) bind the relayer's payload to RC5 mainnet, the `IntentExpectation` binding is type-required, the deadline check uses bigint arithmetic, signer recovery is followed by an on-chain `hasRole(RELAYER_ROLE, signer)` lookup, and v0.1.6-era sigs targeting the dead RC3 verifyingContract cannot replay against an RC5 client.

The crypto remains PBKDF2-HMAC-SHA256 at 600k iterations (acceptable, but the v0.1.8 passphrase-length escape hatch widens the worst-case attacker advantage in a way that deserves a note). The AAD `pearl-wallet/aad|v=...|kdf=...|iter=...|cipher=...` is a clear improvement over JSON, but the format is field-shift-ambiguous if the kdf/cipher strings ever come from outside the keystore module — a structural observation worth recording before that gets called from a future feature.

**Severity counts:** HIGH 0, MEDIUM 2, LOW 4, INFO 5.

Recommended for production deploy after addressing M-1 and M-2 (both are defense-in-depth — neither is currently exploitable).

---

## Findings

### MEDIUM — M-1: 16-digit numeric passphrase has ~53 bits of work-factor under 600k PBKDF2

**File:** `src/lib/validate.ts:43-71`, `src/crypto/keystore.ts:4`

**Description:** v0.1.8 added a length-entropy escape hatch: passwords ≥16 characters bypass the two-class requirement (`passwordAcceptable`). The escape hatch correctly admits XKCD-style passphrases ("correcthorsebatteryst"), which carry ~80+ bits of entropy from a word list. It also admits, with no further check, a 16-digit numeric string ("1234567890123456"), which the v0.1.8 test suite explicitly canonicalizes as acceptable (`v018.test.ts:184`).

A 16-character decimal-only passphrase has `log2(10^16) ≈ 53.15` bits of search space. PBKDF2-HMAC-SHA256 at 600k iterations adds ~19 bits of attacker work, for an effective ~72 bits against a 2026-grade GPU rig (RTX 5090 class). That is brute-forceable in a few weeks of single-rig wall time, or hours on a modest cluster, given offline access to the keystore blob (e.g. a device-access attacker who exfiltrates IndexedDB).

By contrast a 16-character Latin alphabet passphrase (lowercase only) has `log2(26^16) ≈ 75` bits = ~94 effective with KDF — fine. The class-mix bypass is correct for word-list passphrases and wrong for digit-only strings drawn from the same length pool.

**Impact:** A user who reads "16 characters is enough" from the v0.1.8 UI hint and picks "0000000000000000" or a 16-digit PIN-style passphrase gets a keystore that resists offline brute force only at the level of a moderate 2018-era password — well below the wallet's stated security promise of "your password is your last line of defense." Loss-of-funds path is: physical device touch → exfiltrate `pearl-web-wallet` IndexedDB → run `hashcat -m 10900` against the blob → mnemonic in <1 week.

**Recommendation:**
1. Require ≥2 character *classes* OR an entropy-equivalent rule when the input is detectably mono-class. A simple rule: at length 16–19, require ≥2 classes (revert to v0.1.7 floor at that band); at length ≥20, allow mono-class. This still admits "correcthorsebattery" (19 chars but lower+lower = 1 class, fails) — adjust to: at length ≥20, allow mono-class; at length 16–19, require ≥2 classes; mono-digit always rejected.
2. Alternative: explicit check that rejects all-digit strings shorter than 24 chars. Pure decimal digits is the dominant footgun pattern — users default to PIN-like strings.
3. Documentation alone (UI hint "use a passphrase, not a PIN") is *not* enough — the test suite enshrines the digit-only case as accepted, future contributors will preserve it.

**Severity:** MEDIUM. Currently exploitable only against users who follow the new escape hatch unwisely, but the test suite documents the path as intentional.

---

### MEDIUM — M-2: AAD pipe-separator format is field-shift-ambiguous if any parameter is caller-controlled

**File:** `src/crypto/keystore.ts:21-30`

**Description:** v0.1.8 replaced JSON.stringify with a fixed pipe-delimited string:

```
pearl-wallet/aad|v=${version}|kdf=${kdf}|iter=${kdfIterations}|cipher=${cipher}
```

This is a deterministic byte sequence — that part is correct, and resolves the v0.1.7 minimax LOW about V8 insertion-order reliance. However, the format itself has two structural properties that will matter if any of these parameters ever become caller-controlled:

1. **No length prefix on any field.** A `kdf` string containing `|iter=...|cipher=...` characters would produce an AAD identical (up to field-name shifting) to one generated from a different parameter tuple. Today all four params are fixed at module scope (line 33: `computeAAD(SUPPORTED_BLOB_VERSION, "PBKDF2-SHA256", KDF_ITERATIONS, "AES-256-GCM")`), so no collision is reachable. Future work — e.g. user-selectable KDF on an Argon2id migration, or a relayer-supplied parameter set — would unlock this trivially.
2. **No trailing terminator.** A future v2 that appends a fifth field (e.g. `|keylen=256`) and a hypothetical attacker who can supply a v1 blob with `cipher="AES-256-GCM|keylen=256"` would produce the same AAD bytes as a v2 blob with the same param triple. The v2 blob would decrypt against v1 ciphertext on `decryptBlob` because that function reads `blob.aad` verbatim and feeds it to WebCrypto — `aad` is not recomputed from blob fields, only the *fresh-encrypt* path uses `AAD = computeAAD(...)`.

**Impact:** Today: zero exploitability (params are all constants, only one call site of `computeAAD`). On a single-line refactor that wires user-supplied params into `computeAAD`, the AAD-binding security claim collapses silently. This is the classic "canonicalization debt" pattern — the bug is *latent* in the design until someone reaches for the dial.

**Recommendation:** Make the format robust now, while only one call site exists:
- Either escape `|` and `=` in field values (e.g. percent-encode), or
- Reject any non-canonical character in `kdf`/`cipher` at the boundary (`/^[A-Za-z0-9\-]+$/`), or
- Use length-prefixed framing: `pearl-wallet/aad\x01\x00\x00\x00\x01\x00\x00\x00\rPBKDF2-SHA256...` (binary), or
- Adopt a single SHA-256 hash of a CBOR-encoded record as the AAD — fixed length, no escaping concerns.

The reject-non-canonical-chars option is the smallest diff and forecloses the bug class.

**Severity:** MEDIUM-LATENT. Not currently exploitable; flagged so the fix lands before the call site count grows.

---

### LOW — L-1: Relayer mint payload validates fields against `expected` but does NOT validate `nonce` or `sdiHash` length

**File:** `src/services/bridge.ts:72-144, 162-205`

**Description:** `normalizeRelayerMintSig` enforces canonical decimal on `amount`/`nonce`/`deadline` and rejects malformed addresses, but `sdiHash` is validated only as `typeof === "string" && startsWith("0x")` — no length check. A relayer could send `sdiHash: "0x"` (2 chars) or `sdiHash: "0x" + "ab".repeat(64)` (130 chars) and the typed-data signer recovery will still happen — viem will pad/coerce per its own rules, but the bytes32 field is supposed to be exactly 32 bytes encoded as 66-char hex.

Similarly, `recipient` is validated as `startsWith("0x")` but no length / checksum check. viem's `recoverTypedDataAddress` is lenient on input formats. A short or long recipient could cause the recovered signer to differ from what an Ethereum node would compute on the same payload, producing a relayer-impersonation false-positive on the wallet side and a contract revert on broadcast. Net result is failed UX, not loss of funds (the `expected.recipient` mismatch check at line 182 catches recipient corruption first because both sides go through `.toLowerCase()` comparison).

**Impact:** UX-only DoS by a malicious relayer that returns garbage hex; defense-in-depth gap. No fund loss reachable because the on-chain `mint` call would revert on the same malformed payload.

**Recommendation:** Add strict length validators in `normalizeRelayerMintSig`:
```ts
if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) throw new Error("E_SIGNATURE_MALFORMED");
if (!/^0x[a-fA-F0-9]{64}$/.test(sdiHash)) throw new Error("E_SIGNATURE_MALFORMED");
if (!/^0x[a-fA-F0-9]{130}$/.test(obj.signature)) throw new Error("E_SIGNATURE_MALFORMED");
```

**Severity:** LOW.

---

### LOW — L-2: `expected.sdiHash` comparison is case-insensitive but bytes32 hashes are case-irrelevant — accidental input weakness

**File:** `src/services/bridge.ts:188`

**Description:** The binding check uses `sig.payload.sdiHash.toLowerCase() !== expected.sdiHash.toLowerCase()`. Hex is case-insensitive on the wire, so this is correct in practice. However, the *caller* who constructs `expected.sdiHash` could pass a hash with leading-zero stripping or an off-by-one length and the binding check would silently accept a mismatch in the high bytes. Example: caller passes `expected.sdiHash = "0x0"` (the canonical-zero), relayer returns `"0x00...00"` (66 chars all zero) — both lowercase strings are *different* but both represent bytes32(0). The `!==` would fire, throwing E_SIGNATURE_SDI_HASH_MISMATCH on a sig that's actually correct.

The flip side is more concerning: a relayer that returns `"0x0123" + "00".repeat(30)` (66 chars) when the caller expected `"0x0123"` — the lengths differ, the `.toLowerCase() !==` triggers a mismatch error, and the wallet refuses a sig that the on-chain contract would accept. No fund loss; DoS-shaped.

**Impact:** No fund loss path. Possible false-negative signature rejection if caller is sloppy about sdiHash normalization. Symptom: bridge UI stuck at "verifying signature" with no recovery.

**Recommendation:** Normalize both sides to a canonical `0x` + lowercase 64-hex-char form before comparison. The simplest fix is to introduce a `normalizeBytes32(hex: string): hex` helper used on both `expected.sdiHash` at intake and on `sig.payload.sdiHash` in `normalizeRelayerMintSig`.

**Severity:** LOW.

---

### LOW — L-3: Hostile-sentry over-credit (omitting spend tx) inflates displayed balance

**File:** `src/services/pearl-rpc.ts:136-203`

**Description:** The two-pass walk correctly handles in-page vin/vout ordering — vouts are credited before vins are debited within a single page, so a hostile sentry can't reorder a debit ahead of its credit *on the same page*. However, the walk has no cross-page integrity proof: if a sentry returns page N containing tx A (credit `A:0 = 100 PRL`) but *omits* page M containing tx B (which spends `A:0`), the wallet sees a UTXO that has actually been spent on chain. The walk's `seenOutputs` set carries credits across pages; it cannot un-credit a UTXO whose spending tx was withheld.

This is the dual of the vin-orphan case the audit prompt asked about: an orphan vin (referring to a txid never seen) is benign — `utxo.delete(key)` is a no-op, no negative grain count is possible (the Map only stores credits). The *opposite* — orphan vout, where a spent UTXO is left credited because the spending tx is hidden — is exploitable for **UX deception**, not fund theft.

**Impact:** A hostile sentry can show a user an inflated PRL balance. The user attempts to send the inflated amount; the broadcast fails because the UTXO doesn't exist on-chain. No fund loss; phishing-shaped UX harm (e.g. tricking a user into believing a payment arrived when it didn't, leading to off-chain delivery of goods).

**Recommendation:** Defense-in-depth options:
- Cross-check `getrawmempool` + `getbestblockhash` for the chain tip when the walk completes; refuse to trust the walk if the tip's blockhash chain doesn't link to recent block headers from a *different* sentry. Out of scope for v0.1.x — flagged as INFO-deferred.
- Alternative cheaper mitigation: when `degraded:true` is set, also surface a "this RPC may be incomplete" warning in the UI distinct from the existing "partial" label. Today both walk-cap-hit and per-address-failure surface as "partial"; an over-credit cannot be detected client-side, so the user must be conditioned to treat custom-RPC balances with suspicion.
- Strongest fix: pin the canonical sentry as the only RPC source for *balance* (allow custom RPC only for *broadcast*), and label custom RPC as "untrusted balance source." This is policy, not code.

**Severity:** LOW. Mitigated in practice by the RPC override allowlist (ui-store) restricting custom RPC to 4 known hosts.

---

### LOW — L-4: PBKDF2-HMAC-SHA256 at 600k iterations is at the floor of OWASP 2026 recommendations

**File:** `src/crypto/keystore.ts:4`

**Description:** OWASP Password Storage Cheat Sheet (as of 2026Q1) recommends PBKDF2-HMAC-SHA256 at *1,000,000* iterations minimum, or migration to Argon2id (memory-hard) at the wallet/keystore tier. v0.1.8 retains 600k (the v0.1.6 setting), which was OWASP's floor in 2023 and is now considered "acceptable for legacy" rather than "current recommendation."

The wallet's threat model assumes brief device-access attackers can exfil the keystore blob; PBKDF2 iterations are the only barrier between exfil and offline brute force. At 600k SHA-256 iterations a 2026-grade GPU rig (~10 GH/s for PBKDF2-SHA256) finishes ~16k passwords/second per GPU. Against a strong passphrase this is irrelevant; against a moderate passphrase (8–10 char mixed) it's recoverable in days.

**Impact:** Acceptable today against most users with strong passphrases. Combined with M-1 (16-digit numeric passphrase accepted), the iteration count is the user's only meaningful protection against offline brute force — and 600k buys ~19 bits of attacker work, half of what 1.2M would buy.

**Recommendation:**
1. Bump to 1,200,000 PBKDF2-HMAC-SHA256 iterations. Cost: ~2x unlock latency (~600ms → ~1.2s on a mid-tier laptop). Acceptable trade.
2. Or migrate to Argon2id (recommended): m=64MiB, t=3, p=1. Requires WASM dependency (argon2-browser ~28KB compressed). One-time blob version bump from 1 → 2 with the v0.1.7 `E_UNSUPPORTED_BLOB_VERSION` migration path the keystore already supports.
3. Salt is correctly 16 bytes from `crypto.getRandomValues` — that part is fine.

**Severity:** LOW. Recommended for the next minor.

---

### INFO — I-1: BIP-86 path for Pearl uses non-hardened receive index — standard, but worth recording

**File:** `src/crypto/hd.ts:13, 24-28`

**Observation:** Pearl L1 derivation is `m/86'/808276'/0'/0/i` — coin_type 808276 (ASCII-pack "PRL") matching btcd-oyster, account 0 hardened, change 0 (external receive), index i non-hardened. The 20-address receive pool runs i ∈ [0, 19]. This is standard BIP-86 and matches the upstream wallet per the comment at lines 4-8.

The xpub at depth 4 (`m/86'/808276'/0'/0`) suffices to derive all 20 receive addresses; if that xpub ever leaks (it does not, currently — no xpub is exported by the worker), every receive address becomes linkable. The mitigation is that the worker only exposes per-address pubkeys and the *encrypted* keystore — never the parent xpub. Good.

Cross-chain isolation between Pearl and Ethereum is preserved at the BIP-32 level: different coin_types and different hardened child branches (`86'` vs `44'`) mean compromise of any Pearl child key cannot derive any Ethereum child key (and vice versa). Compromise of the *mnemonic* compromises both — expected behavior, documented in `06-CRYPTO.md`.

**Severity:** INFO.

---

### INFO — I-2: EIP-712 `version: "2"` is hardcoded — not read from contract

**File:** `src/services/bridge.ts:170-175, 220-225`

**Observation:** The wallet pins `version: "2"` in the EIP-712 domain. This must exactly match the `EIP712_VERSION()` constant in BridgeController.sol at `0xA6571B73489d4eBFA269a107208665dF7C80Aef5`. If RC5.6 or later bumps that version (legitimate or accidental contract upgrade — the contract is UUPS), the wallet's domain separator no longer matches the on-chain `_hashTypedDataV4` and *all* relayer signatures would be rejected client-side.

A defensive design would query the version from the contract on first verification and cache it. Today this is not done; the wallet would fail-closed (refuse all bridge mints) on a version bump, which is safer than fail-open but creates a single-string-mismatch denial-of-service path for the *legitimate* protocol operator.

**Impact:** No security regression — fail-closed is correct. Operational fragility only.

**Recommendation:** Add a runtime check on boot: read `EIP712_VERSION()` from the controller and compare to the hardcoded "2"; surface a banner if mismatched. The bridge integration doc §"Reference contract addresses" already calls for `Runtime check: on app boot, fetch contract state and compare to constants` — extend that to include the EIP-712 version.

**Severity:** INFO.

---

### INFO — I-3: bech32m address validation correctly rejects mixed-case but accepts all-uppercase

**File:** `src/chains/pearl/address.ts:81-98`, `src/lib/validate.ts:5-7`

**Observation:** @scure/base's `bech32m.decode` rejects mixed-case strings (verified: `bech32m.decode("Prl1...")` throws "String must be lowercase or uppercase"). All-uppercase decodes successfully and the parser normalizes the HRP to lowercase, so an all-uppercase Pearl address `PRL1P5F450...` validates as equivalent to its lowercase form. This is BIP-350 conformant — the all-caps form is a designated canonical alternate for QR-code efficiency.

`validPearl(addr, net)` does `addr.trim()` (good — strips whitespace) and passes to `isValidPearlAddress`. No additional case-folding is applied; the underlying bech32m parser handles it. HRP mismatch is explicitly rejected (`expected HRP "prl"`), witness version is checked against 1 (Taproot), program length is checked against 32. Solid.

One nit: the HRP check at `address.ts:85` is `decoded.prefix !== params.hrp` — strict equality on lowercase. Because the parser normalizes uppercase HRPs to lowercase before exposing `prefix`, this works for both cases. No fix needed; just confirming the test plane is complete.

**Severity:** INFO.

---

### INFO — I-4: Relayer signature replay across versions is properly prevented by domain pins

**File:** `src/services/bridge.ts:170-175`

**Observation:** A v0.1.6 client signed/issued mint targeting RC3 (`verifyingContract: 0x5b2C...`) and a v0.1.8 client recomputing against RC5 (`verifyingContract: 0xA6571B73...`) produce different EIP-712 domain separators. ECDSA recovery would yield a different signer for the same `(r,s,v)` against the new domain, and the `hasRole(RELAYER_ROLE, signer)` check would fail because the recovered address is uncontrolled — no replay path. Similarly, the `chainId` pin (1 for mainnet, 11155111 for sepolia) prevents cross-chain replay.

The `nonce` field in the Mint type is also bound by the relayer's signature, and the on-chain BridgeController is expected to maintain a `usedNonces` map — but the wallet itself does no per-nonce dedup. That's correct: nonce reuse protection is the contract's job, not the client's.

**Severity:** INFO. Verified safe.

---

### INFO — I-5: No `approve(MaxUint256)` path observed; WPRL burn flow uses contract-side burn

**File:** `src/services/bridge.ts` (entire), `src/chains/ethereum/wprl.ts:1-10`, `docs/05-BRIDGE_INTEGRATION.md:94-97`

**Observation:** The audit prompt asked about WPRL allowance race. v0.1.8 has *no* implemented broadcast for either PRL→WPRL mint or WPRL→PRL burn — the UI exposes only the disabled Send screens, with allowance / approve / mint / burn paths flagged TBD per `08-BUILD_PLAN.md`. The `readWprlBalance` function reads ERC20 balance only; no `approve` call is made anywhere in v0.1.8.

Per `05-BRIDGE_INTEGRATION.md` §"WPRL → PRL" the planned flow is `bridge.burn(amount, pearlRecipient)` — i.e., burn-from-self, which is allowance-free (the user's wallet calls `burn` on its own tokens). If the final implementation lands a `burnFrom`-based design with intermediate allowance, MaxUint256 approvals MUST be avoided in favor of exact-amount approvals per-burn, with the approval and burn batched as an `eth_sendBundle` or sequenced with strict revert-on-front-run logic.

**Severity:** INFO. No allowance code present in v0.1.8; flagging the design constraint for whoever lands the burn flow.

---

## Confirmed v0.1.7 → v0.1.8 fixes

The following v0.1.7 audit findings (across both minimax reports) are confirmed closed by this v0.1.8 cycle:

| v0.1.7 ID | Description | v0.1.8 fix |
|-----------|-------------|------------|
| minimax1 HIGH / minimax2 HIGH-1 | Sourcemap leakage in production | `vite.config.ts:26` → `sourcemap: false`; duplicate `vite.config.js` deleted (verified by `v018.test.ts:315-326`) |
| minimax1 LOW (AAD JSON-key-order) | AAD construction relies on V8 insertion order | `keystore.ts:21-30` pipe-delimited canonical bytes (verified by `v018.test.ts:151-173`) |
| minimax2 MEDIUM-2 (worker origin) | Worker `onmessage` had no origin check | `worker.ts:304-317` adds `ev.origin !== self.location.origin` reject with explicit `""` exception for file:// / Node test env |
| minimax2 MEDIUM-4 (coerceUint edges) | Whitespace / hex / scientific notation acceptance | `bridge.ts:106-127` strict regex `/^(0|[1-9]\d*)$/`, rejects hex / leading-zero / whitespace / signed / fraction / exponent (verified by `v018.test.ts:98-149`) |
| minimax2 LOW-5 (COOP/COEP) | Missing Cross-Origin-Embedder-Policy | `public/_headers:8-10` adds COOP same-origin, COEP require-corp, CORP same-origin (verified by `v018.test.ts:337-345`) |
| opus2 H3 (BroadcastChannel self-fire) | Tab posting `changePassword` would force-lock itself | `wallet-store.ts:82-85, 200-206` adds `SENDER_ID` + self-filter on `onmessage` (verified by `v018.test.ts:268-281`) |
| opus2 H4 (mnemonic in WorkerSession) | Mnemonic resident in worker heap past derivation | `worker.ts:35-40` removes `mnemonic` field from `WorkerSession`; `wipeSession()` zeroizes privKeys (verified by source-grep test at `v018.test.ts:285-311`) |
| opus2 L (wipeKeystore localStorage leak) | RPC override survived "wipe my wallet" | `db.ts:85-108` scrubs `pearl-wallet-ui-v3` in try/finally (verified by `v018.test.ts:239-265`) |
| opus1 M-3 + minimax cross | Hostile sentry tarpit caused throw → whole pool errored | `pearl-rpc.ts:102-203` `MAX_RPC_PAGE_LENGTH=500` + `degraded:true` partial result; `balances.ts:46, 85` propagates degraded into `prlSource="partial"` (verified by `v018.test.ts:37-95`) |
| opus2 cross-Low (passphrase mono-class) | XKCD-style passphrase rejected | `validate.ts:43, 63-65` `PASSPHRASE_MIN_LENGTH=16` escape hatch (verified by `v018.test.ts:175-200`) — see M-1 above for the side effect this introduced |
| (new) RPC override security | localStorage tamper could install attacker RPC | `ui-store.ts:11-27, 88-98, 55-71` allowlist on get + set, re-validate on load (verified by `v018.test.ts:202-236`) |
| (new) iframe click-jack | No frame-ancestors enforcement on non-CF mirrors | `index.html:38-56` top-of-body iframe-bust with throw-to-halt (verified by `v018.test.ts:329-335`) |

170 tests pass (commit message + v018.test.ts itself). Test coverage is tight — each v0.1.7 finding has at least one anti-regression assertion at the module boundary, which is the right level (refactors won't false-positive these).

---

## Recommendations summary

| Priority | Finding | Action |
|----------|---------|--------|
| P1 | M-1 | Reject pure-digit passphrases <24 chars; require ≥2 classes at length 16–19 |
| P1 | M-2 | Either escape `|`/`=` in AAD parameter strings, or reject non-canonical chars at `computeAAD` boundary |
| P2 | L-1 | Add strict `0x[hex]{40,64,130}` regex to recipient/sdiHash/signature in `normalizeRelayerMintSig` |
| P2 | L-2 | Canonicalize bytes32 hex before `sdiHash` binding comparison |
| P2 | L-3 | Distinguish "walk-cap-hit" from "address-failure" in `prlSource` so users can tell custom-RPC-incomplete from canonical-RPC-incomplete |
| P3 | L-4 | Bump PBKDF2 to 1.2M iterations, or migrate to Argon2id with v=2 blob |
| P3 | I-2 | Add boot-time `EIP712_VERSION()` runtime check on BridgeController |
| P3 | I-5 | Document the no-MaxUint256-approval constraint in `05-BRIDGE_INTEGRATION.md` ahead of the burn implementation |

---

## Conclusion

v0.1.8 cleanly closes the v0.1.7 consensus blockers without introducing any new HIGH-severity surface. The bridge mint pipeline is correctly bound (EIP-712 domain pins to RC5 + chainId + verifyingContract + required `IntentExpectation`), the UTXO walk fails safely on hostile-sentry inputs, the keystore AAD is now byte-deterministic, and operational hygiene (sourcemap, COOP/COEP, iframe-bust, localStorage scrub) has matured. The two MEDIUM findings (M-1 numeric-passphrase escape hatch, M-2 AAD field-shift latent) are both defense-in-depth gaps best addressed before the wallet ships to retail, but neither blocks the v0.1.8 audit-cycle goals.

The crypto-tier work (PBKDF2 → Argon2id) is the largest open structural item beyond this audit's scope and should be planned for the next milestone.

**Auditor:** MiniMax Model (Independent Security Review)
**Report date:** May 20, 2026
