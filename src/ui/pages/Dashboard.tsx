import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import ActivityList from "../components/ActivityList";
import CopyAddress from "../components/CopyAddress";
import InstallPWA from "../components/InstallPWA";
import BtxCard from "../components/BtxCard";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { btxSurfaceOn } from "../../lib/features";
import { fetchBalances } from "../../services/balances";
import { formatGrains, formatWei, formatWprl, formatUSD } from "../../lib/format";

export default function Dashboard() {
  const addresses = useWallet((s) => s.addresses);
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const offlineSigningEnabled = useUI((s) => s.offlineSigningEnabled);
  const btxOn = btxSurfaceOn(useUI((s) => s.btxEnabled));

  const balancesQ = useQuery({
    queryKey: [
      "balances",
      addresses?.pearlPool?.join(",") ?? addresses?.pearl,
      addresses?.eth,
      ethEnabled,
    ],
    queryFn: () =>
      fetchBalances(addresses!.pearlPool ?? [addresses!.pearl], addresses!.eth, {
        ethEnabled,
      }),
    enabled: !!addresses,
    refetchInterval: 30_000,
  });

  const balances = balancesQ.data;
  const totalUsd = balances
    ? balances.prlUsd * Number(balances.prl) / 1e8
      + (ethEnabled ? balances.wprlUsd * Number(balances.wprl) / 1e8 : 0)
    : 0;

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
        {balances ? (
          balances.prlSource === "error" || (ethEnabled && balances.wprlSource === "error") ? (
            <div className="mt-3 text-lg text-text-3">Total unavailable</div>
          ) : (
            <div className="mt-3 break-all text-[38px] font-semibold leading-none tracking-[-.5px] tabular-nums sm:text-5xl">{formatUSD(totalUsd)}</div>
          )
        ) : balancesQ.isError ? (
          <div className="mt-3 text-sm text-danger">Balances unavailable. Please try again later.</div>
        ) : (
          <div role="status" className="mt-3">
            <span className="sr-only">Loading total balance</span>
            <span aria-hidden="true" className="block h-12 w-48 max-w-full animate-pulse rounded-pb bg-surface-3" />
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
                {balances?.prlSource === "error" || (!balances && balancesQ.isError) ? "Unavailable" : balances ? formatGrains(balances.prl) : (
                  <span role="status" className="block">
                    <span className="sr-only">Loading PRL balance</span>
                    <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse rounded-pb bg-surface-3" />
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-text-3">
                {balances && balances.prlSource !== "error" ? `≈ ${formatUSD(balances.prlUsd * Number(balances.prl) / 1e8)}` : ""}
              </div>
              {balances?.prlSource === "error" && (
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
                    {balances?.wprlSource === "error" || (!balances && balancesQ.isError) ? "Unavailable" : balances ? formatWprl(balances.wprl) : (
                      <span role="status" className="block">
                        <span className="sr-only">Loading WPRL balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse rounded-pb bg-surface-3" />
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-text-3">
                    {balances && balances.wprlSource !== "error" ? `≈ ${formatUSD(balances.wprlUsd * Number(balances.wprl) / 1e8)}` : ""}
                  </div>
                  {balances?.wprlSource === "error" && (
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
                    {balances?.ethSource === "error" || (!balances && balancesQ.isError) ? "Unavailable" : balances ? formatWei(balances.eth) : (
                      <span role="status" className="block">
                        <span className="sr-only">Loading ETH balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse rounded-pb bg-surface-3" />
                      </span>
                    )}
                  </div>
                  {balances?.ethSource === "error" && (
                    <div className="mt-1 text-xs text-danger">Ethereum balance could not be fetched.</div>
                  )}
                  {balances && balances.wprl > 0n && balances.eth === 0n && balances.ethSource === "live" && (
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
        <ActivityList limit={5} truncate />
      </div>

      <div className="mt-4 text-center text-xs text-text-3">
        <Link to="/about" className="inline-flex min-h-11 items-center hover:underline">About this wallet</Link>
      </div>
    </Page>
  );
}
