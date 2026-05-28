import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { useWallet } from "../../state/wallet-store";
import {
  composeVaultSend,
  getVault,
  persistComposedAsPending,
  signPendingTx,
} from "../../services/multisig";
import { formatGrains, parsePRL } from "../../lib/format";
import { validPearl } from "../../lib/validate";
import { useProposal } from "../../state/proposal-store";
import type { VaultRecord } from "../../storage/db";

type Stage = "compose" | "preview" | "saved";

export default function SendFromVault() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const status = useWallet((s) => s.status);
  const pearlNetwork = useWallet((s) => s.pearlNetwork);

  const [vault, setVault] = useState<VaultRecord | null | undefined>(undefined);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<Stage>("compose");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composed, setComposed] = useState<Awaited<ReturnType<typeof composeVaultSend>> | null>(
    null,
  );
  const [savedId, setSavedId] = useState<string | null>(null);
  // "Sign immediately after saving" — the originator typically also
  // signs as their first cosigner contribution. Checked by default; can
  // be unchecked if they just want to draft and hand it off.
  const [signImmediately, setSignImmediately] = useState(true);

  useEffect(() => {
    if (!multisigEnabled) navigate("/dashboard", { replace: true });
  }, [multisigEnabled, navigate]);
  useEffect(() => {
    if (status !== "unlocked") navigate("/unlock", { replace: true });
  }, [status, navigate]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const v = await getVault(id);
      if (!cancelled) setVault(v ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Prefill from a relay-delivered tx-intent if VaultProposal stashed one.
  // The amount comes over as grains-as-string; we convert to a decimal PRL
  // string for the input. Consume the proposal slot so a later visit to
  // /vaults/:id/send doesn't re-fill on its own.
  const consumeIntent = useProposal((s) => s.consumeIntent);
  useEffect(() => {
    if (!vault) return;
    const pending = consumeIntent();
    if (!pending) return;
    if (pending.intent.vaultAddress !== vault.pearlAddress) {
      // VaultProposal already routed us to the right vault; this is a
      // belt-and-braces guard against a stale slot from a different vault.
      return;
    }
    setDestination(pending.intent.destination);
    try {
      setAmount(formatGrains(BigInt(pending.intent.amountGrains)));
    } catch {
      // If grains is malformed, leave the field blank — user will see
      // the error when they try to compose.
    }
  }, [vault, consumeIntent]);

  async function compose() {
    if (!vault) return;
    setError(null);
    if (!validPearl(destination, pearlNetwork)) {
      setError("Destination isn't a valid Pearl address.");
      return;
    }
    let grains: bigint;
    try {
      grains = parsePRL(amount);
    } catch {
      setError("Enter a valid PRL amount.");
      return;
    }
    if (grains <= 0n) {
      setError("Amount must be greater than 0.");
      return;
    }
    setBusy(true);
    try {
      const c = await composeVaultSend({
        vault,
        destination: destination.trim(),
        amountGrains: grains,
      });
      setComposed(c);
      setStage("preview");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("E_NO_UTXOS")) setError("Vault has no spendable UTXOs.");
      else if (msg.includes("E_INSUFFICIENT_FUNDS"))
        setError("Insufficient funds in the vault to cover amount + fee.");
      else setError(`Compose failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!vault || !composed) return;
    setBusy(true);
    setError(null);
    try {
      let pending = await persistComposedAsPending({
        vault,
        psbtBase64: composed.psbtBase64,
        preview: {
          destination: composed.destination,
          amountGrains: composed.amountGrains.toString(),
          feeGrains: composed.feeGrains.toString(),
          changeGrains: composed.changeGrains.toString(),
          inputCount: composed.utxos.length,
        },
      });
      if (signImmediately) {
        pending = await signPendingTx({ vault, pending });
      }
      setSavedId(pending.id);
      setStage("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (vault === undefined) return <Page title="Send from vault">Loading…</Page>;
  if (vault === null) {
    return (
      <Page title="Send from vault">
        <p>Vault not found.</p>
        <Link to="/vaults" className="text-pearl-700 underline dark:text-pearl-300">
          ← Back to vaults
        </Link>
      </Page>
    );
  }

  if (stage === "saved" && savedId) {
    return (
      <Page title="Draft saved">
        <div className="card">
          <h2 className="text-lg font-semibold">PSBT saved as draft</h2>
          <p className="mt-2 text-sm text-ink-500">
            Open the draft to share the PSBT with your cosigners. Once{" "}
            {vault.threshold} of {vault.total} have signed, anyone can
            finalise and broadcast.
          </p>
          <div className="mt-4 flex gap-2">
            <Link
              to={`/vaults/${vault.id}/tx/${savedId}`}
              className="btn-primary flex-1 text-center"
            >
              Open draft
            </Link>
            <Link to={`/vaults/${vault.id}`} className="btn-secondary">
              Back to vault
            </Link>
          </div>
        </div>
      </Page>
    );
  }

  if (stage === "preview" && composed) {
    return (
      <Page title="Confirm — send from vault">
        <div className="card">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-500">From</dt>
              <dd className="break-all font-mono text-xs">{vault.pearlAddress}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">To</dt>
              <dd className="break-all font-mono text-xs">{composed.destination}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Amount</dt>
              <dd>{formatGrains(composed.amountGrains)} PRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Fee</dt>
              <dd>{formatGrains(composed.feeGrains)} PRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Change back to vault</dt>
              <dd>{formatGrains(composed.changeGrains)} PRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Inputs</dt>
              <dd>
                {composed.utxos.length} UTXO{composed.utxos.length === 1 ? "" : "s"}
              </dd>
            </div>
            <div className="flex justify-between border-t border-ink-200 pt-2 dark:border-ink-700">
              <dt className="font-medium">Total leaving vault</dt>
              <dd className="font-medium">
                {formatGrains(composed.amountGrains + composed.feeGrains)} PRL
              </dd>
            </div>
          </dl>

          {composed.degraded && (
            <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              UTXO scan returned a partial set; consider retrying if the
              broadcast later fails for insufficient funds.
            </p>
          )}

          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={signImmediately}
              onChange={(e) => setSignImmediately(e.target.checked)}
              className="mt-1"
            />
            <span>
              Sign with my cosigner key now (adds 1 of {vault.threshold}{" "}
              signatures before saving)
            </span>
          </label>

          <p className="mt-4 text-xs text-ink-500">
            Saving creates a draft. Threshold-met PSBTs can be broadcast
            from the draft page. Nothing goes on chain until you click
            broadcast there.
          </p>

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => setStage("compose")}
            >
              Back
            </button>
            <button className="btn-primary flex-1" disabled={busy} onClick={saveDraft}>
              {busy ? "Saving…" : "Save draft"}
            </button>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Send from vault">
      <div className="card flex flex-col gap-3">
        <div className="text-sm">
          <span className="text-ink-500">From vault:</span>{" "}
          <span className="font-medium">{vault.label}</span>{" "}
          <span className="text-xs text-ink-500">
            ({vault.threshold} of {vault.total})
          </span>
        </div>
        <label className="block">
          <span className="label">Destination address</span>
          <input
            className="input mono"
            placeholder="prl1p…"
            value={destination}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">Amount (PRL)</span>
          <input
            className="input mono"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <Link to={`/vaults/${vault.id}`} className="btn-secondary">
            Cancel
          </Link>
          <button className="btn-primary flex-1" disabled={busy} onClick={compose}>
            {busy ? "Composing…" : "Review"}
          </button>
        </div>
      </div>
    </Page>
  );
}
