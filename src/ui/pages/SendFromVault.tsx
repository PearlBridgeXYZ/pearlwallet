import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { useWallet } from "../../state/wallet-store";
import {
  composeVaultSend,
  DUST_LIMIT_GRAINS,
  getVault,
  persistComposedAsPending,
  signPendingTx,
} from "../../services/multisig";
import { MAX_UTXO_WALK_PAGES_HARD } from "../../services/pearl-rpc";
import { formatGrains, parsePRL } from "../../lib/format";
import { validPearl } from "../../lib/validate";
import { useProposal } from "../../state/proposal-store";
import type { VaultRecord } from "../../storage/db";

type Stage = "compose" | "preview" | "saved";

/** Copy for a vault whose history was cut off by the page cap. Its coins
 *  are never offered (they can't be proven unspent); after the default
 *  walk one deeper walk is offered, after the deepest one nothing more. */
export function vaultHistoryCapMessage(deep: boolean): string {
  const deepest = (MAX_UTXO_WALK_PAGES_HARD * 100).toLocaleString("en-US");
  return deep
    ? `Even the deepest search (${deepest} transactions) couldn't read this vault's whole history, so its coins can't be proven unspent. Nothing was composed. Waiting won't change this: spending from this vault needs a wallet backed by a full node.`
    : `This vault has more history than the standard search reads, so its coins can't be proven unspent yet. Nothing was composed. "Search deeper" reads up to ${deepest} transactions (slower).`;
}

/** Same copy as Send PRL for a destination output at or below dust. */
export function vaultDustMessage(): string {
  return `Amount is too small: the network won't relay a payment of ${formatGrains(DUST_LIMIT_GRAINS)} PRL or less.`;
}

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
  // A capped history at the default depth: offer one deeper walk.
  const [offerDeeper, setOfferDeeper] = useState(false);
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

  async function compose(deep = false) {
    if (!vault) return;
    setError(null);
    setOfferDeeper(false);
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
    if (grains <= DUST_LIMIT_GRAINS) {
      setError(vaultDustMessage());
      return;
    }
    setBusy(true);
    try {
      const c = await composeVaultSend({
        vault,
        destination: destination.trim(),
        amountGrains: grains,
        maxPages: deep ? MAX_UTXO_WALK_PAGES_HARD : undefined,
      });
      setComposed(c);
      setStage("preview");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("E_HISTORY_INCOMPLETE")) {
        setError(vaultHistoryCapMessage(deep));
        setOfferDeeper(!deep);
      } else if (msg.includes("E_NO_UTXOS: every vault coin"))
        setError("Every vault coin is already being spent by a transaction broadcast recently. Wait for it to confirm.");
      else if (msg.includes("E_NO_UTXOS")) setError("Vault has no spendable UTXOs.");
      else if (msg.includes("E_AMOUNT_DUST")) setError(vaultDustMessage());
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
        <p className="break-words">Vault not found.</p>
        <Link to="/vaults" className="text-accent underline underline-offset-4">
          ← Back to vaults
        </Link>
      </Page>
    );
  }

  if (stage === "saved" && savedId) {
    return (
      <Page title="Draft saved">
        <div className="card">
          <h2 className="text-lg font-semibold tracking-tight">PSBT saved as draft</h2>
          <p className="mt-2 text-sm text-text-3 leading-relaxed break-words">
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
        <div className="card shadow-slabsm sm:shadow-slab">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Vault transaction preview</p>
          <h2 className="text-xl font-semibold tracking-tight">Review before you sign</h2>
          <p className="mb-4 mt-2 text-sm leading-relaxed text-text-2">Check both addresses, the amount and the fee before saving your draft.</p>
          <dl className="space-y-2 text-sm leading-relaxed divide-y divide-line [&>div]:grid [&>div]:grid-cols-1 [&>div]:gap-2 [&>div]:py-3 sm:[&>div]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-[.12em] [&_dd]:min-w-0 [&_dd]:break-all [&_dd]:font-mono [&_dd]:tabular-nums [&_dd]:text-left sm:[&_dd]:text-right">
            <div className="flex justify-between">
              <dt className="text-text-3">From</dt>
              <dd className="break-all font-mono text-xs min-w-0 tabular-nums leading-relaxed">{vault.pearlAddress}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">To</dt>
              <dd className="break-all font-mono text-xs min-w-0 tabular-nums leading-relaxed">{composed.destination}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">Amount</dt>
              <dd>{formatGrains(composed.amountGrains)} PRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">Fee</dt>
              <dd>{formatGrains(composed.feeGrains)} PRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">Change back to vault</dt>
              <dd>{formatGrains(composed.changeGrains)} PRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">Inputs</dt>
              <dd>
                {composed.utxos.length} UTXO{composed.utxos.length === 1 ? "" : "s"}
              </dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2">
              <dt className="font-medium">Total leaving vault</dt>
              <dd className="font-medium">
                {formatGrains(composed.amountGrains + composed.feeGrains)} PRL
              </dd>
            </div>
          </dl>

          {composed.degraded && (
            <p className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-3 text-xs text-warn leading-relaxed break-words">
              Some vault coins came back without the data needed to spend
              them and were left out; the vault may hold more than this
              transaction can use.
            </p>
          )}
          {composed.pendingExcluded > 0 && (
            <p className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-3 text-xs text-warn leading-relaxed break-words">
              {composed.pendingExcluded} vault coin{composed.pendingExcluded === 1 ? " was" : "s were"} left out —
              already being spent by a transaction broadcast recently.
            </p>
          )}

          <label className="mt-4 flex items-start gap-2 text-sm leading-relaxed">
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

          <p className="mt-4 text-xs text-text-3 leading-relaxed break-words">
            Saving creates a draft. Threshold-met PSBTs can be broadcast
            from the draft page. Nothing goes on chain until you click
            broadcast there.
          </p>

          {error && <p className="mt-2 text-sm text-danger leading-relaxed break-words">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button
              className="btn-secondary min-w-11"
              disabled={busy}
              onClick={() => setStage("compose")}
            >
              Back
            </button>
            <button className="btn-primary flex-1 min-w-11" disabled={busy} onClick={saveDraft}>
              {busy ? "Saving…" : "Save draft"}
            </button>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Send from vault">
      <div className="card flex flex-col gap-5">
        <div className="text-sm leading-relaxed">
          <span className="text-text-3">From vault:</span>{" "}
          <span className="font-medium">{vault.label}</span>{" "}
          <span className="text-xs text-text-3 leading-relaxed">
            ({vault.threshold} of {vault.total})
          </span>
        </div>
        <label className="block">
          <span className="label">Destination address</span>
          <input
            className="input mono break-all min-w-0 tabular-nums"
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
            className="input mono break-all min-w-0 tabular-nums"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        {error && <p className="text-sm text-danger leading-relaxed break-words">{error}</p>}

        <div className="flex gap-2">
          <Link to={`/vaults/${vault.id}`} className="btn-secondary">
            Cancel
          </Link>
          {offerDeeper && (
            <button className="btn-secondary min-w-11" disabled={busy} onClick={() => void compose(true)}>
              Search deeper
            </button>
          )}
          <button className="btn-primary flex-1 min-w-11" disabled={busy} onClick={() => void compose(false)}>
            {busy ? "Composing…" : "Review"}
          </button>
        </div>
      </div>
    </Page>
  );
}
