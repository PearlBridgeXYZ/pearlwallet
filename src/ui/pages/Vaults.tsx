import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";

// Multisig surface — gated by Settings → "Experimental: multisig".
// v0.1.18 ships the on-chain primitives (vault address derivation,
// pubkey descriptors, BIP-67 sort, NUMS-bound key-path) so an
// auditor or curious user can verify the construction. The UI flows
// (create-vault, exchange descriptors, draft + sign PSBT) land in
// follow-up releases. We surface the toggle now so the audit window
// covers the primitives and the off-by-default toggle in the same
// release, before any spendable surface exists.
export default function Vaults() {
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);

  // Belt-and-braces: if a user manages to land on /vaults with the
  // toggle off (deep link, stale bookmark, browser back-button from
  // a session where they toggled on then off), bounce them home.
  // The route is intentionally not linked when the toggle is off.
  useEffect(() => {
    if (!multisigEnabled) navigate("/dashboard", { replace: true });
  }, [multisigEnabled, navigate]);

  return (
    <Page title="Vaults">
      <section className="card mb-4 border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20">
        <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
          Experimental — in development
        </h2>
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          Multisig vaults are an opt-in experimental feature. The
          on-chain primitives (BIP-342 tapscript m-of-n, BIP-67-sorted
          cosigner pubkeys, NUMS-bound internal key) ship with v0.1.18
          for audit. The user-facing flows — create vault, exchange
          cosigner descriptors, draft and co-sign transactions —
          arrive in follow-up releases.
        </p>
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          Don't move funds into a vault yet — there's no spend flow.
          Turn this surface off in{" "}
          <Link to="/settings" className="underline">Settings</Link> if
          you'd rather not see it.
        </p>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">What's available now</h2>
        <ul className="mt-2 list-disc pl-5 text-xs text-ink-600 dark:text-ink-300 space-y-1">
          <li>
            Deterministic vault address from a set of cosigner pubkeys
            and an m-of-n threshold — anyone reconstructing with the
            same inputs gets the same Pearl bech32m address.
          </li>
          <li>
            Cosigner pubkey descriptor (JSON) — versioned, network-tagged,
            human-readable, copy-paste-safe.
          </li>
          <li>
            Dedicated BIP-32 derivation path
            (<span className="font-mono">m/86'/808276'/100'/account'/i</span>)
            kept apart from your singlesig receive pool.
          </li>
          <li>
            Internal key explicitly bound to the BIP-341 NUMS point —
            the key-path spend is provably disabled, so the m-of-n
            tapscript is the only way to move funds.
          </li>
        </ul>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Coming up</h2>
        <ul className="mt-2 list-disc pl-5 text-xs text-ink-600 dark:text-ink-300 space-y-1">
          <li>Create-vault flow with cosigner enrolment + address verification.</li>
          <li>Vault balance + UTXO listing.</li>
          <li>PSBT-style co-signing — draft offline, share via QR or file, finalise once threshold is met.</li>
          <li>Optional Safe-style co-signing for the WPRL / ETH side.</li>
        </ul>
        <p className="mt-3 text-xs text-ink-500">
          Track progress at{" "}
          <a
            href="https://github.com/PearlBridgeXYZ/pearlwallet"
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            github.com/PearlBridgeXYZ/pearlwallet
          </a>
          .
        </p>
      </section>
    </Page>
  );
}
