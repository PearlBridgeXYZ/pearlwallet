# PearlWallet multi-model re-audit (opus + sonnet + fable + minimax)

Run 2026-06-10. 4 independent auditors across model tiers, opus synthesis. Surfaces: v0.4.0-v0.4.2 bridge/ENS/RPC/decimal/migration changes.

All claims verified against source. Confirmed details:
- **STORAGE_KEY = "pearl-wallet-ui-v6"** (ui-store.ts:98), wipe list stops at v5 (db.ts:217) — wipe gap is real, all 3 auditors agree.
- **estimateGas in sendContractCall** (eth-tx.ts:358) — confirms the burn estimate reverts pre-approve. The retry catch copy (Bridge.tsx:624) says "no re-approve needed" but a retry re-reads allowance (still 0) and re-approves. Fable's mechanism is correct; the nonce race (sonnet) is a *secondary* failure mode of the same root.
- **pollUnwrap relayState** (Bridge.tsx:283) — sonnet is right: `b.state` (null) overwrites the prior meaningful string unconditionally in the patch, even though phase is guarded.
- **fetchRecentDeposit** (bridge-v1.ts:300) accepts any non-empty string txid; **txid spliced raw** into `/pearl-tx/${txid}` and `/mints/${txid}` (no encodeURIComponent) — fable's path-traversal claim is real.
- **fetchMintStatus mintTxHash** only checks `startsWith("0x")` (bridge-v1.ts:335) — fable's etherscan-link claim is real.

Here is the consolidated report.

---

# PearlWallet Re-Audit — Consolidated Findings

**Synthesis of 3 independent auditors (opus, sonnet, fable).** Every load-bearing claim below was re-verified against source. Severity recalibrated under one rubric: **Critical** = loss/lock of funds or wrong-balance driving a bad signing decision · **High** = exploitable under the stated hostile-API/RPC threat model · **Medium** = bounded loss / degraded safety · **Low** = polish.

---

## CONFIRMED — fix before any further ship

### C1 · HIGH — Unwrap broadcasts approve then immediately calls requestBurn; burn estimateGas reverts pre-approve, and retry re-approves (real ETH loss)
**Consensus:** fable (High), sonnet (High, framed as nonce race). Opus did not flag — this is the most important miss to weigh; **two of three caught it and the mechanism is verified in source.**
**Location:** `src/ui/pages/Bridge.tsx:577-597, 618-627` + `src/services/eth-tx.ts:357-366`

**Scenario (verified):** When `allowance < burnGrains`, `approveWprlForBridge` returns at **broadcast, not receipt** (eth-tx.ts:380 returns immediately after `broadcastRaw`). `requestBurn` then calls `sendContractCall`, which runs `client.estimateGas(...)` (eth-tx.ts:358) against **latest chain state where allowance is still 0** → `BridgeController.requestBurn` does `burnFrom` → estimate reverts with insufficient-allowance, so the burn step throws nearly every time an approval was needed. The catch (Bridge.tsx:624) shows *"Approve landed (…) but burn failed … Re-try Unwrap — no re-approve needed"* — **wrong on both counts:** the approve was only broadcast, and an immediate retry re-reads allowance (still 0 at `latest`), takes the approve branch **again**, and broadcasts a **second approve** at the next nonce (~46k gas of real ETH each). A user mashing retry pays N approves before the first mines. Sonnet's nonce-race (fallback transport routes `getTransactionCount` to a node that hasn't seen the approve) is a **second, independent failure path of the same root** — both txs sign at nonce N and collide. Net: funded mainnet user suffers systematic small ETH loss and a broken headline flow.

**Fix:** After the approve broadcast, `await client.waitForTransactionReceipt({ hash: a.txHash })` and assert `status === 'success'` **before** calling `requestBurn`. Latch a pending-approve marker (store `approveTxHash` on the crossing/component state) so a retry waits on the receipt instead of re-approving. Fix the error copy to *"Approve broadcast (…) — wait for it to confirm, then retry."* Read WPRL `balanceOf` and refuse amounts above it **before** broadcasting any approve (kills the fat-finger approve-then-revert-on-balance variant).

---

### C2 · HIGH — `wipeKeystore` misses the current localStorage key `pearl-wallet-ui-v6`; RPC overrides + prefs survive a full wipe
**Consensus:** all three (opus Medium, sonnet High, fable Medium). **Unanimous.** I rank it High: it breaks the explicit documented "leave the device clean" contract on a shared/seized-device threat, and the next wallet in that profile silently inherits the prior RPC override.
**Location:** `src/storage/db.ts:209-217` vs `src/state/ui-store.ts:98`

**Scenario (verified):** `STORAGE_KEY = "pearl-wallet-ui-v6"` (bumped v0.2.8), but `LOCAL_STORAGE_KEYS` stops at `v5` and the in-file comment **still claims v5 is current**. After "wipe everything from this browser," the entire live prefs blob survives — `ethRpcOverride`, `pearlRpcOverride`, `ethEnabled`, `multisigEnabled`, `offlineSigningEnabled`, `theme`, `ethDefaultedOn`. The keystore IDB row and `bridgeCrossings`/`bridgeDepositPins` are deleted (no key loss), but residual config/PII the wipe promises to remove persists, and a new seed imported in the same profile operates under the prior user's RPC choice (allowlisted hosts only, so no fund redirection).

**Fix:** Add `"pearl-wallet-ui-v6"` to `LOCAL_STORAGE_KEYS` **now**, and fix the stale comment. Then close the drift class permanently: iterate `localStorage` removing every key matching `/^pearl-wallet-ui-v\d+$/`, **or** export `STORAGE_KEY` + a `STORAGE_KEY_HISTORY[]` from ui-store and spread it here so a future bump can't silently desync.

---

### C3 · HIGH — Recovery tick adopts unvalidated `/deposits/recent` payloads; raw txid path-splice + unbounded phantom-crossing injection
**Consensus:** fable only (Medium). Verified and **promoted to High** — it's directly exploitable under the stated hostile-API threat model (path traversal silently corrupts polling endpoints; unbounded row injection is a real DoS/panic vector). Opus/sonnet's "recovery tick" clean notes only covered the MINT_IN_FLIGHT *state* guard, not txid validation or unbounded adoption — they checked a different property.
**Location:** `src/ui/pages/Bridge.tsx:115-144` + `src/services/bridge-v1.ts:296-307, 314-317, 330-337`

**Scenario (verified):** `fetchRecentDeposit` accepts **any non-empty string** as `txid` (bridge-v1.ts:300 — only `!o.txid || typeof !== 'string'` rejected) and any `amountGrains`. A MITM'd API returns a fresh random txid in state `pending` every 15s tick; each fails the `db.get()` existence check and is `put()` as a new "confirming" wrap row with an attacker-chosen amount. Consequences: (a) **unbounded `bridgeCrossings` growth** — every open-phase row is polled each tick, so API fan-out + IndexedDB grow without limit; (b) Activity tab fills with phantom `PRL→WPRL 999999` rows that panic users into "recovering"; (c) the txid is **spliced raw** into `/pearl-tx/${txid}` (bridge-v1.ts:315) and `/mints/${txid}` (bridge-v1.ts:331) with no `encodeURIComponent` — a txid like `../status` URL-normalizes to a different endpoint, silently corrupting the poll. Adopted rows also store `netGrains = amountGrains` (gross), overstating the eventual mint by the fee.

**Fix:** In `fetchRecentDeposit`, reject txids failing `/^(0x)?[0-9a-f]{64}$/i`. `encodeURIComponent` the txid splice in `fetchPearlTxStatus`/`fetchMintStatus`. In the recovery tick, cap adoption (refuse if >N open crossings) and only adopt after the wallet's **own Pearl RPC** confirms the txid exists and pays the pinned deposit address. Compute `netGrains` from the quoted fee bps or leave it null.

---

### C4 · MEDIUM — `pollUnwrap` overwrites a meaningful `relayState` with `null` each tick when the relay hasn't indexed the burn
**Consensus:** sonnet (Medium). Verified.
**Location:** `src/ui/pages/Bridge.tsx:282-285`

**Scenario (verified):** The patch sets `relayState: b.anomalyReason ? ... : b.state` **unconditionally** (Bridge.tsx:283). When the burn was just broadcast, `fetchBurnStatus` returns `state: null`, so a previously meaningful relayState string is overwritten with `null` and the card drops to a contextless "Bridge processing…". On a sustained relay outage every tick re-nulls it, so the user never sees the last-known state. The `phase` field is correctly guarded (only advances on `b.state`), so this is display-degradation, not a lifecycle bug.

**Fix:** Only include `relayState` in the patch when `b.state !== null`; otherwise preserve the prior value.

---

### C5 · MEDIUM — Unwrap hangs in "bridging" forever when the burn tx is dropped or reverts on-chain; wallet never checks its own ETH receipt
**Consensus:** fable (Medium), with opus/sonnet implicitly trusting the relay as sole oracle. Verified that `pollUnwrap`'s only oracle is `/v1/burns/{hash}` and `classifyBurn(null)='pending'` keeps phase `relay`.
**Location:** `src/ui/pages/Bridge.tsx:279-297` + `src/services/bridge-v1.ts`

**Scenario (verified):** If the signed burn tx is dropped (stale `maxFee` in a fee spike, or a hostile RPC reporting an artificially low baseFee so it underpays forever) **or mines-but-reverts** (burn window filled between quote and inclusion — watchers don't index reverted txs), the relay returns `state:null` indefinitely, `classifyBurn(null)='pending'`, and the record stays `phase:'relay'` → Activity shows "bridging" eternally while the WPRL never left (revert) or the tx evaporated. Users wait days for PRL that isn't coming, or panic-assume the WPRL is committed.

**Fix:** In `pollUnwrap`, when relay state is null, cross-check the wallet's own ETH RPC: `client.getTransactionReceipt(c.id)`. `status === 'reverted'` → phase `failed` with reason; no receipt after N polls (~30 min, persist a deadline/attempt counter on the record) → surface *"tx not mined — likely dropped, your WPRL is untouched, retry."*

---

### C6 · LOW — Unwrap button stays enabled when `!withinDailyCap`; burn has no slow lane, so the contract reverts after approve gas is spent
**Consensus:** fable (Low). Verified the confirm-time re-quote (Bridge.tsx:560-589) checks address/amount/paused but **not** `q2.withinDailyCap`. Compounds C1.
**Location:** `src/ui/pages/Bridge.tsx:577-597, 662-675`

**Scenario:** Unlike wraps (mint slow lane), `requestBurn` has no queue — `_checkAndUpdateWindow` reverts outright over-cap. The amber "exceeds today's remaining burn capacity" note shows but the button stays enabled and `unwrap()` never gates on `withinDailyCap`. A user who proceeds when an approve is needed pays the approve, then the burn estimate reverts on the window.

**Fix:** Disable Unwrap when `quote.withinDailyCap === false`, and **re-assert `q2.withinDailyCap` in the confirm-time re-quote before any approve is broadcast** (add it to the Bridge.tsx:565-576 guard block). Show `burnWindowRemaining` from `/v1/status` in the copy.

---

### C7 · LOW — API-supplied `mintTxHash` accepted on `0x`-prefix alone, embedded raw in the Etherscan link
**Consensus:** fable (Low). Verified (bridge-v1.ts:335 `startsWith("0x")` only).
**Location:** `src/services/bridge-v1.ts:334-337` + `src/ui/pages/Bridge.tsx:749-755`

**Scenario:** A hostile API returns `mintTxHash` like `0x/../address/0xattacker?…`; it's concatenated into `https://etherscan.io/tx/{hash}`, steering the "WPRL mint tx ↗" link to an arbitrary etherscan.io path (e.g. an attacker's address page presented as "your mint"). Bounded to the etherscan.io origin (no XSS), but misleading in a money UI.

**Fix:** Validate `/^0x[0-9a-fA-F]{64}$/` in `fetchMintStatus`; null-out otherwise. Apply the analogous `/^[0-9a-f]{64}$/` check to `pearlTxId`/`refundPrlTxId`.

---

### C8 · INFO/LOW — Stale doc-comments mislabel WPRL amounts as 10^18 (re-introduces the exact bug v0.4.2 just fixed)
**Consensus:** fable (Info). Low-effort, high-leverage to fix given the decimal class was the whole point of this audit cycle.
**Location:** `src/services/activity.ts:41` (`ActivityItem.amount` documented "wprl wei (10^18)"); `src/storage/db.ts:212-213` (comment claims current shape lives under v5 — also covered in C2).

**Fix:** Amend activity.ts:41 to *"wprl base units (10^8 — decimals()==8 on-chain, NOT 18)"*. Fix the db.ts comment as part of C2.

---

## CONSIDER / DEFER

- **D1 · LOW — ENS forward-resolution trusts the user's (possibly MITM'd) allowlisted RPC; poisoned address shown on confirm (60s cache).** *(sonnet, Medium → defer-Low.)* Real but the resolved 0x address **is** displayed for confirmation before signing (all auditors confirmed this in clean categories), so it requires the user to ignore an unfamiliar address. Worth a UI hardening pass, not a ship blocker. **Fix:** prominent "this address was returned by your configured RPC — verify independently" warning; optionally cross-check against a second provider before caching. *Note: opus/fable explicitly rated the 60s cache as keyed off user input with no cross-poisoning vector — the disagreement is about RPC trust, not cache design.*

- **D2 · LOW — `bridgeCrossings` grows unbounded; never pruned; Activity renders all rows.** *(opus, Low.)* Privacy/perf footprint, not funds. **Fix:** cap retained terminal (done/refunded/failed) crossings on `reloadCrossings` and/or paginate the Activity render. *(C3's fix should also bound injected rows.)*

- **D3 · LOW — Poisoned/stale TOFU deposit-address pin permanently bricks wrap with no clear-pin affordance.** *(fable, Low.)* Funds are safe (pinned value only returned when it equals the fresh fetch), but a pin written at *quote* time during a first-quote compromise locks wrap forever; only escape is a full keystore wipe. **Fix:** add a Settings/Bridge control to display pinned vs freshly-fetched and let the user re-pin after out-of-band verification; write the first pin at **send confirmation**, not quote preview.

- **D4 · LOW — `fetchBurnStatus`/`fetchMintStatus` state shape-check is permissive (any truthy string accepted).** *(sonnet, Low.)* `state=''` → `classifyBurn` returns 'review', potentially locking a crossing in review display. Low impact (relay is authoritative; no funds risk). **Fix:** validate state against the known vocabulary; treat unexpected non-empty strings as null. *Largely subsumed by C3's validation pass.*

- **D5 · INFO — `/v1/status` `wprl`/`bridgeController` addresses not validated against pinned constants.** *(sonnet, Info.)* Currently unused for signing (the burn-quote plan **is** cross-checked at preview and confirm — all auditors confirmed). Proactive hardening only. **Fix:** assert `status.wprl`/`status.bridgeController` match compiled-in constants in `fetchBridgeStatus`, so a future caller can't introduce a redirect.

- **D6 · INFO — Unclamped `pearlMinConfirmations` from `/v1/status` can hang a wrap in "confirming"; failed/refunded crossings never re-polled.** *(fable, Info.)* Display-trust only; no signing dependency. **Fix:** clamp `pearlMinConfirmations` to 1–100 in `fetchBridgeStatus`; give terminal failed/refunded rows a manual "recheck status" action; cross-check wrap confirmations against the wallet's own Pearl RPC.

- **D7 · LOW (pre-existing) — Dashboard hardcodes `"mainnet"` for WPRL/ETH balance reads while send flows honor `ethNetwork`.** *(fable, Low.)* A sepolia-configured wallet shows mainnet balances — wrong-balance display that could drive a bad funding decision. Moot while only mainnet is UI-reachable, but it contradicts the per-network plumbing. **Fix:** thread `ethNetwork` through `Dashboard`'s `fetchBalances` call instead of the literals (`src/services/balances.ts:148,158`). *Not introduced in 0.4.x — fix opportunistically.*

- **D8 · INFO — v0.4.2 ETH-default migration force-enables ETH once for users who deliberately opted out pre-migration.** *(opus + sonnet + fable, all Info/clean.)* Matches stated product intent ("universal ETH-on"); replay-safe, no loop, later opt-out persists. **No fix required** unless preserving a pre-migration explicit `ethEnabled:false` matters — then only force-enable when `parsed.ethEnabled === undefined`.

- **D9 · LOW — `saveUI()` inside the migration block in `loadUI()` is in an unguarded try; a quota-exceeded swallow could re-run the migration each load.** *(sonnet, Low.)* Idempotent (always lands `ethEnabled=true`), so harmless beyond a wasted write. **Fix:** wrap the in-migration `saveUI` in its own try/catch and log.

---

## CLEAN — agreed by all three auditors

These categories were independently verified clean by opus, sonnet, **and** fable. No action.

1. **WPRL decimal correctness (8-dec end-to-end)** — `WPRL_DECIMALS=8`/`ETH_DECIMALS=18`/`PRL=8`; `formatWprl`/`parseWPRL`=8-dec, `formatWei`/`parseEth`=18-dec; every send/dashboard/activity call site uses the right scale; no residual 18-dec WPRL or 8-dec ETH site (full grep). *(fable additionally verified `dist/` was rebuilt carrying 0.4.2 and `format.test.ts` green.)*
2. **`Number(bigint)/1e8` precision** — only used for display-only USD ballparks (Dashboard), never on a signed amount; never reaches calldata.
3. **Wrap amount binding** — WrapCard signs the user's locally-parsed `sendGrains`; API quote echo only asserted-equal at preview and confirm-time re-quote.
4. **Unwrap amount binding** — burn signs the user's `burnGrains` for both approve and requestBurn; asserted-equal at preview and confirm (`q2.amount !== burnGrains` throws, verified Bridge.tsx:571).
5. **Address substitution (unwrap)** — approve→WPRL and requestBurn→bridgeController target only network.ts-pinned constants via `bridgeConfig`; quote plan cross-checked against pins at preview **and** confirm with refuse-on-mismatch (verified Bridge.tsx:565-570); payout pearlAddress is the wallet's own, never API-supplied.
6. **Address substitution / TOFU (wrap)** — deposit address pinned TOFU; `resolveDepositAddress` only returns the pin when it equals the fresh fetch, else throws; re-resolved + compared at confirm; a tampered pin alone cannot redirect funds.
7. **`classifyMint` / `classifyBurn` exhaustiveness** — cover every relay mint/burn state; `finalized→minted` collapse handled; unknown/future states fail safe to 'review' (never silent hang).
8. **Recovery resurrection (state guard)** — tick only adopts `MINT_IN_FLIGHT` states; failed/cancelled/under_review/refunded mints never zombie-resurrected; existing-record guard prevents duplicate adoption. *(Note: this property is clean; the txid-validation/unbounded-adoption gap is C3 — a different property.)*
9. **ENS safety** — mainnet-only gate returns null before any RPC on non-mainnet; `normalize()` try/catch→null; resolved 0x always surfaced in Send preview before signing; reverse resolution display-only.
10. **EIP-55 normalization** — `normalizeEthAddress` rejects mixed-case checksum failures, accepts all-lower/all-upper and re-checksums; `resolveEthDestination` routes through it.
11. **RPC override allowlist** — enforced at setter (throws), at `loadUI` (re-validates tampered localStorage), and at read in `ethClient` (defense-in-depth); https-only; CSP `connect-src` as second gate; override prepends rather than replaces the diversified fallback chain; MEW/Llama dropped as CORS-unusable.
12. **ethDefaultedOn migration replay/loop safety** — stamped true on first run and every `persistedSnapshot` write → migration block skipped on all later loads; other prefs preserved via spread-merge; later opt-out persists; corrupt JSON falls back to defaults without overwrite.
13. **Approval scope** — exact-amount approve (`burnGrains`, not `MaxUint256`); allowance re-read at confirm to catch a stale `needsApprove`.
14. **Sign-what-you-saw freshness** — frozen gas/fee preview with 30s freshness enforced at broadcast in both SendETH and SendWPRL; `MAX_BASE_FEE_WEI` ceiling rejects a hostile RPC's absurd baseFee; chainId bound to the wallet's believed chain, not the node's claim; nonce deliberately re-read at `pending` at broadcast.
15. **Post-broadcast tracking-failure handling** — both wrap and unwrap surface the txid loudly when the local DB write fails after on-chain commit (verified Bridge.tsx:613-616).
16. **DB migrations v1→v4** — additive new-table-only, no destructive data migration; `wipeKeystore` clears `bridgeCrossings` + `bridgeDepositPins` on the IDB side (the localStorage v6 gap is C2).
17. **Bridge API shape-checking** — `asObject`/`asGrains`/`asString-prefix` guards throw `E_BRIDGE_API_SHAPE` rather than propagating undefined/NaN into amount math; deposit address must start with `prl1`; mint/burn state coerced to string|null. *(The residual gap is txid format-validation, C3 — distinct from type-shape checking.)*

---

**Bottom line for the action list:** ship-blockers are **C1** (real ETH loss + broken unwrap, 2/3 caught, mechanism verified), **C2** (unanimous wipe gap), and **C3** (hostile-API injection + path traversal, verified). C4–C8 are confirmed and cheap — fold them into the same fix cycle. Everything under CONSIDER/DEFER is genuinely lower-stakes or pre-existing; none gates the ship.