import { useState } from "react";
import type { RecoveredVault, MySlot } from "../../services/vault-import";

// ImportVaultPrompt — shown when a cosign request references a multisig
// vault that isn't on this device yet, AND we've proven we hold a key in
// it. The config here was RECONSTRUCTED from the proposal's PSBT and bound
// to the address (see vault-import.ts); we still surface the address so the
// user can verify it out-of-band before persisting. Never auto-persists —
// the user taps Import.
export default function ImportVaultPrompt(props: {
  recovered: RecoveredVault;
  slot: MySlot;
  defaultLabel: string;
  busy: boolean;
  error: string | null;
  onImport: (label: string) => void;
}) {
  const { recovered, slot, defaultLabel, busy, error, onImport } = props;
  const [label, setLabel] = useState(defaultLabel);
  const trimmed = label.trim();
  const labelValid = trimmed.length >= 1 && trimmed.length <= 64;

  return (
    <div className="rounded-xl border-2 border-pearl-400 bg-pearl-50 p-4 dark:border-pearl-600 dark:bg-pearl-900/30">
      <div className="text-xs font-semibold uppercase tracking-wide text-pearl-700 dark:text-pearl-300">
        New vault in this cosign request
      </div>
      <p className="mt-2 text-sm text-ink-700 dark:text-ink-300">
        This proposal spends from a {recovered.threshold}-of-{recovered.total}{" "}
        vault that isn't on this device yet. The wallet rebuilt its
        configuration from the signed proposal and{" "}
        <span className="font-medium">
          verified it against the address below
        </span>
        . You hold a signing key in it, so you can import it in one step
        instead of re-entering every cosigner.
      </p>

      <div className="mt-3 rounded-lg border border-ink-300 bg-white p-3 dark:border-ink-700 dark:bg-ink-900">
        <div className="text-[11px] font-semibold uppercase text-ink-500">
          Vault address (verify against your source of truth)
        </div>
        <div className="mt-1 break-all font-mono text-xs text-ink-800 dark:text-ink-200">
          {recovered.address}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-ink-500">Policy</dt>
            <dd className="font-medium">
              {recovered.threshold} of {recovered.total} signatures
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Your signing key</dt>
            <dd className="font-medium text-pearl-700 dark:text-pearl-300">
              confirmed in set
            </dd>
          </div>
        </dl>
        <div className="mt-2 break-all font-mono text-[11px] text-ink-500">
          {slot.originPath}
        </div>
      </div>

      <label className="mt-3 block">
        <span className="label">Label for this vault</span>
        <input
          className="input"
          value={label}
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Treasury"
          disabled={busy}
          aria-invalid={!labelValid}
          aria-describedby={!labelValid ? "vault-label-error" : undefined}
        />
      </label>
      {!labelValid && (
        <p id="vault-label-error" className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Label must be 1–64 characters.
        </p>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <button
        className="btn-primary mt-3 w-full"
        disabled={busy || !labelValid}
        onClick={() => onImport(trimmed)}
      >
        {busy ? "Importing…" : "Import vault & continue"}
      </button>
      <p className="mt-2 text-[11px] text-ink-500">
        Importing only adds a watch + signing record to this device. It does
        not move funds. Signing the proposal is a separate, explicit step.
      </p>
    </div>
  );
}
