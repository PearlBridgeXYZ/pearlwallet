import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { listVaults } from "../../services/multisig";
import type { VaultRecord } from "../../storage/db";

// Multisig surface — gated by Settings → "Experimental: multisig".
// v0.2.0 ships the full create / sign / send flow; the toggle stays
// experimental until a public audit closes out the spend path.
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
      <section className="card mb-4 border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20">
        <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
          Experimental
        </h2>
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          Multisig vaults are an opt-in feature. Test with small amounts
          first. Verify the vault address out-of-band with every cosigner
          before funding — a malicious enroller can hand different
          cosigners different pubkey sets.
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
