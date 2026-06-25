// BTX L1 network params. BTX is a post-quantum hard fork of Bitcoin Core
// (C++ `btxd`), UTXO, 8 decimals, ~95s blocks. Unlike Pearl (witness-v1
// P2TR + Schnorr), BTX uses witness-v2 **P2MR** outputs signed with
// post-quantum ML-DSA-44 (primary) / SLH-DSA-SHAKE-128s (backup). See
// chains/btx/address.ts for the codec and doc/btx-pqc-spec.md upstream
// (github.com/btxchain/btx) for the consensus profile this mirrors.
//
// NOTE: BTX is pre-production (single-digit peers, no liquidity, model
// price only). This wallet surface ships to the *beta* first
// (next.wallet.pearlbridge.xyz). Treat balances/price as best-effort.

import { isAllowedRpcOverride } from "../../state/ui-store";

export type BtxNetwork = "mainnet";

export interface BtxNetworkParams {
  name: BtxNetwork;
  hrp: string;
  // Witness version of the address program. BTX P2MR = v2 (Pearl P2TR = v1).
  witnessVersion: number;
  // P2MR witness program is the 32-byte Merkle root (doc/btx-pqc-spec.md §4).
  programBytes: number;
  decimals: number;
  // BIP-43 purpose for BTX P2MR descriptors: m/87h/... (btx-pqc-spec.md §7).
  derivationPurpose: number;
  rpcUrl: string;
  rpcLabel: string;
  explorerUrl: string;
}

// The wallet talks to a PUBLIC, method-whitelisted, CORS-enabled read proxy in
// front of the BTX node fleet — NOT the wg-internal `btxd` RPC the bridge relay
// uses (that's basic-auth'd, full-surface, and unreachable from a browser).
// This host is provisioned separately (see project_btx_wallet memory). Until it
// exists, balance/history calls fail closed and the UI shows "unavailable".
// Overridable via Settings → custom RPC (re-validated through the ui-store
// allowlist + public/_headers connect-src, same dual-list rule as Pearl).
export const BTX_MAINNET: BtxNetworkParams = {
  name: "mainnet",
  hrp: "btx",
  witnessVersion: 2,
  programBytes: 32,
  decimals: 8,
  derivationPurpose: 87,
  rpcUrl: "https://btx-rpc.pearlbridge.xyz/",
  rpcLabel: "btx-rpc.pearlbridge.xyz",
  explorerUrl: "https://explorer.minebtx.com",
};

// Client-side failover pool — the wallet rotates through these on 5xx/timeout
// (mirrors Pearl's PEARL_RPC_POOL). Each hostname is a CF-proxied method-
// whitelist edge in front of a different BTX sentry's local btxd; "each a
// fallback to the other" is achieved client-side (no paid CF load balancer,
// no single point of failure). A host that errors or doesn't yet serve an
// origin is skipped exactly like a 5xx, so we can list the full pool before
// every sentry edge is provisioned.
//   btx-rpc  -> s1-hel (46.62.146.11)   [LIVE]
//   btx-rpc2 -> s2-nbg (188.245.32.30)  [edge pending nginx+aiohttp install]
//   btx-rpc3 -> s5-ash (5.161.88.204)   [edge pending nginx+aiohttp install]
// CSP connect-src (public/_headers) + the ui-store override allowlist MUST
// list these same hosts or the browser blocks the fetch before rotation helps.
export const BTX_RPC_POOL: readonly string[] = [
  "https://btx-rpc.pearlbridge.xyz/",
  "https://btx-rpc2.pearlbridge.xyz/",
  "https://btx-rpc3.pearlbridge.xyz/",
];

// Confirmation tiers — size-scaled, lifted verbatim from the bridge relay's BTX
// config (relay/src/btx/config.ts), itself derived from the 51% security
// analysis: BTX shows organic depth-3/4 reorgs, so the floor sits well above 4.
//   <= 250 BTX  -> 12 confs (~19 min)
//   <= 2500 BTX -> 24 confs (~38 min)
//   larger      -> 60 confs (~95 min)
// Single source of truth with the relay so wallet UX and bridge accounting
// never disagree about when a deposit is "safe".
export const BTX_CONF_TIERS: ReadonlyArray<{ maxBtx: number; confs: number }> = [
  { maxBtx: 250, confs: 12 },
  { maxBtx: 2500, confs: 24 },
];
export const BTX_CONF_MAX = 60;

/** Confirmations a received amount (in whole BTX) needs to be treated as final. */
export function btxConfirmationsRequired(amountBtx: number): number {
  for (const t of BTX_CONF_TIERS) if (amountBtx <= t.maxBtx) return t.confs;
  return BTX_CONF_MAX;
}

/** Public block-explorer URL for a BTX txid. */
export function btxTxExplorerUrl(_network: BtxNetwork, txid: string): string {
  return `${BTX_MAINNET.explorerUrl}/tx/${txid}`;
}

/**
 * Default network params, with an optional Settings RPC override. Only the
 * rpcUrl/rpcLabel are replaceable; the address codec params (hrp, witness
 * version, program length, decimals, derivation purpose) stay canonical so
 * pointing at a third-party node can never silently change derived addresses.
 * Mirrors pearlParams() — the override is re-validated at the boundary because
 * a persisted localStorage value can't be trusted to have passed the setter.
 */
export function btxParams(_net: BtxNetwork = "mainnet", override?: string): BtxNetworkParams {
  const trimmed = override?.trim();
  if (!trimmed) return BTX_MAINNET;
  if (!isAllowedRpcOverride(trimmed)) return BTX_MAINNET;
  return { ...BTX_MAINNET, rpcUrl: trimmed, rpcLabel: "custom" };
}
