import { Link } from "react-router-dom";
import Page from "../components/Page";
import ActivityList from "../components/ActivityList";
import CopyAddress from "../components/CopyAddress";
import InstallPWA from "../components/InstallPWA";
import BtxCard from "../components/BtxCard";
import UpdatedAgo from "../components/UpdatedAgo";
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
          <div className="mt-3 break-words font-mono text-[38px] font-semibold leading-none tracking-[-.5px] tabular-nums sm:text-5xl">{formatUSD(b.totalUsd)}</div>
        ) : b.prl.value !== null && b.price.status === "error" ? (
          <div className="mt-3 text-lg text-text-3">— <span className="text-sm">price unavailable</span></div>
        ) : b.prl.status === "error" && !b.scan.running ? (
          <div className="mt-3 text-lg text-text-3">— <span className="text-sm">balance unavailable. Retrying shortly.</span></div>
        ) : b.scan.running && b.scan.total > 0 ? (
          <div role="status" className="mt-3">
            <div className="text-lg tabular-nums text-text-3">Scanning addresses {b.scan.done} / {b.scan.total}</div>
            <div aria-hidden="true" className="mt-2 h-1 w-full max-w-xs overflow-hidden bg-surface-3">
              <div className="h-full bg-accent-bg transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.min(100, Math.round((b.scan.done / b.scan.total) * 100))}%` }} />
            </div>
          </div>
        ) : b.totalStatus !== "loading" ? (
          <div className="mt-3 text-lg text-text-3">— <span className="text-sm">{b.prl.value === null ? "balance unavailable" : "price unavailable"}</span></div>
        ) : (
          <div role="status" className="mt-3">
            <span className="sr-only">Loading total balance</span>
            <span aria-hidden="true" className="block h-12 w-48 max-w-full animate-pulse motion-reduce:animate-none rounded-pb bg-surface-3" />
          </div>
        )}
        {(b.totalStatus === "partial" || b.totalStale) && b.totalUsd !== null && (
          <div className="mt-2 text-xs text-warn">
            {b.totalStatus === "partial" ? "Some balances couldn't be read. The total may be low." : "Showing last known balance."}
          </div>
        )}
        <UpdatedAgo at={b.prl.updatedAt} />
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
                {b.prl.value !== null ? <span className="font-mono tabular-nums">{formatGrains(b.prl.value)}</span> : b.prl.status === "error" ? "Unavailable" : b.prl.status === "loading" ? (
                  <span role="status" className="block">
                    <span className="sr-only">Loading PRL balance</span>
                    <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse motion-reduce:animate-none rounded-pb bg-surface-3" />
                  </span>
                ) : "—"}
              </div>
              <div className="mt-1 font-mono text-xs tabular-nums text-text-3">{usdOf(b.prl.value)}</div>
              {(b.prl.status === "partial" || b.prl.stale) && (
                <div className="mt-1 text-xs text-warn">Some addresses couldn't be read — retrying.</div>
              )}
              {b.prl.value !== null && b.scan.running && b.scan.total > 0 && (
                <div role="status" className="mt-2 text-xs text-text-3">Scanning addresses {b.scan.done} / {b.scan.total}</div>
              )}
              {b.prl.status === "error" && (
                <div className="mt-1 text-xs text-danger">
                  <p>Pearl balance could not be fetched.</p>
                  <button type="button" onClick={() => b.refetch()} className="inline-flex min-h-11 min-w-11 items-center justify-end text-accent underline decoration-line underline-offset-4 hover:decoration-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">Retry</button>
                </div>
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
                    {b.wprl?.value != null ? <span className="font-mono tabular-nums">{formatWprl(b.wprl.value)}</span> : b.wprl?.status === "error" ? "Unavailable" : b.wprl?.status === "loading" ? (
                      <span role="status" className="block">
                        <span className="sr-only">Loading WPRL balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse motion-reduce:animate-none rounded-pb bg-surface-3" />
                      </span>
                    ) : "—"}
                  </div>
                  <div className="mt-1 font-mono text-xs tabular-nums text-text-3">{usdOf(b.wprl?.value ?? null)}</div>
                  {(b.wprl?.status === "partial" || b.wprl?.stale) && (
                    <div className="mt-1 text-xs text-warn">Showing last known balance — retrying.</div>
                  )}
                  {b.wprl?.status === "error" && (
                    <div className="mt-1 text-xs text-danger">
                      <p>Ethereum balance could not be fetched.</p>
                      <button type="button" onClick={() => b.refetch()} className="inline-flex min-h-11 min-w-11 items-center justify-end text-accent underline decoration-line underline-offset-4 hover:decoration-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">Retry</button>
                    </div>
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
                    {b.eth?.value != null ? <span className="font-mono tabular-nums">{formatWei(b.eth.value)}</span> : b.eth?.status === "error" ? "Unavailable" : b.eth?.status === "loading" ? (
                      <span role="status" className="block">
                        <span className="sr-only">Loading ETH balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse motion-reduce:animate-none rounded-pb bg-surface-3" />
                      </span>
                    ) : "—"}
                  </div>
                  {(b.eth?.status === "partial" || b.eth?.stale) && (
                    <div className="mt-1 text-xs text-warn">Showing last known balance — retrying.</div>
                  )}
                  {b.eth?.status === "error" && (
                    <div className="mt-1 text-xs text-danger">
                      <p>Ethereum balance could not be fetched.</p>
                      <button type="button" onClick={() => b.refetch()} className="inline-flex min-h-11 min-w-11 items-center justify-end text-accent underline decoration-line underline-offset-4 hover:decoration-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">Retry</button>
                    </div>
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
        {/* REDESIGN-NOTE: show this prominently when the hook exposes the PRL coin
            count (e.g. > 200 coins). */}
        <div className="mt-2 text-center">
          <Link to="/consolidate" className="inline-flex min-h-11 items-center text-sm text-accent underline decoration-line underline-offset-4 hover:decoration-accent">
            Combine small coins
          </Link>
          <p className="text-xs leading-6 text-text-3">Many small payments? Combine them to make sends faster and cheaper.</p>
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
