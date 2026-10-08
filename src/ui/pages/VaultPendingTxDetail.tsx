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
  psbtOutputsEqual,
  assertPsbtMatchesPreview,
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
      // URL carries both ids independently; refuse to render a pending tx
      // whose vaultId doesn't match the URL's vault. Otherwise a tampered
      // URL would show pending P (for vault B) under vault A's header.
      // The worker still refuses to sign — outputScript binding catches it
      // — but the UI mismatch is itself a footgun. (audit pass 4, L1)
      if (p && v && p.vaultId !== v.id) {
        setVault(null);
        setPending(null);
        return;
      }
      setVault(v ?? null);
      setPending(p ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, pendingId]);

  // Live re-inspect on every render so a paste-back or freshly-signed
  // state shows accurate progress without waiting for the next save.
  // Pass the vault cosigner set so the count excludes forged sigs from
  // pubkeys outside the vault (audit pass 2, Medium #2).
  const live = useMemo(() => {
    if (!pending || !vault) return null;
    try {
      return inspectPsbt(pending.psbtBase64, vault.threshold, vault.sortedPubkeysHex);
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
      // the draft. We check four things and refuse on any mismatch:
      //   1. witnessScriptHex non-empty + identical (input is OUR vault)
      //   2. input count unchanged
      //   3. outputs unchanged (scripts + amounts in same positions)
      //   4. no foreign signers (pubkeys outside the vault cosigner set)
      //
      // (3) is the audit-pass-2 Medium #1 fix: a hostile cosigner could
      // sign a copy of the PSBT whose outputs have been rerouted to drain
      // to their own address, then return it. Without per-output
      // comparison the user would see the original preview and broadcast.
      const original = inspectPsbt(
        pending.psbtBase64,
        vault.threshold,
        vault.sortedPubkeysHex,
      );
      const incoming = inspectPsbt(candidate, vault.threshold, vault.sortedPubkeysHex);
      if (!incoming.witnessScriptHex) {
        throw new Error(
          "Pasted PSBT is missing witnessUtxo data — can't verify it binds to this vault.",
        );
      }
      if (incoming.witnessScriptHex !== original.witnessScriptHex) {
        throw new Error(
          "Pasted PSBT is for a different output — it doesn't match this draft.",
        );
      }
      if (incoming.inputCount !== original.inputCount) {
        throw new Error(
          `Pasted PSBT has ${incoming.inputCount} input(s); this draft has ${original.inputCount}.`,
        );
      }
      if (!psbtOutputsEqual(original.outputs, incoming.outputs)) {
        throw new Error(
          "Pasted PSBT has different outputs than the draft — a cosigner appears to have altered the destination or amount. Discarding.",
        );
      }
      if (incoming.foreignSignersHex.length > 0) {
        throw new Error(
          `Pasted PSBT contains ${incoming.foreignSignersHex.length} signature(s) from pubkeys outside this vault — discarding.`,
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
        <p className="break-words">Vault not found.</p>
        <Link to="/vaults" className="text-accent underline underline-offset-4">
          ← Back to vaults
        </Link>
      </Page>
    );
  }
  if (pending === null) {
    return (
      <Page title="Pending transaction">
        <p className="break-words">Draft not found — it may have been deleted or finalised on this device.</p>
        <Link
          to={`/vaults/${vault.id}`}
          className="text-accent underline underline-offset-4"
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

  // Cross-check: do the actual PSBT outputs + fee still match the
  // originator's composition preview? If not, a cosigner has altered the
  // destination, amount, change, or fee. Block sign + broadcast so the
  // user can't accidentally finalise a rerouted spend. The service layer
  // also enforces this on signPendingTx / broadcastPendingTx (audit pass
  // 3 L1) — the UI banner just makes the failure visible up-front rather
  // than after the user clicks Sign.
  const outputMismatch = (() => {
    if (!liveInfo) return null;
    try {
      assertPsbtMatchesPreview(liveInfo, pending.preview, vault.pearlAddress);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.replace(/^E_MULTISIG_OUTPUT_MISMATCH:\s*/, "");
    }
  })();

  return (
    <Page title="Pending transaction">
      <section className="card mb-6 shadow-slabsm sm:shadow-slab">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Transaction preview</p>
        <h2 className="mb-3 text-xl font-semibold tracking-tight">Review before you sign</h2>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium leading-relaxed tracking-tight">{vault.label}</h2>
          <StatusBadge status={pending.status} />
        </div>
        <dl className="space-y-1 text-sm leading-relaxed divide-y divide-line [&>div]:grid [&>div]:grid-cols-1 [&>div]:gap-2 [&>div]:py-3 sm:[&>div]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-[.12em] [&_dd]:min-w-0 [&_dd]:break-all [&_dd]:font-mono [&_dd]:tabular-nums [&_dd]:text-left sm:[&_dd]:text-right">
          <div className="flex justify-between gap-2">
            <dt className="text-text-3">To</dt>
            <dd className="break-all text-right font-mono text-xs min-w-0 tabular-nums leading-relaxed">
              {pending.preview.destination}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-3">Amount</dt>
            <dd>{formatGrains(BigInt(pending.preview.amountGrains))} PRL</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-3">Fee (preview)</dt>
            <dd>{formatGrains(BigInt(pending.preview.feeGrains))} PRL</dd>
          </div>
          {liveInfo && !liveInfo.feeUnknown && (
            <div className="flex justify-between">
              <dt className="text-text-3">Fee (live)</dt>
              <dd
                className={
                  liveInfo.feeGrains === BigInt(pending.preview.feeGrains)
                    ? ""
                    : "font-semibold text-danger"
                }
              >
                {formatGrains(liveInfo.feeGrains)} PRL
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-text-3">Change back to vault</dt>
            <dd>{formatGrains(BigInt(pending.preview.changeGrains))} PRL</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-3">Inputs</dt>
            <dd>
              {pending.preview.inputCount} UTXO
              {pending.preview.inputCount === 1 ? "" : "s"}
            </dd>
          </div>
          {pending.txid && (
            <div className="flex justify-between gap-2 border-t border-line pt-1">
              <dt className="text-text-3">Broadcast txid</dt>
              <dd className="break-all text-right font-mono text-xs min-w-0 tabular-nums leading-relaxed">{pending.txid}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Signatures</h2>
        {liveError && (
          <p className="mt-2 text-sm text-danger leading-relaxed break-words">Couldn't parse PSBT: {liveError}</p>
        )}
        {liveInfo && (
          <>
            <p className="mt-2 text-sm leading-relaxed break-words">
              <span className="font-medium">{liveInfo.signerCount}</span> of{" "}
              {vault.threshold} required
              {thresholdMet && (
                <span className="ml-2 rounded-pb bg-accent-soft px-2 py-0.5 text-[10px] uppercase text-accent">
                  threshold met
                </span>
              )}
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-xs leading-relaxed">
              {vault.sortedPubkeysHex.map((h) => {
                const signed = liveInfo.signersHex.includes(h);
                const isMe = h === vault.myPubkeyHex;
                return (
                  <li key={h} className="flex items-baseline gap-2 break-all font-mono min-w-0 tabular-nums">
                    <span
                      className={
                        signed
                          ? "text-ok"
                          : "text-text-3"
                      }
                      aria-hidden
                    >
                      {signed ? "✓" : "·"}
                    </span>
                    <span className={isMe ? "text-accent" : ""}>
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

      {outputMismatch && (
        <section className="card mb-4 border-2 border-danger-line bg-danger-bg">
          <h2 className="text-sm font-semibold text-danger leading-relaxed tracking-tight">
            ⚠ Output mismatch — do not sign
          </h2>
          <p className="mt-1 text-sm text-danger leading-relaxed break-words">
            {outputMismatch}
          </p>
          <p className="mt-2 text-xs text-danger leading-relaxed break-words">
            Signing or broadcasting is disabled. Delete this draft and start over.
          </p>
        </section>
      )}

      {error && (
        <p className="card mb-4 text-sm text-danger leading-relaxed break-words">{error}</p>
      )}

      {!isBroadcast && (
        <section className="card mb-4 flex flex-col gap-2">
          <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Actions</h2>
          <div className="flex flex-wrap gap-2">
            {!meSigned && !isFailed && liveInfo && (
              <button
                className="btn-primary min-w-11"
                disabled={busy || outputMismatch !== null}
                onClick={doSign}
                title={
                  outputMismatch
                    ? "Refusing to sign — outputs don't match the draft"
                    : "Add your cosigner signature"
                }
              >
                {busy ? "Signing…" : "Sign with my key"}
              </button>
            )}
            {thresholdMet && !isFailed && (
              <button
                className="btn-primary min-w-11"
                disabled={busy || outputMismatch !== null}
                onClick={doBroadcast}
                title={
                  outputMismatch
                    ? "Refusing to broadcast — outputs don't match the draft"
                    : "Finalise and broadcast"
                }
              >
                {busy ? "Broadcasting…" : "Broadcast"}
              </button>
            )}
            <button className="btn-secondary min-w-11" disabled={busy} onClick={copyPsbt}>
              {copied ? "Copied!" : "Copy PSBT"}
            </button>
          </div>
          {!thresholdMet && liveInfo && !outputMismatch && (
            <p className="text-xs text-text-3 leading-relaxed break-words">
              Share the PSBT with the next cosigner — they sign and paste
              the result back below.
            </p>
          )}
        </section>
      )}

      {!isBroadcast && (
        <section className="card mb-4">
          <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Paste a signed version back</h2>
          <p className="mt-1 text-xs text-text-3 leading-relaxed break-words">
            When a cosigner returns the PSBT after signing, paste it here
            to replace the draft. We verify it binds to the same vault
            output before replacing.
          </p>
          <label className="mt-3 block">
            <span className="label">Signed PSBT (base64)</span>
            <textarea
              className="input mono mt-2 break-all min-w-0 tabular-nums"
              rows={6}
              value={pasteIn}
              onChange={(e) => setPasteIn(e.target.value)}
              placeholder="cHNidP8B..."
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              className="btn-secondary min-w-11"
              disabled={busy || pasteIn.trim().length === 0}
              onClick={applyPaste}
            >
              Apply
            </button>
            {pasteIn && (
              <button
                className="btn-secondary min-w-11"
                disabled={busy}
                onClick={() => setPasteIn("")}
              >
                Clear
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card text-xs leading-relaxed">
        <h2 className="text-sm font-semibold text-danger leading-relaxed tracking-tight">Remove draft</h2>
        <p className="mt-1 text-text-3 break-words">
          Deleting only removes this draft from your device. Other
          cosigners' copies are unaffected, and the on-chain state is
          unchanged.
        </p>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="btn-secondary mt-2 text-danger min-w-11"
            disabled={busy}
          >
            Delete draft
          </button>
        ) : (
          <div className="mt-2 flex gap-2">
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary min-w-11">
              Cancel
            </button>
            <button onClick={doDelete} className="btn-danger min-w-11" disabled={busy}>
              Confirm delete
            </button>
          </div>
        )}
      </section>

      <div className="mt-4">
        <Link
          to={`/vaults/${vault.id}`}
          className="text-accent underline underline-offset-4"
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
      ? "bg-surface-2 text-ok"
      : status === "ready"
        ? "bg-accent-soft text-accent"
        : status === "failed"
          ? "bg-danger-bg text-danger"
          : "bg-surface-2 text-text-2";
  return (
    <span className={`rounded-pb px-2 py-0.5 text-[10px] uppercase ${cls}`}>{status}</span>
  );
}
