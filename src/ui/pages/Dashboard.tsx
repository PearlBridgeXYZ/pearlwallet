import { Link } from "react-router-dom";
import Page from "../components/Page";
import ActivityList from "../components/ActivityList";
import CopyAddress from "../components/CopyAddress";
import InstallPWA from "../components/InstallPWA";
import BtxCard from "../components/BtxCard";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { useWalletBalances } from "../hooks/useWalletBalances";
import { formatGrains, formatWei, formatWprl, formatUSD } from "../../lib/format";

export default function Dashboard() {
  const addresses = useWallet((s) => s.addresses);
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const offlineSigningEnabled = useUI((s) => s.offlineSigningEnabled);
  const btxEnabled = useUI((s) => s.btxEnabled);

  // v0.7: progressive per-asset balances (see ui/hooks/useWalletBalances.ts).
  // Each asset shows as soon as its own source answers; the total needs
  // only PRL + price and is null (never $0.00) while either is unknown.
  const pool = addresses ? addresses.pearlPool ?? [addresses.pearl] : [];
  const b = useWalletBalances({ pool, ethAddr: addresses?.eth, ethEnabled });
  const price = b.price.value;
  const usdOf = (v: bigint | null) =>
    v !== null && price !== null ? `≈ ${formatUSD((price * Number(v)) / 1e8)}` : "";

  return (
    <Page>
      {/* Install banner — self-suppresses when already installed, on
          file://, on desktops without an install path, or after the
          user dismisses it once. Sits above the balance card so it's
          the first thing mobile users see on a fresh install. */}
      <div className="mb-4">
        <InstallPWA variant="banner" />
      </div>

      <div className="card">
        <div className="text-xs uppercase tracking-wide text-ink-500">Total balance</div>
        {b.totalUsd !== null ? (
          <div className="mt-1 text-3xl font-semibold">{formatUSD(b.totalUsd)}</div>
        ) : b.prl.value !== null && b.price.status === "error" ? (
          <div className="mt-1 text-sm text-ink-500">Price unavailable</div>
        ) : b.prl.status === "error" && !b.scan.running ? (
          <div className="mt-1 text-sm text-ink-500">Balance unavailable — retrying shortly.</div>
        ) : b.scan.running && b.scan.total > 0 ? (
          <div className="mt-1 text-sm text-ink-500">Scanning {b.scan.done}/{b.scan.total}…</div>
        ) : (
          <div className="mt-1 text-sm text-ink-500">Loading, please wait a few seconds…</div>
        )}
        {(b.totalStatus === "partial" || b.totalStale) && b.totalUsd !== null && (
          <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {b.totalStatus === "partial" ? "Some balances couldn't be read — total may be low." : "Showing last known balance."}
          </div>
        )}

        <div className={`mt-5 grid gap-4 ${ethEnabled ? "grid-cols-3" : "grid-cols-1"}`}>
          <div>
            <div className="text-xs text-ink-500">PRL</div>
            <div className="text-xl font-medium">
              {b.prl.value !== null ? formatGrains(b.prl.value) : "—"}
            </div>
            <div className="text-xs text-ink-500">{usdOf(b.prl.value)}</div>
            {b.prl.status === "partial" && (
              <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                Partial — some addresses couldn't be read.
              </div>
            )}
            {b.prl.status === "error" && (
              <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                Pearl RPC unreachable.
              </div>
            )}
          </div>
          {ethEnabled && (
            <>
              <div>
                <div className="text-xs text-ink-500">WPRL</div>
                <div className="text-xl font-medium">
                  {b.wprl?.value != null ? formatWprl(b.wprl.value) : "—"}
                </div>
                <div className="text-xs text-ink-500">{usdOf(b.wprl?.value ?? null)}</div>
                {b.wprl?.status === "error" && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                    Eth RPC unreachable.
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-ink-500">ETH (gas)</div>
                <div className="text-xl font-medium">
                  {b.eth?.value != null ? formatWei(b.eth.value) : "—"}
                </div>
                {b.eth?.status === "error" && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                    Eth RPC unreachable.
                  </div>
                )}
                {b.wprl?.value != null && b.wprl.value > 0n && b.eth?.value === 0n && b.eth.status === "ok" && !b.eth.stale && (
                  <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    Fund ETH to send WPRL.
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {ethEnabled ? (
          <>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Link to="/send/prl" className="btn-secondary tap">Send PRL</Link>
              <Link to="/send/wprl" className="btn-secondary tap">Send WPRL</Link>
              <Link to="/send/eth" className="btn-secondary tap">Send ETH</Link>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Link to="/receive" className="btn-secondary tap">Receive</Link>
              <Link to="/bridge" className="btn-primary tap">Bridge</Link>
            </div>
          </>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Link to="/send/prl" className="btn-secondary tap">Send PRL</Link>
            <Link to="/receive" className="btn-secondary tap">Receive</Link>
          </div>
        )}
        {multisigEnabled && (
          <div className="mt-2">
            <Link to="/vaults" className="btn-secondary block w-full text-center">
              Vaults
            </Link>
          </div>
        )}
        {offlineSigningEnabled && (
          <div className="mt-2">
            <Link to="/offline-sign" className="btn-secondary block w-full text-center">
              Offline signing <span className="text-xs text-amber-700 dark:text-amber-400">(experimental)</span>
            </Link>
          </div>
        )}
      </div>

      <div className="card mt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Your addresses</h2>
          <Link to="/receive" className="text-xs text-pearl-700 hover:underline">View QR</Link>
        </div>
        <div className="mt-3 space-y-3 text-sm">
          <CopyAddress label="Pearl L1" value={addresses?.pearl ?? "—"} />
          {ethEnabled && (
            <CopyAddress label="Ethereum (WPRL + ETH)" value={addresses?.eth ?? "—"} />
          )}
        </div>
      </div>

      {btxEnabled && <BtxCard />}

      <div className="card mt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <Link to="/history" className="text-xs text-pearl-700 hover:underline">See all</Link>
        </div>
        {/* Start the activity scan once the first PRL scan has settled so
            it doesn't compete with the balance scan for the RPC budget. */}
        <ActivityList limit={5} truncate enabled={b.prl.status !== "loading"} />
      </div>

      <div className="mt-4 text-center text-xs text-ink-400">
        <Link to="/about" className="hover:underline">About this wallet</Link>
      </div>
    </Page>
  );
}
