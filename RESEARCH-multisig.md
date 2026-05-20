# RESEARCH — Multisig for Pearl Web Wallet (v0.2.0)

**Author:** Bridge Developer
**Date:** 2026-05-20
**Status:** Research / recommendation. No code yet.
**Scope:** What multisig should look like for v0.2.0, on top of v0.1.16 (`@scure/btc-signer` 1.4.0, `@noble/curves` 1.6.0, `viem` 2.21).

---

## Recommendation (TL;DR)

**Pearl L1: BIP-342 tapscript m-of-n (CHECKSIGADD) under a script-path P2TR, key-path locked to the BIP-341 NUMS point.** Coordinate sign-time via offline PSBT files, Sparrow-style. **Eth: Safe-signer mode** — sign existing Safes' pending EIP-712 `SafeTx` payloads via Safe Transaction Service, never deploy our own multisig contract. **Skip MuSig2 and FROST in v0.2.0.** Both are correct long-term, but no audited pure-JS BIP-327 / BIP-frost-secp256k1 implementation is in our dependency tree, and the on-chain privacy / fee delta is not load-bearing for retail. Re-evaluate MuSig2 once `@brandonblack/musig` (or equivalent) has another year of production exposure.

This buys multisig that is boring, auditable, deterministic, unblocked by upstream library work, and audit-shippable on the same timeline as a normal release.

---

## 1. Pearl L1 multisig technique

| | Privacy on chain | Bytes per spend | Coord rounds | Library risk | m-of-n? |
|---|---|---|---|---|---|
| Tapscript m-of-n (a) | Reveals policy | High | 1 | None — `@scure/btc-signer` ships it | yes |
| MuSig2 n-of-n (b) | Indistinguishable from singlesig | Lowest | 2 | High (new JS dep) | n-of-n only |
| FROST t-of-n (c) | Indistinguishable | Lowest | 2 + DKG | Very high | yes |
| Hybrid key+script (d) | Indistinguishable on happy path | Mixed | 2 happy, 1 fallback | High | yes |

**Pick (a).** Output script is `<pk1> OP_CHECKSIG <pk2> OP_CHECKSIGADD … <pkn> OP_CHECKSIGADD <m> OP_NUMEQUAL` in a single tapleaf, internal key = `TAPROOT_UNSPENDABLE_KEY` (BIP-341 NUMS) so the key-path is provably disabled. `@scure/btc-signer` already exports `p2tr_ms` and `p2tr_ns` returning leaf scripts ready to drop into `p2tr(internalKey, tree, network)`. Spends produce a 64-byte Schnorr signature per cosigner.

**Defer (b) MuSig2.** Three blockers: (i) only n-of-n — retail "multisig" intent is 2-of-3, MuSig2 alone cannot do it; (ii) not in `@scure/btc-signer` 1.4.0; (iii) BIP-327 reference implementations in JS (`@brandonblack/musig`, `@cmdcode/musig2`) are small-audience, single-maintainer, and the nonce-reuse footgun is severe. The fee win is ~50-80 vbytes per spend at typical n; the privacy win is real but not in our threat model.

**Defer (c) FROST indefinitely for retail.** Right answer for institutional custody, wrong for a retail browser wallet in 2026 — no audited pure-JS lib at production grade, DKG ceremony is hard to UX, single nonce-reuse leaks the key.

**Defer (d) hybrid** with (b). Worth designing the script tree so it is a future drop-in: a v0.3.x rebuild can replace the NUMS internal key with a MuSig2 aggregate and keep the same script-path leaves — same address scheme, same coordination format.

---

## 2. JS library availability

- **`@scure/btc-signer` 1.4.0** — exports `p2tr`, `p2tr_ns`, `p2tr_ms`, `p2tr_pk`, `taprootListToTree`, `TAPROOT_UNSPENDABLE_KEY`. PSBT v0/v2 with `tapLeafScript`, `tapMerkleRoot`, `tapBip32Derivation`, `tapScriptSig` fields wired in `transaction.d.ts`. `Transaction.signIdx` already drives our singlesig path. **No MuSig2.** Sufficient for (a) with zero new deps.
- **`@noble/curves` 1.6.0** — `secp256k1.schnorr.{sign,verify,getPublicKey}` is enough for per-signer Schnorr. **No MuSig2 nonce machinery** (no `nonce_gen`, `nonce_agg`, `partial_sign`, key-agg, tweak-on-aggregate). To add MuSig2 we'd vendor ~400-600 LOC plus tests.
- **`viem` 2.21.19** — covers EIP-712 typed-data signing (for Safe) and raw tx submission. No Safe-specific helpers needed; `@safe-global/protocol-kit` pulls a heavy tree and is not worth importing for the four endpoints we use.

**Verdict:** v0.2.0 ships on the current dependency set. No new packages in `package.json`. Hard requirement — every new dep is more transitive surface area than we have spent four audit rounds reducing.

---

## 3. Coordination flow

**Constraints:** pure web, no server we operate, non-custodial.

**Setup — pubkey exchange.** Each cosigner derives a fresh BIP-86 receive key at a dedicated multisig sub-path (e.g. `m/86'/808276'/100'/<account>'/<index>` — reusing the existing receive pool would conflict with `RECEIVE_GAP_LIMIT` and leak which addresses belong to whom). Wallet exports x-only pubkey + a small descriptor JSON (`{ version, type:"pearl-multisig-pubkey", xOnlyPubkey, originPath, label }`) as both a file download and a copyable text blob. The originator collects N pubkeys; the wallet sorts them lexicographically (BIP-67 ordering, deterministic regardless of import order), builds the tapscript, derives the P2TR address, displays it. **Every cosigner repeats the build deterministically and verifies the same address.** That equality check is the only defence against a malicious originator handing different pubkey sets to different cosigners — refuse to mark the vault "ready" until m cosigners independently confirm the address.

**Sign-time — PSBT exchange.**
- Cosigner A composes the spend; the wallet builds a PSBT v2 (native to `@scure/btc-signer`) carrying `witnessUtxo`, `tapLeafScript`, `tapBip32Derivation`, `tapInternalKey` per input.
- A signs in the worker — their `tapScriptSig` lands on the relevant input under the leaf hash — and exports `pearl-tx-<txid>.psbt`.
- A hands the file to B (email attachment, Signal, SD card). B opens it, sees the same compose preview the singlesig flow shows today (reconstructed from PSBT instead of from a UTXO walk), signs, exports.
- Once m signatures are collected, any cosigner finalizes (witness gets the m sigs + leaf script + control block) and broadcasts via the existing `broadcastPearlTx` RPC — no RPC-surface change.

**What others do.** Sparrow: PSBT files + optional Nostr coordinator. Specter: optional hosted coordinator, defaults to PSBT files. Liana: PSBT files + optional daemon plugin. All converge on "PSBT is the lingua franca, file transfer is the floor." We follow.

**QR codes (stretch).** Bitcoin's BCUR/UR is ~300 LOC of fountain-code logic — defer to v0.2.1. File transfer is enough to ship. **No relay server**, ours or anyone's — operating one makes us custody-adjacent for whoever relies on it.

---

## 4. Ethereum side (WPRL) — Safe-signer mode

**Integrate as a signer for an existing Gnosis Safe. Do not deploy our own multisig contract.**

- Safe is the dominant Eth multisig (>$80B AUM, audited since 2018). A competing contract is self-inflicted audit liability.
- Users wanting Eth multisig already have a Safe or want one — meet them where they are.
- Safe Transaction Service (`safe-transaction-mainnet.safe.global`) holds pending txs + collected sigs — exactly the coordination problem we wanted to avoid on Pearl. On Eth it is free.

**Import path:**
1. Settings → "Connect a Safe." Paste Safe address.
2. Wallet queries Safe Transaction Service for pending txs where our Eth address is an owner.
3. New `SignSafeTx.tsx` shows recipient, value, decoded calldata, signature count vs threshold.
4. User signs the EIP-712 `SafeTx` in the worker (a sibling `signSafeTx` cmd next to `signEthTx`, using viem's typed-data path).
5. Wallet POSTs the signature to Safe Transaction Service.
6. When threshold reached, any owner clicks "Execute" — submits the assembled `execTransaction` via our existing Eth RPC.

Bridge flow for Safe users routes through `execTransaction` instead of a direct EOA call; one switch in `Bridge.tsx`. ~250 LOC for the Safe client.

---

## 5. Recovery / disaster

**2-of-3 default policy** — lose one key, the other two still spend. That is the entire point of m-of-n and is what we ship as the recommended template.

**Time-locked recovery script-path (v0.2.x, not initial).** Add a second tapleaf with `CHECKSEQUENCEVERIFY` + single recovery-key spend (Liana / "Bitcoin Vault" model). UX: optional "Recovery key + N-day delay" toggle at vault creation. Defer past the first cut — doubles the test matrix and we want a clean audit on the simple m-of-n first.

**Social recovery: out of scope.** Pearl L1 has no smart-contract layer for it. On Eth, Safe handles it via its module system; users who care use that.

**Lose all keys: same as today.** No recovery service. Spec unchanged.

---

## 6. Implementation cost — v0.2.0 punch list

**Target: ~6 engineer-weeks plus a 1-week external audit ($15-20k).** Builds on v0.1.16; no architectural rework.

Files changed:
- `src/crypto/hd.ts` — add `pearlMultisigPath(account, index)`.
- `src/crypto/worker.ts` — add `exportMultisigPubkey`, `signPearlPsbt`, `signSafeTx`.
- `src/chains/pearl/multisig.ts` (new) — `vaultAddressFromPubkeys(m, pubkeys, network)`, sorted, NUMS internal key.
- `src/chains/pearl/psbt.ts` (new) — `@scure/btc-signer` PSBT round-trip + descriptor-JSON exchange format.
- `src/chains/ethereum/safe.ts` (new) — Safe Transaction Service client (4 endpoints).
- `src/services/pearl-multisig.ts` (new) — UTXO walk against the vault address; reuses `fetchPrlUtxos` unchanged.
- `src/services/safe.ts` (new) — pending-tx polling, signature push, execute helper.
- `src/state/multisig-store.ts` (new) — Zustand slice for vault metadata.
- `src/storage/` — Dexie tables for vaults + signed-PSBT history.
- `src/ui/pages/{Vaults,CreateVault,SendFromVault,SignQueuedTx,SignSafeTx}.tsx` (new).

Unchanged: `address.ts`, `network.ts`, `pearl-rpc.ts` (vault UTXOs walk identically), `eth-tx.ts` (Safe layered above).

---

## 7. What NOT to build

- **Do not roll our own MuSig2.** Nonce-reuse leaks the key. Vendor `@brandonblack/musig` when we revisit, audit it, lock it. Don't write it.
- **Do not deploy a custom Eth multisig contract.** Safe exists. We are not Safe.
- **Do not run a coordination server**, even "optional." PSBT-by-file is enough.
- **Do not use a real cosigner key as the P2TR internal key.** The single most common footgun: tapscript m-of-n where the key-path is a real key means any single holder can drain the vault, bypassing m-of-n. **Use `TAPROOT_UNSPENDABLE_KEY` (BIP-341 NUMS).** Test-bind the constant.
- **Do not skip address-equality verification at vault setup.** Without it, a malicious originator can hand different pubkey sets to different cosigners (selective backdoor). Refuse to activate the vault until m cosigners independently confirm the derived address.
- **Do not surface coin control or UTXO-level UX in v0.2.0.** Multisig users are sophisticated; resist anyway. Keep parity with singlesig so the test matrix stays bounded.

---

## First 10 PRs

1. **`hd: add Pearl multisig derivation path`** — `pearlMultisigPath(account, index)` + BIP-86 vector tests at the new prefix.
2. **`pearl/multisig: tapscript m-of-n vault output`** — `vaultAddressFromPubkeys(threshold, pubkeys, network)`, BIP-67 sort, NUMS internal key. Golden-file test: a fixed 2-of-3 pubkey set produces a stable `prl1p…`.
3. **`pearl/psbt: PSBT round-trip wrapper`** — serialize/parse via `@scure/btc-signer`, plus descriptor-JSON pubkey export/import, golden-file tests.
4. **`worker: signPearlPsbt command`** — signs only inputs whose `tapBip32Derivation` matches our session keys; ignores foreign inputs cleanly.
5. **`services/pearl-multisig: compose spend against a vault`** — UTXO walk over the vault address, fee math from `pearl-tx.ts`, returns a PSBT.
6. **`state/multisig-store: persistent vault registry`** — Dexie schema, Zustand slice, encryption-at-rest mirroring `keystore.ts`.
7. **`ui: Vaults / CreateVault / SendFromVault / SignQueuedTx pages`** — four screens behind `VITE_ENABLE_MULTISIG=true` until audited.
8. **`eth/safe: Safe Transaction Service client`** — pending list, post signature, execute encoder via viem.
9. **`worker: signSafeTx (EIP-712)`** — sibling to `signEthTx`, signs `SafeTx` typed-data, never executes.
10. **`ui: SignSafeTx + Settings → Connect a Safe`** — Eth multisig surface complete. Flip the feature flag on once the v0.2.0 audit clears.

---

*End of report.*
