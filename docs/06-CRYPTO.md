# 06 — Crypto

## Pearl L1 crypto profile

| Property | Value | Source |
|----------|-------|--------|
| Curve | secp256k1 | btcd-fork |
| Signature scheme | Schnorr (BIP-340) | Pearl L1 uses SegWit v1 / Taproot |
| Address format | bech32m (BIP-350) | P2TR pay-to-taproot |
| HRP | `prl` (mainnet), `tprl` (testnet — verify with PearlBridge devnet docs) | Pearl chain spec |
| Native unit | grain (1 PRL = 10^8 grains) | Pearl spec |
| Network magic | TBD — fetch from Pearl node spec | Pearl spec |
| HD derivation | BIP-32 / BIP-44 / BIP-86 (Taproot) | Standard |
| Default path | `m/86'/<coinType>'/0'/0/0` (BIP-86 for Taproot) | Standard; coin type TBD for Pearl, fallback to BTC-style |

## Ethereum crypto profile

| Property | Value |
|----------|-------|
| Curve | secp256k1 |
| Signature | ECDSA |
| Address | EIP-55 checksummed |
| Default path | `m/44'/60'/0'/0/0` |

## Single mnemonic, both chains

One BIP-39 mnemonic seeds both the Pearl HD wallet and the Eth HD wallet. User backs up one phrase, owns both balances.

## Key derivation pipeline

```
Mnemonic (12 or 24 words BIP-39)
        │
        ▼  PBKDF2-HMAC-SHA512(passphrase="", iterations=2048)
Seed (64 bytes)
        │
        ▼  BIP-32 derive
Master HD node (xprv)
        │
        ├─► m/86'/<pearlCoinType>'/0'/0/0  → Pearl private key
        │                                      │
        │                                      ▼ Schnorr-tweaked x-only pubkey
        │                                   Pearl P2TR address (bech32m, HRP prl)
        │
        └─► m/44'/60'/0'/0/0                → Eth private key
                                                │
                                                ▼ Keccak256(pubkey)[12:]
                                            Eth address (0x...)
```

> **Pearl coin type — open question.** SLIP-0044 lists assigned coin types. Pearl needs an assigned type or we pick a Pearl-specific one. Until assigned, use `0'` (Bitcoin coin type) to maximize Sparrow/Electrum interop (someone restoring a Pearl wallet in Sparrow with btc-mainnet network params should see the same addresses). See `11-OPEN_QUESTIONS.md`.

## Encryption at rest

User's password → Key Encryption Key (KEK) → encrypts the mnemonic + derived seed.

```
Password (UTF-8)
        │
        ▼  PBKDF2-HMAC-SHA256
KEK (32 bytes)
        │   iterations: 600_000 (OWASP 2023+ recommendation)
        │   salt: 16 random bytes per wallet (stored alongside ciphertext)
        ▼
AES-256-GCM
        │   nonce: 12 random bytes per encryption (stored alongside ciphertext)
        │   AAD: "pearl-web-wallet-v1"
        ▼
Ciphertext (mnemonic + seed) → IndexedDB
```

Storage record schema (Dexie):
```ts
interface KeystoreRecord {
  id: "primary";              // single keystore per browser in v1
  version: 1;
  kdf: "PBKDF2-SHA256";
  kdfIterations: 600_000;
  kdfSalt: Uint8Array;        // 16 bytes
  cipher: "AES-256-GCM";
  iv: Uint8Array;             // 12 bytes
  aad: Uint8Array;            // utf-8("pearl-web-wallet-v1")
  ciphertext: Uint8Array;     // encrypted JSON of { mnemonic, paths: {pearl, eth} }
  publicData: {               // not encrypted — used while locked
    pearlAddress: string;
    ethAddress: string;
    network: "mainnet" | "testnet";
    createdAt: number;
  };
}
```

> **PBKDF2 iterations 600k:** ~300ms on a 2020-era laptop. Acceptable UX. If browser is too slow (older mobile), can negotiate down to 300k with explicit user warning.

## Web Worker isolation

All cryptographic operations run in `crypto/worker.ts`. The main thread NEVER sees:
- mnemonic plaintext
- seed
- private keys
- KEK

The worker exposes a verb-based RPC:
```ts
type WorkerCmd =
  | { id: string; cmd: "unlock", password: string }
  | { id: string; cmd: "lock" }
  | { id: string; cmd: "deriveAddresses" }                                      // returns { pearlAddr, ethAddr }
  | { id: string; cmd: "signPearlTx", utxos: Utxo[], outputs: Output[], fee: bigint }
  | { id: string; cmd: "signEthTx", txRequest: TxRequest }                      // viem-shaped
  | { id: string; cmd: "signBridgeIntent", sdi: SdiV2 }                          // BIP-322
  | { id: string; cmd: "exportMnemonic", password: string }                     // returns mnemonic only if password matches
  | { id: string; cmd: "changePassword", oldPassword: string, newPassword: string }
  | { id: string; cmd: "createWallet", strength: 128 | 256, password: string }
  | { id: string; cmd: "restoreWallet", mnemonic: string, password: string };

type WorkerResp =
  | { id: string; ok: true, result: unknown }
  | { id: string; ok: false, error: string };
```

`signEthTx` returns the raw signed tx bytes; the main thread broadcasts. Same for Pearl.

After `lock`, the worker zeros sensitive state and terminates after a brief grace period. Main thread spawns a fresh worker on next `unlock`.

## Coin selection (Pearl side)

Build team choices:
1. **Branch-and-bound (BNB)** — Sparrow / Bitcoin Core default. Best for fee efficiency.
2. **Single random draw** — simpler, slightly worse fees, easier to audit.
3. **Use `@scure/btc-signer`'s built-in selector** if it provides one.

v1 recommendation: use `@scure/btc-signer`'s default; if not sufficient, BNB with fallback to single random draw.

Always:
- Reserve enough for fee at chosen tier.
- Avoid dust outputs (< dust limit, fetched from network params).
- Use change output back to the user's NEXT Pearl address (v1.5 with HD; v1 reuses).

## Fee estimation

### Pearl
- Pull `estimatesmartfee` from RPC.
- Three tiers map to confirmation targets: 6 blocks (low), 2 blocks (normal), 1 block (high).
- Floor at network's min relay fee.

### Ethereum
- EIP-1559 with three tiers:
  - Low: `maxPriorityFeePerGas = 1 gwei`, `maxFeePerGas = baseFee * 1.1 + 1`
  - Normal: `2 gwei` priority, `baseFee * 1.5 + 2`
  - High: `3 gwei` priority, `baseFee * 2 + 3`
- Match `crypto_gas.py` tiers used elsewhere in the org (per `reference_crypto_gas` memory).

## Signing — Pearl key-path Taproot spend

For sending PRL:
1. Build PSBT-equivalent (`@scure/btc-signer` handles).
2. For each input, compute Taproot sighash (BIP-341).
3. Sign with Schnorr (BIP-340) using the tweaked private key:
   `tweakedSk = sk + H_taggedTaproot(internalPubkey).bytes` (mod n) — `@noble/curves` has this.
4. Witness = single Schnorr signature.
5. Serialize and broadcast.

This is a single-signer key-path spend; no script-path or MAST in v1.

## Signing — BIP-322 for SDI v2

PearlBridge expects BIP-322 message signatures on the SDI. Build team uses `@scure/btc-signer`'s BIP-322 implementation, or fall back to:
1. Construct virtual `to_spend` tx (per BIP-322).
2. Construct virtual `to_sign` tx spending the `to_spend` output.
3. Sign with Schnorr key-path Taproot.
4. Encode witness as the signature.

Test vector: signed SDI for known mnemonic + amount must match PearlBridge relay's verification.

## Signing — Ethereum

Use `viem`'s `signTransaction` and `signTypedData`. Worker holds the private key, signs, returns serialized signed bytes; main thread submits via `viem` PublicClient.

## Random number generation

- All entropy comes from `crypto.getRandomValues()` (WebCrypto CSPRNG).
- Mnemonic entropy: 128 bits (12 words) or 256 bits (24 words).
- AES-GCM IV: 12 random bytes per encryption.
- PBKDF2 salt: 16 random bytes per wallet.
- Pearl bridge intent nonce: 32 random bytes.
- **Refuse to operate** if `crypto.subtle === undefined` or `crypto.getRandomValues === undefined`.

## Memory hygiene

- Private key buffers in the worker are explicitly zeroed (`.fill(0)`) after use.
- The worker is terminated and respawned on `lock`, so GC-managed JS strings (where we can't zero) are released.
- Password strings: same approach — try to zero, but JS engine may retain copies. Documented limitation.

## Test vectors

For each release the build team must have green tests for:

1. **BIP-39 → BIP-32 → BIP-86 derivation against known vectors** (use the BIP test vectors).
2. **Bech32m round-trip** for Pearl HRP `prl`.
3. **Schnorr signature** matches `@noble/curves` reference vectors.
4. **SDI v2 canonical hash** matches PearlBridge §3.3 conformance hash.
5. **AES-GCM** round-trip with known KDF params.
6. **Restore mnemonic → signs same tx** as the original (deterministic from mnemonic).
7. **Fuzz:** 10,000 random mnemonics; for each derive Pearl + Eth addresses; cross-check against a separate reference implementation (e.g. `bdk` for Pearl, `ethers` for Eth) run by CI.

## Cryptographic dependencies (pinned, in production deps)

```json
{
  "@noble/curves": "1.x (pinned)",
  "@noble/hashes": "1.x (pinned)",
  "@scure/bip32": "1.x (pinned)",
  "@scure/bip39": "1.x (pinned)",
  "@scure/btc-signer": "1.x (pinned)",
  "viem": "2.x (pinned)"
}
```

Each version pinned exactly (no `^`). Dependabot/Renovate PRs reviewed manually for crypto-touching deps; never auto-merged.
