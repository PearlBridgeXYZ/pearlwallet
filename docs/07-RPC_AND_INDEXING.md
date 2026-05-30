# 07 — RPC & Indexing

## Pearl L1 RPC

### What we need

| Call | Purpose |
|------|---------|
| `getblockchaininfo` | Network health, current height |
| `getblockheader <hash>` | Block timestamps for tx history |
| `getbalance <address>` (custom) or scanned via `listunspent` | Display PRL balance |
| `listunspent <minconf> <maxconf> [addresses]` | UTXOs for coin selection |
| `gettxout <txid> <vout>` | Confirm a UTXO before spending |
| `sendrawtransaction <hex>` | Broadcast |
| `getrawtransaction <txid> [verbose]` | Tx detail + confirmations |
| `estimatesmartfee <target>` | Fee tier estimation |
| `getmempoolentry <txid>` | Mempool status |
| `getnetworkinfo` | RPC version sanity check |
| `getreceivedbyaddress <address>` (or via `listtransactions`) | Tx history |

> Pearl is a btcd-fork, so it speaks Bitcoin-style JSON-RPC. The build team should pull the exact method names + signatures from a live Pearl node's `help` output OR from the pearld source.

### RPC proxy

We do **not** expose pearld directly to browsers. Instead:

```
Browser  ─── HTTPS ───►  rpc.pearlwallet.xyz  ─── HTTPS ───►  pearld (private)
```

The proxy:
- Terminates TLS with our cert.
- Adds CORS headers (`Access-Control-Allow-Origin: https://pearlwallet.xyz` only).
- Rate-limits per IP (e.g. 10 req/s, 100 req/min).
- Allowlists methods (no `stop`, `setban`, wallet methods, etc.).
- Logs nothing identifying (no IPs, no method args beyond method name + status).
- Forwards to one of N pearld nodes with health-check failover.

Implementation choice: Cloudflare Worker (low cost, edge cache) OR a small VPS with nginx + rate-limit module. Recommend **Cloudflare Worker** for simplicity, with origin = a tunneled pearld endpoint on a VPS.

Source for pearld endpoints: existing PearlBridge sentry fleet. Coordinate with the fleet watchdog to ensure wallet's read load doesn't impact bridge SLA.

### Backup pearld

The wallet must function during pearld outages. Mitigation:
- Run 2+ pearld instances, load-balanced.
- Cloudflare Worker fails over.
- On total outage, wallet shows banner "Pearl network connection issues; balances may be stale" but doesn't crash.

### Endpoint discovery

The wallet's RPC URL is **baked in** at build time (`PEARL_RPC_URL = "https://rpc.pearlwallet.xyz"`). NOT user-configurable in v1 (custom RPCs are a vector for fake-balance attacks). v2 may add advanced RPC override behind a "Developer mode" toggle with a scary warning.

## Pearl indexer (for tx history)

`listtransactions` is a wallet-only RPC method (requires the address to be imported into pearld's wallet). For a non-custodial setup where each user has their own addresses, this doesn't work — we'd need pearld to import every user's address into its watch-only wallet, which is unscalable and a privacy leak.

**Two options:**

### Option 1 — Watch-only address scan via REST/RPC
Wallet asks the proxy "give me last 50 txs for `prl1p...`" — the proxy queries pearld for tx history. Requires pearld to have indexed addresses or a separate Esplora/electrs-like indexer.

### Option 2 — Run electrs / esplora alongside pearld (RECOMMENDED)
- **electrs** (Romanian Electrum server, Rust) supports btcd-fork chains with minor patching.
- **esplora** (Blockstream) gives a clean HTTP REST API for address tx history.
- Either provides:
  - `GET /address/<addr>/txs` — all txs for an address
  - `GET /address/<addr>/utxo` — UTXO list (cleaner than `listunspent`)
  - `GET /tx/<txid>` — tx detail
  - `GET /fee-estimates` — fee estimation

Build team should evaluate which of electrs/esplora compiles cleanest against Pearl (test on testnet first). This is a meaningful infra cost (1 small VPS) but eliminates a class of indexing pain.

**Recommended:** esplora-style HTTP service, exposed at `idx.pearlwallet.xyz`.

## Ethereum RPC

### Endpoints
Per `reference_infura_dead` memory, Infura is offline for us. Use:
- **Primary:** `https://ethereum-rpc.publicnode.com`
- **Fallback:** `https://eth.drpc.org`

Both are public, no key required, free tier sufficient for retail wallet load.

For Sepolia testnet:
- `https://ethereum-sepolia-rpc.publicnode.com`
- `https://sepolia.drpc.org`

### Library
`viem` v2. Set up two `PublicClient` instances with a fallback transport:

```ts
import { createPublicClient, fallback, http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';

const transport = fallback([
  http('https://ethereum-rpc.publicnode.com'),
  http('https://eth.drpc.org'),
]);

export const ethClient = createPublicClient({ chain: mainnet, transport });
```

For sending: `viem` `WalletClient` with a custom signer that forwards to the worker.

### Tx history (WPRL ERC-20)

`viem` doesn't have a built-in "all transfers for address" RPC because EVM doesn't either. Options:

1. **Etherscan API** (free, 5 req/s) — `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=<WPRL>&address=<user>`. Pros: easy. Cons: third-party dependency, rate limit, requires API key.
2. **Index WPRL transfers ourselves** via `getLogs` with topic filter — works without any third party, but slow for cold queries (full chain scan).
3. **Use a graph indexer** — overkill for a single contract.

v1 recommendation: **Option 1 (Etherscan)** behind our RPC proxy (cache responses 60s). API key is project-owned, not user-owned. If Etherscan goes down, fall back to direct `getLogs` from RPC for last 10k blocks.

## Price oracle

For USD-equivalent display:
- **CoinGecko free tier** (no key required, 10-50 req/min): `GET /simple/price?ids=pearl&vs_currencies=usd`
- Cache 60s in browser; cache 30s in our edge.
- Show "≈ $X.XX" with disclaimer it's approximate.
- If oracle down: hide USD column, show native units only.

PRL needs a CoinGecko listing. If not yet listed, fall back to a manual oracle published at `https://pearlwallet.xyz/oracle.json` (build team updates).

## RPC error handling

| Error class | Wallet response |
|-------------|-----------------|
| Network timeout | Retry 3x with exponential backoff (250ms, 1s, 4s); then show error |
| HTTP 429 (rate limit) | Backoff + show "Slow down a bit, try again in a moment" |
| HTTP 5xx | Mark RPC as degraded for 30s, switch to fallback |
| Parse error (invalid JSON) | Log to console + Sentry-like (opt-in only); show generic E_RPC_DOWN |
| Mismatched chainId | Critical error: refuse to operate, prompt user to reload |

## Rate limit / cost

Back-of-envelope for 10k MAU:
- Pearl RPC: ~30 req per user per session × 3 sessions/week × 10k = ~900k req/week
- Eth RPC: similar, but most public RPCs scale to millions/day for free
- Indexer (esplora on a small VPS): trivial load
- Etherscan: 5 req/s = 432k/day. Sufficient with 60s caching.

A small (~€10/mo) VPS comfortably handles pearld + esplora for that load.

## Pinned endpoint list

```ts
// src/services/rpc-endpoints.ts
export const ENDPOINTS = {
  pearl: {
    mainnet: { rpc: "https://rpc.pearlwallet.xyz", idx: "https://idx.pearlwallet.xyz" },
    testnet: { rpc: "https://testnet-rpc.pearlwallet.xyz", idx: "https://testnet-idx.pearlwallet.xyz" },
  },
  ethereum: {
    mainnet: {
      rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
      etherscan: "https://api.etherscan.io/api",
    },
    sepolia: {
      rpcs: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
      etherscan: "https://api-sepolia.etherscan.io/api",
    },
  },
  price: { coingecko: "https://api.coingecko.com/api/v3" },
};
```

CSP's `connect-src` must include exactly these origins, nothing else.
