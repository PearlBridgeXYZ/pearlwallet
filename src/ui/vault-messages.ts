// Readable copy for vault signing refusals shared by the cosign page
// (SignMultisigPsbt) and the pending-transaction page (VaultPendingTxDetail).

import { MAX_VAULT_INPUTS } from "../chains/pearl/multisig";

const TOO_MANY_INPUTS_RE = /E_MULTISIG_TOO_MANY_INPUTS(?::\s*(\d+))?/;

/**
 * The message for a vault transaction this wallet refuses to sign because
 * it spends more coins than this wallet signs in one vault transaction
 * (the worker's E_MULTISIG_TOO_MANY_INPUTS, which carries the PSBT's input
 * count); null for any other error. `inputCount` stands in when the error
 * carries no count.
 */
export function vaultSignErrorMessage(e: unknown, inputCount?: number): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  const m = TOO_MANY_INPUTS_RE.exec(msg);
  if (!m) return null;
  const n = m[1] !== undefined ? Number(m[1]) : inputCount;
  const spends =
    n !== undefined && Number.isFinite(n) && n > MAX_VAULT_INPUTS
      ? `spends ${n} vault coins`
      : `spends more than ${MAX_VAULT_INPUTS} vault coins`;
  return (
    `Nothing was signed: this transaction ${spends}, and this wallet signs at most ${MAX_VAULT_INPUTS} per vault transaction. ` +
    `Ask the sender to send less, or to combine the vault's coins first.`
  );
}
