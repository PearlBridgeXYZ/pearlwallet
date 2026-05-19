# 11 — Open Questions

These need answers BEFORE code starts (or BEFORE the milestone they block). Each has an owner.

## Blocking M1 (kickoff)

### Q1. Pearl L1 BIP-44 / SLIP-44 coin type
- **Question:** what's the SLIP-0044 coin type assigned to Pearl? If unassigned, do we pick a Pearl-specific number, or reuse Bitcoin's `0'` for interop with Sparrow/Electrum?
- **Why it matters:** all HD derivation paths bake this in. Wrong number = wallets don't see each other's addresses.
- **Default if unanswered:** use `0'` (Bitcoin) for maximum interop and propose to Pearl chain leads that this becomes the official assignment.
- **Owner:** Core team to ping Pearl chain leads. Bridge Developer can draft the SLIP-44 PR if needed.

### Q2. Pearl bech32m HRP testnet variant
- **Question:** what HRP does Pearl testnet use? `tprl`? `tprl1`? Something else?
- **Why it matters:** address validation; user-visible chain indicator.
- **Default if unanswered:** check PearlBridge testnet docs from the bridge team.
- **Owner:** Lead engineer in week 1.

### Q3. Pearl RPC method names
- **Question:** does pearld expose `estimatesmartfee` like Bitcoin Core? Is `getreceivedbyaddress` available for non-imported addresses? Or do we need esplora?
- **Why it matters:** indexer choice for M2.
- **Default:** assume esplora is required (safer path). Confirm by inspecting a live pearld instance.
- **Owner:** Lead engineer in week 1.

## Blocking M3 (Eth WPRL)

### Q4. WPRL contract address (mainnet + Sepolia)
- **Question:** what are the canonical mainnet + Sepolia addresses for the WPRL ERC-20 + BridgeRouter?
- **Why it matters:** hardcoded into `bridge/contracts.ts`; getting this wrong means user funds go to a wrong-but-valid address.
- **Default:** pull from PearlBridge `deployment*.json` once mainnet is finalized.
- **Owner:** Bridge Developer to source from PearlBridge deployment files; Lead to verify on-chain.

### Q5. WPRL token decimals
- **Question:** WPRL is 18 decimals (standard ERC-20) or 8 decimals (matching PRL grain precision)?
- **Why it matters:** display math + transfer amount construction. A 10x decimal error = 10x value sent.
- **Default:** 18 (ERC-20 norm) — but VERIFY by calling `decimals()` on the contract at runtime and warning on mismatch.
- **Owner:** Lead engineer.

## Blocking M4 (bridge integration)

### Q6. PearlBridge relayer HTTP API
- **Question:** what endpoints does the relayer expose? Specifically:
  - POST `/intents` (submit SDI for tracking)?
  - GET `/intents/:id/mint-signature`?
  - GET `/burns/:txhash/release-status`?
- **Why it matters:** without these, wallet falls back to direct on-chain polling, which is slower and chattier.
- **Default:** if API doesn't exist, request it from PearlBridge team. Wallet won't ship M4 cleanly without it.
- **Owner:** Lead engineer + Bridge Developer to PearlBridge team.

### Q7. SDI v2 spec — exact field set & encoding
- **Question:** the SDI v2 conformance hash is documented; the exact field set, types, and BIP-322 message format needs to be in a reference doc the wallet can implement against.
- **Why it matters:** if our SDI doesn't match relayer expectations, mint fails silently.
- **Default:** read the PearlBridge `sdi-v2` source; if it's a library, depend on it directly.
- **Owner:** Lead.

### Q8. Bridge fee + limit pull mechanism
- **Question:** are mintFeeBps, burnFeeBps, dailyMintLimit, dailyBurnLimit, tvlCap, minPearlConfirmations all readable from the BridgeRouter contract directly, or do some live in the relayer?
- **Default:** assume on-chain readable per the v0.2 audit context. Fall back to relayer config endpoint if needed.
- **Owner:** Lead.

### Q9. Burn function signature
- **Question:** does WPRL burn require `burn(uint256 amount, bytes32 pearlRecipient)`, or `burn(uint256)` + separate intent submission, or `permitBurn(...)` with EIP-2612?
- **Why it matters:** wallet builds and signs different txs depending.
- **Default:** check WPRL ABI.
- **Owner:** Lead.

## Blocking M5 (security audit)

### Q10. Which audit firm?
- **Question:** Trail of Bits, OpenZeppelin, Cure53, or other?
- **Tradeoffs:** TOB has crypto + web sec depth (best fit). OZ heavily smart-contract focused. Cure53 is web-sec specialists — would also do well here.
- **Default:** TOB or Cure53.
- **Owner:** Core team.

### Q11. Audit budget
- **Question:** what's the budget envelope? Affects scope (full vs. focused review).
- **Default:** $30-80k engagement.
- **Owner:** Core team.

## Blocking launch (M6)

### Q12. Brand & visual identity
- **Question:** logo, palette, typography — pick a small set of curated palettes or commission fresh?
- **Default:** start with a curated palette set and commission a logo from a freelance designer.
- **Owner:** Designer + core team.

### Q13. Legal disclaimer / terms of use
- **Question:** do we need lawyer-drafted ToS for a non-custodial wallet? Jurisdiction?
- **Default:** minimal ToS modeled on MetaMask's (open-sourced). the team's lawyer to review pre-launch.
- **Owner:** Core team.

### Q14. Trademark "Pearl Wallet"
- **Question:** does "Pearl" / "PearlBridge" / "Pearl Wallet" have trademark conflicts (especially in fintech)?
- **Default:** quick USPTO search.
- **Owner:** Core team.

### Q15. Privacy policy
- **Question:** GDPR-light privacy policy required if we serve EU users (we will).
- **Default:** since we collect ~nothing (no analytics, no accounts), policy is short: "We don't collect personal data. Your wallet is in your browser. We log RPC requests minimally for abuse prevention, never identifying."
- **Owner:** Core team.

## Blocking domains

### Q16. Registrar choice given Namecheap block
- **Question:** Namecheap's API rejected both `pearlwallet.xyz` and `prlwallet.xyz` (error 2018166, "restricted phrase" — almost certainly "wallet" on their abuse blocklist). Path options:
  - (a) Register via Namecheap WEB UI manually (the block might only be on the API).
  - (b) Use Porkbun (has API, no known phrase block, similar pricing).
  - (c) Use Cloudflare Registrar (at-cost, no markup, integrates with our CF setup).
- **Default recommendation:** Cloudflare Registrar — pricing is wholesale, eliminates Namecheap dependency, integrates directly with our CF DNS/Pages setup.
- **Owner:** Core team to choose; Bridge Developer to execute.

## Non-blocking but worth resolving early

### Q17. Telemetry & error reporting
- **Question:** opt-in Sentry-style error reporting (helps fix bugs) or zero telemetry (maximum privacy)?
- **Default:** zero in v1. Add opt-in toggle in v1.5.
- **Owner:** Core team.

### Q18. PRL price oracle
- **Question:** is PRL listed on CoinGecko? CoinMarketCap? Where do we get a price feed?
- **Default:** if no oracle, self-publish a `prices.json` updated manually or via a bot pulling from DEXs.
- **Owner:** Bridge Developer to check; core team to engage exchanges/listings.

### Q19. Open-source license
- **Question:** MIT, Apache-2.0, GPLv3, or BUSL?
- **Default:** MIT (matches most wallet repos; permissive enough for forks but doesn't require contributor patents).
- **Owner:** Core team.

### Q20. Translations
- **Question:** ship English-only at v1, or include fr/es/zh from M5?
- **Default:** en-only at v1; add fr/es/zh post-launch based on user origin data (which we won't have — so based on team market priorities).
- **Owner:** Core team.

### Q21. Newsletter / launch comms
- **Question:** do we capture emails on the splash page for launch notification, or skip entirely?
- **Default:** skip. Wallets that ask for emails leak too much trust. Launch via Twitter + Telegram only.
- **Owner:** Core team.

### Q22. Donations / sustainability
- **Question:** does the wallet show a "donate to keep this free" prompt? Take a 0.X% fee on bridges to fund ops?
- **Default:** zero fees, no donation prompt at v1. Re-evaluate post-launch.
- **Owner:** Core team.
