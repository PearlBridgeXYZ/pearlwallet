# PearlWallet

**An open-source, non-custodial wallet for PRL on Pearl and WPRL and ETH on Ethereum, with PearlBridge built in.**

- **Web:** [wallet.pearlbridge.xyz](https://wallet.pearlbridge.xyz)
- **Downloads:** [GitHub releases](https://github.com/PearlBridgeXYZ/pearlwallet/releases) — releases include a single-file HTML build for signing on an offline machine. Check the SHA-256 GitHub shows for the asset.
- **Status:** experimental, pre-1.0 software. Only store what you can afford to lose.

PearlBridge is an independent project, not affiliated with Pearl Research Labs.

---

## Your keys

Your recovery phrase is created and encrypted in your browser. No server stores or receives your keys. The wallet is encrypted with AES-256-GCM under a key derived from your password with 600,000 rounds of PBKDF2-SHA256; the encrypted data is stored in this browser (IndexedDB).

Keep your 12- or 24-word phrase somewhere safe. There is no password reset or support unlock. If you lose access to your wallet and your phrase, your funds cannot be recovered. Anyone who has your phrase can take your funds.

## What it does

- Create a wallet, or import an existing 12- or 24-word recovery phrase.
- Hold and send **PRL** on Pearl (Taproot), and **WPRL** and **ETH** on Ethereum, from one recovery phrase.
- **Bridge** PRL ↔ WPRL through PearlBridge. Bridging carries smart-contract and operational risk; check the live backing at [pearlbridge.xyz/audit](https://pearlbridge.xyz/audit) first.
- **Multisig vaults**: m-of-n Taproot vaults with co-signing.
- **Offline signing** (experimental, off by default): compose on an online device, sign in the offline build, broadcast from the online device.
- Combine many small coins into fewer, and see recent activity.
- An **optional developer tip** on PRL sends: no tip on sends under 1 PRL, a flat 1 PRL on sends of 1 to 1,000 PRL, and 0.1% above 1,000 PRL. It is on by default and can be turned off in Settings. Network and bridge fees are separate.

Before you sign, a PRL send shows the destination, amount and network fee; a bridge transfer shows the bridge fee and the Pearl network fee or Ethereum gas of the transaction being signed.

**BTX:** this version does not show BTX balances and cannot send BTX. Coins on the BTX chain are untouched and stay controlled by your recovery phrase, so keep it.

## Privacy and local protection

The app has no analytics or trackers. Balance and activity lookups use PearlBridge's Pearl RPC and public Ethereum RPC services. Those services can see your IP address and the wallet addresses you query. The Pearl RPC override in Settings accepts only PearlBridge hosts, so it can't point at your own node.

- Signing and key handling run in an isolated worker.
- A strict content security policy limits which hosts the wallet can connect to.
- The wallet locks after five minutes of inactivity.
- While the wallet stays open, it tries to clear an address you copied from the clipboard after 60 seconds (best effort: browsers may refuse, and a clipboard you have copied something else into is left alone).

## The offline build

`pearlwallet-offline-vX.Y.Z.html` is the whole wallet in one HTML file; its signing worker is bundled inside it. It runs from `file://`. It does not stop itself from using the network: opened on an online machine it looks up balances like the web version. For offline signing, open it on a machine that has no network connection. Broadcasting a signed transaction still requires an online machine.

## Reviews

The repository includes public security review reports (`AUDIT-*.md`) covering versions v0.1.0 through v0.4.3, each listing findings by severity and how they were handled. These are AI-assisted, multi-model reviews; they do not guarantee that the current wallet is free of vulnerabilities. No paid third-party audit has taken place.

## Build it yourself

```bash
git clone https://github.com/PearlBridgeXYZ/pearlwallet.git
cd pearlwallet
npm ci
npm test                # the automated test suite
npm run build           # web bundle → dist/
npm run build:offline   # single-file HTML → dist-offline/
```

Builds embed their build time, so your files won't be byte-identical to a release; compare the source at the release tag.

### Stack

Vite, React and TypeScript (strict); Tailwind; Zustand for app state; Dexie (IndexedDB) for the encrypted keystore. Crypto comes from [`@scure/bip32`](https://github.com/paulmillr/scure-bip32), [`@scure/bip39`](https://github.com/paulmillr/scure-bip39), [`@scure/btc-signer`](https://github.com/paulmillr/scure-btc-signer), [`@noble/curves`](https://github.com/paulmillr/noble-curves) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes); Ethereum through [`viem`](https://viem.sh). Dependencies are locked in `package-lock.json`.

### Layout

```
src/
├── chains/      Pearl and Ethereum: address codecs, network parameters, RPC
├── crypto/      recovery phrase, HD derivation, keystore, signing worker
├── lib/         small utilities (formatting, validation, offline-signing payloads)
├── services/    balances, sends, broadcast records, bridge, vaults, activity
├── state/       Zustand stores
├── storage/     Dexie schema
└── ui/          React components and pages
tests/           Vitest suite
docs/            specs, threat model, architecture notes
AUDIT-*.md       review reports
```

## Contact

- Security issues: `bridgedev@mailbox.org`. Please don't open public issues with vulnerability details.
- Bridge project: [PearlBridge](https://pearlbridge.xyz)
- Repository: [github.com/PearlBridgeXYZ/pearlwallet](https://github.com/PearlBridgeXYZ/pearlwallet)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license does not grant use of the PearlWallet or PearlBridge names. Releases through v0.7.0 shipped without a license file (their package metadata declared MIT); this license applies from this commit on.
