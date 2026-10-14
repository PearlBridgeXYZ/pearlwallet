import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { useWallet } from "../../state/wallet-store";
import {
  getVault,
  deleteVault,
  fetchVaultBalance,
  listPendingTxs,
  deletePendingTx,
  inspectPsbt,
} from "../../services/multisig";
import { confirmVaultBackup, downloadVaultBackup } from "../../services/vault-backup";
import { formatGrains } from "../../lib/format";
import type { PearlNetwork } from "../../chains/pearl/network";

function pearlAddressExplorerUrl(network: PearlNetwork, address: string): string {
  return `https://explorer.pearlresearch.ai/address/${address}?network=${network}`;
}
import type { VaultRecord, VaultPendingTxRecord } from "../../storage/db";

export default function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const [vault, setVault] = useState<VaultRecord | null | undefined>(undefined);
  const [pending, setPending] = useState<VaultPendingTxRecord[]>([]);
  const [backupDownloaded,setBackupDownloaded] = useState(false);
  const [backupAcknowledged,setBackupAcknowledged] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!multisigEnabled) navigate("/dashboard", { replace: true });
  }, [multisigEnabled, navigate]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const v = await getVault(id);
      if (cancelled) return;
      setVault(v ?? null);
      if (v) setPending(await listPendingTxs(v.id));
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const balanceQ = useQuery({
    queryKey: ["vault-balance", vault?.pearlAddress],
    enabled: !!vault,
    queryFn: () => fetchVaultBalance(vault!),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  async function reloadPending() {
    if (!vault) return;
    setPending(await listPendingTxs(vault.id));
  }

  async function doDelete() {
    if (!vault) return;
    await deleteVault(vault.id);
    navigate("/vaults", { replace: true });
  }

  if (vault === undefined) return <Page title="Vault">Loading…</Page>;
  if (vault === null) {
    return (
      <Page title="Vault">
        <p className="break-words">Vault not found.</p>
        <Link to="/vaults" className="text-accent underline underline-offset-4">
          ← Back to vaults
        </Link>
      </Page>
    );
  }

  return (
    <Page title={vault.label}>
      <section className="card mb-6 border-warn-line bg-warn-bg">
        <h2 className="text-sm font-semibold">Back up before funding</h2>
        <p className="mt-2 text-sm">Your recovery phrase alone cannot restore this vault. Save this recovery file and verify its address with every cosigner before funding. It contains the full public policy and your signing-key origin, never your private keys. Keep it private because it links your cosigners and address.</p>
        <button className="btn-secondary mt-3" onClick={() => { try { downloadVaultBackup(vault); setBackupDownloaded(true); setBackupError(null); } catch(e) { setBackupError(e instanceof Error ? e.message : String(e)); } }}>Download vault recovery file</button>
        {!vault.backupConfirmedAt && <>
          <label className="flex gap-2 mt-3 text-sm"><input type="checkbox" checked={backupAcknowledged} disabled={!backupDownloaded} onChange={e=>setBackupAcknowledged(e.target.checked)}/>I saved this recovery file and verified the vault address with my cosigners.</label>
          <button className="btn-primary mt-3" disabled={!backupDownloaded || !backupAcknowledged} onClick={async()=>{try{await confirmVaultBackup(vault.id);setVault((await getVault(vault.id)) ?? null);}catch(e){setBackupError(e instanceof Error ? e.message : String(e));}}}>Confirm saved backup</button>
        </>}
        {backupError && <p role="alert" className="text-danger">{backupError}</p>}
      </section>
      <section className="card mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium leading-relaxed tracking-tight">
            {vault.threshold} of {vault.total} multisig
          </h2>
          {vault.backupConfirmedAt && <a
            href={pearlAddressExplorerUrl(pearlNetwork, vault.pearlAddress)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-accent underline underline-offset-4 leading-relaxed"
          >
            Explorer →
          </a>}
        </div>
        <div className="mt-2 break-all font-mono text-xs min-w-0 tabular-nums leading-relaxed">{vault.backupConfirmedAt ? vault.pearlAddress : "Save and confirm your recovery backup before funding this vault."}</div>
        <div className="mt-3 text-sm leading-relaxed">
          Balance:{" "}
          {balanceQ.data ? (
            <span className="min-w-0 break-all font-mono text-xl font-semibold tabular-nums">
              {formatGrains(balanceQ.data.grains)} PRL
              {balanceQ.data.degraded && (
                <span className="ml-2 text-xs text-warn leading-relaxed">(partial)</span>
              )}
            </span>
          ) : balanceQ.isLoading ? (
            <span className="text-text-3">…</span>
          ) : (
            <span className="text-danger">unavailable</span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {vault.backupConfirmedAt && <Link to={`/vaults/${vault.id}/send`} className="btn-primary">
            Send from vault
          </Link>}
          <Link to="/vaults/sign" className="btn-secondary">
            Sign a PSBT
          </Link>
        </div>
      </section>

      <section className="card mb-6">
        <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Pending transactions</h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-xs text-text-3 leading-relaxed break-words">None yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {pending.map((p) => (
              <PendingRow
                key={p.id}
                vault={vault}
                pending={p}
                onChange={reloadPending}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="card mb-4 text-xs leading-relaxed">
        <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Cosigners</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {vault.sortedPubkeysHex.map((h) => (
            <li key={h} className="break-all font-mono min-w-0 tabular-nums">
              {h === vault.myPubkeyHex ? (
                <span className="text-accent">{h} (you)</span>
              ) : (
                h
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-text-3 break-words">
          Your path: <span className="font-mono break-all min-w-0 tabular-nums">{vault.myOriginPath}</span>
        </p>
      </section>

      <section className="card border-danger-line bg-danger-bg text-sm leading-relaxed">
        <h2 className="text-sm font-semibold text-danger leading-relaxed tracking-tight">Danger zone</h2>
        <p className="mt-1 text-text-3 break-words">
          Deleting removes the local vault record. Funds at the on-chain
          address remain spendable from any wallet that still holds the
          cosigner pubkey set — but you'll need to re-import to spend
          from THIS browser.
        </p>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="btn-secondary mt-2 text-danger min-w-11"
          >
            Delete vault
          </button>
        ) : (
          <div className="mt-2 flex gap-2">
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary min-w-11">
              Cancel
            </button>
            <button onClick={doDelete} className="btn-danger min-w-11">
              Confirm delete
            </button>
          </div>
        )}
      </section>
    </Page>
  );
}

function PendingRow(props: {
  vault: VaultRecord;
  pending: VaultPendingTxRecord;
  onChange: () => void;
}) {
  const { vault, pending } = props;
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Re-inspect the PSBT each render so a stale stored signersHex (e.g.
  // someone hand-pasted a more-signed copy back) doesn't mislead the
  // progress bar.
  const live = (() => {
    try {
      return inspectPsbt(pending.psbtBase64, vault.threshold);
    } catch {
      return null;
    }
  })();

  return (
    <li className="rounded-pb border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm leading-relaxed">
        <div className="min-w-0 break-all font-mono font-medium tabular-nums">
          → {formatGrains(BigInt(pending.preview.amountGrains))} PRL
        </div>
        <div className="text-xs leading-relaxed">
          <StatusBadge status={pending.status} />
          {live && (
            <span className="ml-2 text-text-3">
              {live.signerCount}/{vault.threshold} signed
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 break-all font-mono text-[10px] text-text-3 min-w-0 tabular-nums">
        to {pending.preview.destination.slice(0, 14)}…{pending.preview.destination.slice(-10)}
      </div>
      <div className="mt-2 break-all font-mono text-xs leading-relaxed text-text-3 tabular-nums">
        Fee {formatGrains(BigInt(pending.preview.feeGrains))} PRL · Change{" "}
        {formatGrains(BigInt(pending.preview.changeGrains))} PRL · {pending.preview.inputCount}{" "}
        UTXO{pending.preview.inputCount === 1 ? "" : "s"}
      </div>
      {pending.txid && (
        <div className="mt-1 break-all font-mono text-[10px] text-text-3 min-w-0 tabular-nums">
          txid {pending.txid}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Link to={`/vaults/${vault.id}/tx/${pending.id}`} className="btn-secondary text-xs leading-relaxed">
          Open
        </Link>
        {!confirmRemove ? (
          <button
            onClick={() => setConfirmRemove(true)}
            className="text-xs text-danger underline underline-offset-4 leading-relaxed min-w-11"
          >
            Remove
          </button>
        ) : (
          <div className="flex gap-1 text-xs leading-relaxed">
            <button onClick={() => setConfirmRemove(false)} className="underline underline-offset-4 min-w-11">
              Cancel
            </button>
            <button
              onClick={async () => {
                await deletePendingTx(pending.id);
                props.onChange();
              }}
              className="text-danger underline underline-offset-4 min-w-11"
            >
              Confirm
            </button>
          </div>
        )}
      </div>
    </li>
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
