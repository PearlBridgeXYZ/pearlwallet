// Readable copy for Pearl compose refusals shared by Send PRL, Send from
// vault, the offline-sign live composer and the Bridge wrap.

import { formatGrains } from "../lib/format";
import { DUST_LIMIT_GRAINS } from "../services/pearl-tx";

/** A destination output at or below dust (E_AMOUNT_DUST). */
export function dustAmountMessage(): string {
  return `Amount is too small: the network won't relay a payment of ${formatGrains(DUST_LIMIT_GRAINS)} PRL or less.`;
}

/** The readable message for E_AMOUNT_DUST; null for any other error. */
export function dustErrorMessage(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("E_AMOUNT_DUST") ? dustAmountMessage() : null;
}
