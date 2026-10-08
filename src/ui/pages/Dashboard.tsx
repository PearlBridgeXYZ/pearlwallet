import { Link } from "react-router-dom";
import Page from "../components/Page";
import ActivityList from "../components/ActivityList";
import CopyAddress from "../components/CopyAddress";
import InstallPWA from "../components/InstallPWA";
import BtxCard from "../components/BtxCard";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { btxSurfaceOn } from "../../lib/features";
import { useWalletBalances } from "../hooks/useWalletBalances";
import { formatGrains, formatWei, formatWprl, formatUSD } from "../../lib/format";

export default function Dashboard() {
  const addresses = useWallet((s) => s.addresses);
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const offlineSigningEnabled = useUI((s) => s.offlineSigningEnabled);
  const btxOn = btxSurfaceOn(useUI((s) => s.btxEnabled));

  // v0.7: progressive per-asset balances (see ui/hooks/useWalletBalances.ts).
  // Each asset shows as soon as its own source answers; the total needs
  // only PRL + price and is null (never $0.00) while either is unknown.
  const pool = addresses ? addresses.pearlPool ?? [addresses.pearl] : [];
  // Both single-sig branches + gap-limit discovery (services/discovery.ts);
  // newly found addresses are persisted to the keystore record.
  const derivePearlAddresses = useWallet((s) => s.derivePearlAddresses);
  const extendPearlAddresses = useWallet((s) => s.extendPearlAddresses);
  const b = useWalletBalances({
    pool,
    changePool: addresses?.pearlChange,
    deriveMore: derivePearlAddresses,
    onDiscovered: extendPearlAddresses,
    ethAddr: addresses?.eth,
    ethEnabled,
  });
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

      <h1 className="page-title">Your wallet</h1>
      <div className="card shadow-slabsm sm:shadow-slab">
        <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Total balance</div>
        {b.totalUsd !== null ? (
          <div className="mt-3 break-all text-[38px] font-semibold leading-none tracking-[-.5px] tabular-nums sm:text-5xl">{formatUSD(b.totalUsd)}</div>
        ) : b.prl.value !== null && b.price.status === "error" ? (
          <div className="mt-3 text-lg text-text-3">Price unavailable</div>
        ) : b.prl.status === "error" && !b.scan.running ? (
          <div className="mt-3 text-lg text-text-3">Balance unavailable. Retrying shortly.</div>
        ) : b.scan.running && b.scan.total > 0 ? (
          <div role="status" className="mt-3 text-lg tabular-nums text-text-3">Scanning addresses {b.scan.done}/{b.scan.total}…</div>
        ) : (
          <div role="status" className="mt-3">
            <span className="sr-only">Loading total balance</span>
            <span aria-hidden="true" className="block h-12 w-48 max-w-full animate-pulse rounded-pb bg-surface-3" />
          </div>
        )}
        {(b.totalStatus === "partial" || b.totalStale) && b.totalUsd !== null && (
          <div className="mt-2 text-xs text-warn">
            {b.totalStatus === "partial" ? "Some balances couldn't be read. The total may be low." : "Showing last known balance."}
          </div>
        )}
        <p className="mt-3 text-xs leading-6 text-text-3">
          {ethEnabled ? "Estimated PRL + WPRL value in USD. ETH for network fees is shown separately." : "Estimated PRL value in USD."}
        </p>

        <div className="mt-6 divide-y divide-line border-y border-line">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4 py-4">
            <div>
              <h2 className="text-sm font-semibold">PRL</h2>
              <p className="mt-1 text-xs text-text-3">Pearl</p>
            </div>
            <div className="min-w-0 text-right">
              <div className="break-words text-xl font-medium tabular-nums">
                {b.prl.value !== null ? formatGrains(b.prl.value) : b.prl.status === "error" ? "Unavailable" : b.prl.status === "loading" ? (
                  <span role="status" className="block">
                    <span className="sr-only">Loading PRL balance</span>
                    <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse rounded-pb bg-surface-3" />
                  </span>
                ) : "—"}
              </div>
              <div className="mt-1 text-xs text-text-3">{usdOf(b.prl.value)}</div>
              {b.prl.status === "partial" && (
                <div className="mt-1 text-xs text-warn">Partial. Some addresses couldn't be read.</div>
              )}
              {b.prl.status === "error" && (
                <div className="mt-1 text-xs text-danger">Pearl balance could not be fetched.</div>
              )}
            </div>
          </div>
          {ethEnabled && (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4 py-4">
                <div>
                  <h2 className="text-sm font-semibold">WPRL</h2>
                  <p className="mt-1 text-xs text-text-3">Ethereum</p>
                </div>
                <div className="min-w-0 text-right">
                  <div className="break-words text-xl font-medium tabular-nums">
                    {b.wprl?.value != null ? formatWprl(b.wprl.value) : b.wprl?.status === "error" ? "Unavailable" : b.wprl?.status === "loading" ? (
                      <span role="status" className="block">
                        <span className="sr-only">Loading WPRL balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse rounded-pb bg-surface-3" />
                      </span>
                    ) : "—"}
                  </div>
                  <div className="mt-1 text-xs text-text-3">{usdOf(b.wprl?.value ?? null)}</div>
                  {b.wprl?.status === "error" && (
                    <div className="mt-1 text-xs text-danger">Ethereum balance could not be fetched.</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4 py-4">
                <div>
                  <h2 className="text-sm font-semibold">ETH</h2>
                  <p className="mt-1 text-xs text-text-3">Network fees</p>
                </div>
                <div className="min-w-0 text-right">
                  <div className="break-words text-xl font-medium tabular-nums">
                    {b.eth?.value != null ? formatWei(b.eth.value) : b.eth?.status === "error" ? "Unavailable" : b.eth?.status === "loading" ? (
                      <span role="status" className="block">
                        <span className="sr-only">Loading ETH balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse rounded-pb bg-surface-3" />
                      </span>
                    ) : "—"}
                  </div>
                  {b.eth?.status === "error" && (
                    <div className="mt-1 text-xs text-danger">Ethereum balance could not be fetched.</div>
                  )}
                  {b.wprl?.value != null && b.wprl.value > 0n && b.eth?.value === 0n && b.eth.status === "ok" && !b.eth.stale && (
                    <div className="mt-1 text-xs text-warn">Add ETH to cover WPRL network fees.</div>
                  )}
                </div>
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
        <div className="mt-2 text-center">
          <Link to="/consolidate" className="inline-flex min-h-11 items-center text-sm text-accent underline decoration-line underline-offset-4 hover:decoration-accent">
            Combine small coins
          </Link>
        </div>
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
              Offline signing <span className="text-xs text-warn">(experimental)</span>
            </Link>
          </div>
        )}
      </div>

      <div className="mt-8 border-t border-heading pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your addresses</h2>
          <Link to="/receive" className="inline-flex min-h-11 items-center text-sm text-accent underline decoration-line underline-offset-4 hover:decoration-accent">View QR</Link>
        </div>
        <div className="mt-3 space-y-3 text-sm">
          <CopyAddress label="Pearl L1" value={addresses?.pearl ?? "—"} />
          {ethEnabled && (
            <CopyAddress label="Ethereum (WPRL + ETH)" value={addresses?.eth ?? "—"} />
          )}
        </div>
      </div>

      {btxOn && <BtxCard />}

      <div className="mt-8 border-t border-heading pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent activity</h2>
          <Link to="/history" className="inline-flex min-h-11 items-center text-sm text-accent underline decoration-line underline-offset-4 hover:decoration-accent">See all</Link>
        </div>
        {/* Start the activity scan once the first PRL scan has settled so
            it doesn't compete with the balance scan for the RPC budget. */}
        <ActivityList limit={5} truncate enabled={b.prl.status !== "loading"} />
      </div>

      <div className="mt-4 text-center text-xs text-text-3">
        <Link to="/about" className="inline-flex min-h-11 items-center hover:underline">About this wallet</Link>
      </div>
    </Page>
  );
}
