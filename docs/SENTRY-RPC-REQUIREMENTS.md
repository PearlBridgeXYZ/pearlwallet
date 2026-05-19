# Sentry-Fronted Pearl RPC — provisioning brief for PearlBridge ops

PearlWallet talks to Pearl L1 via one of the PearlBridge sentries. The
wallet's `src/chains/pearl/network.ts` points `rpcUrl` at:

```
mainnet: https://pearl-sentry-fsn1-1.pearlbridge.xyz/rpc
testnet: https://pearl-sentry-testnet.pearlbridge.xyz/rpc
```

The label `pearl-sentry-fsn1-1` matches the SENTRY-ARCH design (fleet A,
FSN1, host index 1 — i.e. `sA1` in `PearlBridgeXYZ/operations/sentry-fleet/docs/SENTRY-ARCH.md`).
Pick a different host by editing that one file; no other code changes needed.

## What the sentry needs to expose

A public HTTPS endpoint at `https://<sentry-host>/rpc` that proxies to the
sentry's `pearld` JSON-RPC port (44107 by default) **behind an allowlist
proxy** modelled on `PearlBridgeXYZ/backend/infra/rpc-allowlist-proxy/`.

### Required CORS

```
Access-Control-Allow-Origin: https://pearlwallet.xyz
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

Never `*`. The wallet is the only authorised browser origin.

### Allowed JSON-RPC methods (read-only + tx broadcast)

```
getbestblock
getbestblockhash
getblock
getblockcount
getblockhash
getblockheader
getrawmempool
getrawtransaction
gettxout
sendrawtransaction
searchrawtransactions
estimatefee
estimatesmartfee
getmempoolinfo
```

Explicitly **blocked** even if accidentally added to the allowlist (regex
`^(debug_|admin_|wallet|node|miner|generate|setban|importprivkey|dumpprivkey|signrawtransaction|signrawtransactionwithwallet)`).

### Constraints

- `searchrawtransactions` MUST require an `addresses` filter and reject empty
  scans (unbounded historical reads otherwise).
- `sendrawtransaction` accepts the hex blob only — no `allowhighfees=true`.
- Rate limit: 60 req/min per source IP. The wallet polls every 10 s for
  pending bridge actions, so a single user is well under the limit.
- Max body size: 64 KiB (rejects malformed/oversized payloads).

### TLS

- Let's Encrypt cert via certbot.
- HSTS preload, `max-age=63072000; includeSubDomains`.
- TLS 1.2+ only.

### Auth

- No BasicAuth on the wallet path — the wallet's traffic is unauthenticated
  per-user. The allowlist + CORS + rate-limit is the only gate.
- The wallet does NOT proxy validator-only traffic; that stays on wg.

## Why one sentry, not three

For the wallet's read traffic, one sentry per side is enough. If sA1 is
unreachable, the wallet shows "PRL balance pending sentry RPC" rather than
silently misreporting balances. Quorum / multi-sentry agreement is a relayer
concern (see SENTRY-ARCH §4), not a wallet concern — the wallet is just
displaying chain state and broadcasting user-signed tx.

If load justifies it later, edit `network.ts:rpcUrl` to a load-balancer
hostname that fronts sA1+sA2+sA3.

## Failure mode the wallet handles

If the sentry is down or returns 5xx:
- Balances service flips to `prlSource = "pending-sentry"`; UI shows a
  "PRL balance is loading via sentry RPC" notice rather than 0 PRL.
- Send PRL refuses to broadcast and surfaces the error to the user.
- Bridge PRL→WPRL refuses to compose without the deposit-confirmation
  poll being able to reach a sentry.

## Provisioning checklist (for ops)

- [ ] Pick concrete host (currently labelled `pearl-sentry-fsn1-1`)
- [ ] Create CF DNS A record `pearl-sentry-fsn1-1.pearlbridge.xyz` → sentry IP
- [ ] Install allowlist proxy (clone the rpc-allowlist-proxy pattern; replace
      ETH allowed methods with the btcd list above)
- [ ] nginx 443 → proxy port (loopback only), HSTS + CSP
- [ ] certbot --nginx
- [ ] Smoke test: `curl -X POST https://pearl-sentry-fsn1-1.pearlbridge.xyz/rpc -H 'Content-Type: application/json' -d '{"jsonrpc":"1.0","method":"getbestblock","params":[]}'`
- [ ] Confirm `Origin: https://attacker.example` is rejected at OPTIONS
- [ ] Confirm `debug_*` methods are rejected at POST
- [ ] Update `pearl-sentry-fsn1-1` in `PearlBridgeXYZ/operations/sentry-fleet/`
      inventory with the provisioned host

When the sentry is live, PearlWallet's PRL balance + Pearl-side broadcast
become real — no wallet-side code change needed.
