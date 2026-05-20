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
        <p>Vault not found.</p>
        <Link to="/vaults" className="text-pearl-700 underline dark:text-pearl-300">
          ← Back to vaults
        </Link>
      </Page>
    );
  }

  return (
    <Page title={vault.label}>
      <section className="card mb-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">
            {vault.threshold} of {vault.total} multisig
          </h2>
          <a
            href={pearlAddressExplorerUrl(pearlNetwork, vault.pearlAddress)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-pearl-700 underline dark:text-pearl-300"
          >
            Explorer →
          </a>
        </div>
        <div className="mt-2 break-all font-mono text-xs">{vault.pearlAddress}</div>
        <div className="mt-3 text-sm">
          Balance:{" "}
          {balanceQ.data ? (
            <span className="font-medium">
              {formatGrains(balanceQ.data.grains)} PRL
              {balanceQ.data.degraded && (
                <span className="ml-2 text-xs text-amber-600">(partial)</span>
              )}
            </span>
          ) : balanceQ.isLoading ? (
            <span className="text-ink-500">…</span>
          ) : (
            <span className="text-red-600">unavailable</span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={`/vaults/${vault.id}/send`} className="btn-primary">
            Send from vault
          </Link>
          <Link to="/vaults/sign" className="btn-secondary">
            Sign a PSBT
          </Link>
        </div>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Pending transactions</h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-xs text-ink-500">None yet.</p>
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

      <section className="card mb-4 text-xs">
        <h2 className="text-sm font-semibold">Cosigners</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {vault.sortedPubkeysHex.map((h) => (
            <li key={h} className="break-all font-mono">
              {h === vault.myPubkeyHex ? (
                <span className="text-pearl-700 dark:text-pearl-300">{h} (you)</span>
              ) : (
                h
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-ink-500">
          Your path: <span className="font-mono">{vault.myOriginPath}</span>
        </p>
      </section>

      <section className="card text-xs">
        <h2 className="text-sm font-semibold text-red-600">Danger zone</h2>
        <p className="mt-1 text-ink-500">
          Deleting removes the local vault record. Funds at the on-chain
          address remain spendable from any wallet that still holds the
          cosigner pubkey set — but you'll need to re-import to spend
          from THIS browser.
        </p>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="btn-secondary mt-2 text-red-600"
          >
            Delete vault
          </button>
        ) : (
          <div className="mt-2 flex gap-2">
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary">
              Cancel
            </button>
            <button onClick={doDelete} className="btn-primary bg-red-600">
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
    <li className="rounded-xl border border-ink-200 p-3 dark:border-ink-700">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <div className="font-medium">
          → {formatGrains(BigInt(pending.preview.amountGrains))} PRL
        </div>
        <div className="text-xs">
          <StatusBadge status={pending.status} />
          {live && (
            <span className="ml-2 text-ink-500">
              {live.signerCount}/{vault.threshold} signed
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 break-all font-mono text-[10px] text-ink-500">
        to {pending.preview.destination.slice(0, 14)}…{pending.preview.destination.slice(-10)}
      </div>
      <div className="mt-1 text-[10px] text-ink-500">
        Fee {formatGrains(BigInt(pending.preview.feeGrains))} PRL · Change{" "}
        {formatGrains(BigInt(pending.preview.changeGrains))} PRL · {pending.preview.inputCount}{" "}
        UTXO{pending.preview.inputCount === 1 ? "" : "s"}
      </div>
      {pending.txid && (
        <div className="mt-1 break-all font-mono text-[10px] text-ink-500">
          txid {pending.txid}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Link to={`/vaults/${vault.id}/tx/${pending.id}`} className="btn-secondary text-xs">
          Open
        </Link>
        {!confirmRemove ? (
          <button
            onClick={() => setConfirmRemove(true)}
            className="text-xs text-red-600 underline"
          >
            Remove
          </button>
        ) : (
          <div className="flex gap-1 text-xs">
            <button onClick={() => setConfirmRemove(false)} className="underline">
              Cancel
            </button>
            <button
              onClick={async () => {
                await deletePendingTx(pending.id);
                props.onChange();
              }}
              className="text-red-600 underline"
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
