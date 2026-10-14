import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { listVaults } from "../../services/multisig";
import { parseVaultBackup, restoreVaultBackup } from "../../services/vault-backup";
import type { VaultRecord } from "../../storage/db";

// Multisig vault surface — on by default (v0.5.0). Settings exposes an
// opt-out for users who want a pure-singlesig wallet. Ships the full
// create / sign / send flow plus cosign-request auto-import.
export default function Vaults() {
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const [vaults, setVaults] = useState<VaultRecord[] | null>(null);
  const [backupConfirmed,setBackupConfirmed] = useState(false);
  const [backupText, setBackupText] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Belt-and-braces: if a user lands on /vaults with the toggle off
  // (deep link, stale bookmark, back-button), bounce home.
  useEffect(() => {
    if (!multisigEnabled) navigate("/dashboard", { replace: true });
  }, [multisigEnabled, navigate]);

  useEffect(() => {
    if (!multisigEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const out = await listVaults();
        if (!cancelled) setVaults(out);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [multisigEnabled]);

  return (
    <Page title="Vaults">
      <section className="card mb-6 border-warn-line bg-warn-bg">
        <h2 className="text-sm font-semibold text-text-2 leading-relaxed tracking-tight">
          Before you fund a vault
        </h2>
        <p className="mt-2 text-xs text-text-2 leading-relaxed break-words">
          Save each vault’s recovery file from its detail page. Your phrase alone cannot reconstruct its full policy. Always verify the vault address out-of-band with every cosigner
          before sending funds to it — a malicious enroller can hand
          different cosigners different pubkey sets. A vault imported from a
          cosign request is reconstructed from the proposal and bound to its
          address, but the same out-of-band check still applies.
        </p>
      </section>

      <section className="card mb-4 flex flex-col gap-5">
        <h2 className="text-base font-semibold tracking-tight">Your vaults</h2>
        {loadError && (
          <p className="text-sm text-danger leading-relaxed break-words">Couldn't load vaults: {loadError}</p>
        )}
        {vaults === null && !loadError && (
          <p className="text-xs text-text-3 leading-relaxed break-words">Loading…</p>
        )}
        {vaults && vaults.length === 0 && (
          <p className="text-sm text-text-3 leading-relaxed break-words">
            No vaults yet. Create one or import an existing cosigner set.
          </p>
        )}
        {vaults && vaults.length > 0 && (
          <ul className="flex flex-col gap-2">
            {vaults.map((v) => (
              <li key={v.id}>
                <Link
                  to={`/vaults/${v.id}`}
                  className="block rounded-pb border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium leading-relaxed">{v.label}</span>
                    <span className="text-xs text-text-3 leading-relaxed">
                      {v.threshold} of {v.total}
                    </span>
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-text-3 min-w-0 tabular-nums leading-relaxed">
                    {v.pearlAddress.slice(0, 12)}…{v.pearlAddress.slice(-10)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row">
          <Link to="/vaults/new" className="btn-primary flex-1 text-center">
            Create vault
          </Link>
          <Link to="/vaults/sign" className="btn-secondary flex-1 text-center">
            Sign a PSBT
          </Link>
        </div>
      </section>

      <section className="card mb-4">
        <h2 className="text-base font-semibold">Restore a vault recovery file</h2>
        <p className="mt-2 text-sm">First restore the same recovery phrase used to create this file. Paste the public recovery JSON below. Check the address against your own records before restoring.</p>
        <label className="block mt-3">Choose recovery file
          <input className="block mt-2 text-sm" type="file" accept="application/json,.json" disabled={restoreBusy} onChange={async e=>{
            const file=e.target.files?.[0]; if(!file)return;
            setRestoreError(null);
            if(file.size>16384){setRestoreError("Vault backup is too large.");return;}
            try { const text=await file.text();parseVaultBackup(text);setBackupText(text);setBackupConfirmed(false); }
            catch(error){setRestoreError(error instanceof Error ? error.message : String(error));}
          }}/>
        </label>
        <label className="block mt-3">Vault recovery JSON
          <textarea className="input mt-2 w-full font-mono text-xs" rows={5} maxLength={16384} value={backupText} onChange={e=>{setBackupText(e.target.value);setBackupConfirmed(false);setRestoreError(null);}} disabled={restoreBusy}/>
        </label>
        {(() => { try { const b=parseVaultBackup(backupText); return <p className="my-3 break-all">{b.threshold} of {b.pubkeys.length} · {b.address}</p>; } catch { return null; } })()}
        <label className="flex gap-2 mt-3 text-sm"><input type="checkbox" checked={backupConfirmed} disabled={restoreBusy} onChange={e=>setBackupConfirmed(e.target.checked)}/>I checked the displayed address against my saved vault record.</label>
        <button className="btn-secondary mt-3" disabled={restoreBusy || !backupText.trim() || !backupConfirmed} onClick={async()=>{
          setRestoreBusy(true);setRestoreError(null);
          try { const v=await restoreVaultBackup(backupText);navigate(`/vaults/${v.id}`); }
          catch(e){setRestoreError(e instanceof Error ? e.message : String(e));}
          finally{setRestoreBusy(false);}
        }}>{restoreBusy ? "Verifying signing key…" : "Verify and restore vault"}</button>
        {restoreError && <p role="alert" className="mt-2 text-danger">{restoreError}</p>}
      </section>

      <section className="card text-xs text-text-3 leading-relaxed">
        <p className="mb-1 font-medium text-text-2 break-words">
          How co-signing works
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Every cosigner derives their pubkey from the same kind of
            wallet and pastes a JSON descriptor into your Create wizard.
          </li>
          <li>
            Everyone reconstructs the vault locally — same pubkey set +
            same threshold ⇒ same Pearl address. Verify by side-channel
            before funding.
          </li>
          <li>
            To spend: the originator drafts a PSBT and hands it to each
            cosigner, who signs and returns it. Once {`>=`} threshold
            signatures are present, anyone finalises and broadcasts.
          </li>
        </ol>
      </section>
    </Page>
  );
}
