// PearlBridge developer-tip configuration.
//
// When the user sends PRL (and opts in), the wallet adds an extra
// output to the PearlBridge fees address. The default tip is
// max(10 bps of the send amount, 1 PRL). Users can disable tipping
// entirely from Settings — when disabled the wallet sends nothing
// extra, and using the wallet costs nothing beyond on-chain fees.

import type { PearlNetwork } from "./network";

const PRL_GRAINS_PER_COIN = 100_000_000n;

// Tip recipient address is public — only the receive side is in
// the repo; the spending key is held by the PearlBridge core team.
export const TIP_ADDRESS_MAINNET =
  "prl1ptzrunj28tua9uklxa3ses9nsl7g22s2qx2fdu9gf7wgvup58s94q9ldnxh";

// 10 basis points = 0.1% = amount / 1000.
export const TIP_BPS = 10n;
const TIP_DIVISOR = 10_000n;

// Floor so a one-grain tip is never produced — small sends still
// produce a meaningful 1 PRL tip.
export const TIP_MIN_GRAINS = PRL_GRAINS_PER_COIN; // 1 PRL

export function computeTipGrains(sendAmountGrains: bigint): bigint {
  if (sendAmountGrains <= 0n) return 0n;
  // Skip the tip entirely when the send is smaller than the floor.
  // Without this guard, a 0.01 PRL send would carry a 1 PRL tip — 100×
  // the principal — and the user's "Total" line would silently balloon.
  // The bps rate already produces a meaningful tip at >= 1 PRL sends.
  if (sendAmountGrains < TIP_MIN_GRAINS) return 0n;
  const bpsTip = (sendAmountGrains * TIP_BPS) / TIP_DIVISOR;
  return bpsTip > TIP_MIN_GRAINS ? bpsTip : TIP_MIN_GRAINS;
}

export function tipAddressFor(_net: PearlNetwork = "mainnet"): string {
  return TIP_ADDRESS_MAINNET;
}
