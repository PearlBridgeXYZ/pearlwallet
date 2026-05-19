# Reference materials

This directory holds external artifacts the build team needs to copy in (or symlink) before code starts. They're not committed by default — `.gitignore` may exclude them — but they're listed here so it's obvious what's needed.

## From PearlBridge

Required:
- `deployment-mainnet.json` — mainnet contract addresses (WPRL, BridgeRouter, lock address).
- `deployment-sepolia.json` — Sepolia equivalents.
- `contracts/BridgeRouter.sol` ABI (compiled out).
- `contracts/WPRL.sol` ABI.
- `docs/sdi-v2-spec.md` — canonical JSON format + conformance hash.
- `docs/eip712-domain.md` — domain + types for mint signature.
- `relay/openapi.yaml` — relayer HTTP API spec.

The Bridge Developer can route these from the PearlBridge repo; otherwise file an Open Question back to the bridge team.

## From Pearl L1 chain spec

Required:
- Pearl bech32m HRP spec (mainnet + testnet).
- Pearl network magic / chain params.
- Pearl RPC method list (or pointer to a live node's `help` output).
- Pearl SLIP-44 coin type (if assigned).
- Pearl test vectors for taproot key-path spends (Pearl testnet).

Source: Pearl chain leads.

## Useful tooling

- A tier-based EIP-1559 fee policy reference (Bridge Developer can share).
- Pearl wallet ledger + policies (Bridge Developer can share).
- A status-alert webhook for ops integration.

## Test vectors needed (collect in `reference/test-vectors/`)

- BIP-32 standard test vectors (RFC) — public.
- BIP-39 wordlist + sample mnemonics — public.
- BIP-86 derivation test vectors — public.
- BIP-340 Schnorr test vectors — public.
- bech32m test vectors with various HRPs — public.
- A canonical SDI v2 test vector that hashes to the conformance hash — must be obtained from PearlBridge.
- A canonical EIP-712 mint signature from a known relayer key — must be obtained from PearlBridge.

## License notes

When the wallet repo is open-sourced (post-audit), confirm license compatibility of all referenced artifacts:
- `@noble/*` — MIT
- `@scure/*` — MIT
- `viem` — MIT
- PearlBridge contracts/ABIs — confirm with PearlBridge team
- Test vectors — public domain / RFC
