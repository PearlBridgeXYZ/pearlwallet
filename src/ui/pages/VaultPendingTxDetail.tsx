import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { useWallet } from "../../state/wallet-store";
import {
  getVault,
  getPendingTx,
  savePendingTx,
  deletePendingTx,
  signPendingTx,
  broadcastPendingTx,
  inspectPsbt,
} from "../../services/multisig";
import { formatGrains } from "../../lib/format";
import type { VaultRecord, VaultPendingTxRecord } from "../../storage/db";

// VaultPendingTxDetail — open one drafting/ready/broadcast PSBT, show
// signer progress, sign with our own key, paste-back an externally-
// signed copy returned by a cosigner, broadcast when threshold met.

export default function VaultPendingTxDetail() {
  const { id: vaultId, txid: pendingId } = useParams<{ id: string; txid: string }>();
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const status = useWallet((s) => s.status);

  const [vault, setVault] = useState<VaultRecord | null | undefined>(undefined);
  const [pending, setPending] = useState<VaultPendingTxRecord | null | undefined>(undefined);
  const [pasteIn, setPasteIn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!multisigEnabled) navigate("/dashboard", { replace: true });
  }, [multisigEnabled, navigate]);
  useEffect(() => {
    if (status !== "unlocked") navigate("/unlock", { replace: true });
  }, [status, navigate]);

  useEffect(() => {
    if (!vaultId || !pendingId) return;
    let cancelled = false;
    (async () => {
      const [v, p] = await Promise.all([getVault(vaultId), getPendingTx(pendingId)]);
      if (cancelled) return;
      setVault(v ?? null);
      setPending(p ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, pendingId]);

  // Live re-inspect on every render so a paste-back or freshly-signed
  // state shows accurate progress without waiting for the next save.
  const live = useMemo(() => {
    if (!pending || !vault) return null;
    try {
      return inspectPsbt(pending.psbtBase64, vault.threshold);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const;
    }
  }, [pending, vault]);

  async function doSign() {
    if (!vault || !pending) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await signPendingTx({ vault, pending });
      setPending(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doBroadcast() {
    if (!vault || !pending) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await broadcastPendingTx({ vault, pending });
      setPending(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyPaste() {
    if (!vault || !pending) return;
    const candidate = pasteIn.trim();
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      // Reject a paste-back that doesn't bind to the same vault — if the
      // cosigner pasted a wholly different PSBT we'd silently overwrite
      // the draft. Re-inspect the original to grab its witnessScriptHex,
      // then verify the candidate matches.
      const original = inspectPsbt(pending.psbtBase64, vault.threshold);
      const incoming = inspectPsbt(candidate, vault.threshold);
      if (
        original.witnessScriptHex &&
        incoming.witnessScriptHex &&
        original.witnessScriptHex !== incoming.witnessScriptHex
      ) {
        throw new Error(
          "Pasted PSBT is for a different output — it doesn't match this draft.",
        );
      }
      if (incoming.inputCount !== original.inputCount) {
        throw new Error(
          `Pasted PSBT has ${incoming.inputCount} input(s); this draft has ${original.inputCount}.`,
        );
      }
      const updated: VaultPendingTxRecord = {
        ...pending,
        psbtBase64: candidate,
        signersHex: incoming.signersHex,
        status: incoming.thresholdMet ? "ready" : "drafting",
        updatedAt: Date.now(),
      };
      await savePendingTx(updated);
      setPending(updated);
      setPasteIn("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!pending || !vault) return;
    setBusy(true);
    try {
      await deletePendingTx(pending.id);
      navigate(`/vaults/${vault.id}`, { replace: true });
    } finally {
      setBusy(false);
    }
  }

  function copyPsbt() {
    if (!pending) return;
    void navigator.clipboard?.writeText(pending.psbtBase64).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        setError("Couldn't access the clipboard.");
      },
    );
  }

  if (vault === undefined || pending === undefined) {
    return <Page title="Pending transaction">Loading…</Page>;
  }
  if (vault === null) {
    return (
      <Page title="Pending transaction">
        <p>Vault not found.</p>
        <Link to="/vaults" className="text-pearl-700 underline dark:text-pearl-300">
          ← Back to vaults
        </Link>
      </Page>
    );
  }
  if (pending === null) {
    return (
      <Page title="Pending transaction">
        <p>Draft not found — it may have been deleted or finalised on this device.</p>
        <Link
          to={`/vaults/${vault.id}`}
          className="text-pearl-700 underline dark:text-pearl-300"
        >
          ← Back to vault
        </Link>
      </Page>
    );
  }

  const liveInfo = live && "signerCount" in live ? live : null;
  const liveError = live && "error" in live ? live.error : null;
  const meSigned = liveInfo?.signersHex.includes(vault.myPubkeyHex) ?? false;
  const thresholdMet =
    liveInfo !== null && liveInfo.signerCount >= vault.threshold;
  const isBroadcast = pending.status === "broadcast";
  const isFailed = pending.status === "failed";

  return (
    <Page title="Pending transaction">
      <section className="card mb-4">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">{vault.label}</h2>
          <StatusBadge status={pending.status} />
        </div>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-ink-500">To</dt>
            <dd className="break-all text-right font-mono text-xs">
              {pending.preview.destination}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Amount</dt>
            <dd>{formatGrains(BigInt(pending.preview.amountGrains))} PRL</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Fee</dt>
            <dd>{formatGrains(BigInt(pending.preview.feeGrains))} PRL</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Change back to vault</dt>
            <dd>{formatGrains(BigInt(pending.preview.changeGrains))} PRL</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Inputs</dt>
            <dd>
              {pending.preview.inputCount} UTXO
              {pending.preview.inputCount === 1 ? "" : "s"}
            </dd>
          </div>
          {pending.txid && (
            <div className="flex justify-between gap-2 border-t border-ink-200 pt-1 dark:border-ink-700">
              <dt className="text-ink-500">Broadcast txid</dt>
              <dd className="break-all text-right font-mono text-xs">{pending.txid}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Signatures</h2>
        {liveError && (
          <p className="mt-2 text-sm text-red-600">Couldn't parse PSBT: {liveError}</p>
        )}
        {liveInfo && (
          <>
            <p className="mt-2 text-sm">
              <span className="font-medium">{liveInfo.signerCount}</span> of{" "}
              {vault.threshold} required
              {thresholdMet && (
                <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-[10px] uppercase text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                  threshold met
                </span>
              )}
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-xs">
              {vault.sortedPubkeysHex.map((h) => {
                const signed = liveInfo.signersHex.includes(h);
                const isMe = h === vault.myPubkeyHex;
                return (
                  <li key={h} className="flex items-baseline gap-2 break-all font-mono">
                    <span
                      className={
                        signed
                          ? "text-green-700 dark:text-green-400"
                          : "text-ink-400 dark:text-ink-500"
                      }
                      aria-hidden
                    >
                      {signed ? "✓" : "·"}
                    </span>
                    <span className={isMe ? "text-pearl-700 dark:text-pearl-300" : ""}>
                      {h}
                      {isMe ? " (you)" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {error && (
        <p className="card mb-4 text-sm text-red-600">{error}</p>
      )}

      {!isBroadcast && (
        <section className="card mb-4 flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Actions</h2>
          <div className="flex flex-wrap gap-2">
            {!meSigned && !isFailed && liveInfo && (
              <button
                className="btn-primary"
                disabled={busy}
                onClick={doSign}
                title="Add your cosigner signature"
              >
                {busy ? "Signing…" : "Sign with my key"}
              </button>
            )}
            {thresholdMet && !isFailed && (
              <button
                className="btn-primary"
                disabled={busy}
                onClick={doBroadcast}
                title="Finalise and broadcast"
              >
                {busy ? "Broadcasting…" : "Broadcast"}
              </button>
            )}
            <button className="btn-secondary" disabled={busy} onClick={copyPsbt}>
              {copied ? "Copied!" : "Copy PSBT"}
            </button>
          </div>
          {!thresholdMet && liveInfo && (
            <p className="text-xs text-ink-500">
              Share the PSBT with the next cosigner — they sign and paste
              the result back below.
            </p>
          )}
        </section>
      )}

      {!isBroadcast && (
        <section className="card mb-4">
          <h2 className="text-sm font-semibold">Paste a signed version back</h2>
          <p className="mt-1 text-xs text-ink-500">
            When a cosigner returns the PSBT after signing, paste it here
            to replace the draft. We verify it binds to the same vault
            output before replacing.
          </p>
          <textarea
            className="input mono mt-2"
            rows={6}
            value={pasteIn}
            onChange={(e) => setPasteIn(e.target.value)}
            placeholder="cHNidP8B..."
          />
          <div className="mt-2 flex gap-2">
            <button
              className="btn-secondary"
              disabled={busy || pasteIn.trim().length === 0}
              onClick={applyPaste}
            >
              Apply
            </button>
            {pasteIn && (
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => setPasteIn("")}
              >
                Clear
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card text-xs">
        <h2 className="text-sm font-semibold text-red-600">Remove draft</h2>
        <p className="mt-1 text-ink-500">
          Deleting only removes this draft from your device. Other
          cosigners' copies are unaffected, and the on-chain state is
          unchanged.
        </p>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="btn-secondary mt-2 text-red-600"
            disabled={busy}
          >
            Delete draft
          </button>
        ) : (
          <div className="mt-2 flex gap-2">
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary">
              Cancel
            </button>
            <button onClick={doDelete} className="btn-primary bg-red-600" disabled={busy}>
              Confirm delete
            </button>
          </div>
        )}
      </section>

      <div className="mt-4">
        <Link
          to={`/vaults/${vault.id}`}
          className="text-pearl-700 underline dark:text-pearl-300"
        >
          ← Back to vault
        </Link>
      </div>
    </Page>
  );
}

function StatusBadge({ status }: { status: VaultPendingTxRecord["status"] }) {
  const cls =
    status === "broadcast"
      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
      : status === "ready"
        ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
        : status === "failed"
          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
          : "bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200";
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${cls}`}>{status}</span>
  );
}
