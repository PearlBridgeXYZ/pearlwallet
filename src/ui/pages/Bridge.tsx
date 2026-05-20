import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import CopyAddress from "../components/CopyAddress";
import { useWallet } from "../../state/wallet-store";

const BRIDGE_URL = "https://pearlbridge.xyz";

export default function Bridge() {
  const navigate = useNavigate();
  const addresses = useWallet((s) => s.addresses);

  return (
    <Page title="Bridge">
      <div className="card flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Bridge PRL ↔ WPRL</h2>
          <p className="mt-2 text-sm text-ink-600 dark:text-ink-400">
            Bridging is handled by <span className="font-medium">PearlBridge</span>, the
            audited Pearl ↔ Ethereum bridge. Open it in a new tab and paste your
            wallet addresses below as the destination.
          </p>
        </div>

        <div className="rounded-xl border border-ink-200 p-3 text-xs dark:border-ink-700">
          <div className="mb-2 text-ink-500">Your destinations</div>
          <div className="space-y-3">
            <CopyAddress
              label="For WPRL → PRL, paste:"
              value={addresses?.pearl ?? "—"}
            />
            <CopyAddress
              label="For PRL → WPRL, paste:"
              value={addresses?.eth ?? "—"}
            />
          </div>
        </div>

        <a
          href={BRIDGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary text-center"
        >
          Open PearlBridge ↗
        </a>

        <button onClick={() => navigate("/dashboard")} className="btn-secondary">
          Back to dashboard
        </button>

        <p className="text-xs text-ink-500">
          We'll embed the bridge flow directly inside the wallet in a later
          release. For now, PearlBridge runs at{" "}
          <a
            href={BRIDGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-pearl-700 underline dark:text-pearl-300"
          >
            pearlbridge.xyz
          </a>
          .
        </p>
      </div>
    </Page>
  );
}
