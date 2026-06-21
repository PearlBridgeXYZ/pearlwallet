import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { listVaults } from "../../services/multisig";
import type { VaultRecord } from "../../storage/db";

// Multisig vault surface — on by default (v0.5.0). Settings exposes an
// opt-out for users who want a pure-singlesig wallet. Ships the full
// create / sign / send flow plus cosign-request auto-import.
export default function Vaults() {
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const [vaults, setVaults] = useState<VaultRecord[] | null>(null);
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
      <section className="card mb-4 border-ink-200 bg-ink-50 dark:border-ink-800 dark:bg-ink-900/30">
        <h2 className="text-sm font-semibold text-ink-700 dark:text-ink-200">
          Before you fund a vault
        </h2>
        <p className="mt-2 text-xs text-ink-600 dark:text-ink-400">
          Always verify the vault address out-of-band with every cosigner
          before sending funds to it — a malicious enroller can hand
          different cosigners different pubkey sets. A vault imported from a
          cosign request is reconstructed from the proposal and bound to its
          address, but the same out-of-band check still applies.
        </p>
      </section>

      <section className="card mb-4 flex flex-col gap-3">
        <h2 className="text-base font-semibold">Your vaults</h2>
        {loadError && (
          <p className="text-sm text-red-600">Couldn't load vaults: {loadError}</p>
        )}
        {vaults === null && !loadError && (
          <p className="text-xs text-ink-500">Loading…</p>
        )}
        {vaults && vaults.length === 0 && (
          <p className="text-sm text-ink-500">
            No vaults yet. Create one or import an existing cosigner set.
          </p>
        )}
        {vaults && vaults.length > 0 && (
          <ul className="flex flex-col gap-2">
            {vaults.map((v) => (
              <li key={v.id}>
                <Link
                  to={`/vaults/${v.id}`}
                  className="block rounded-xl border border-ink-200 p-3 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium">{v.label}</span>
                    <span className="text-xs text-ink-500">
                      {v.threshold} of {v.total}
                    </span>
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-ink-500">
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

      <section className="card text-xs text-ink-500">
        <p className="mb-1 font-medium text-ink-600 dark:text-ink-300">
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
