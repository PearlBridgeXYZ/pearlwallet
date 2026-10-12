import { Link } from "react-router-dom";
import Page from "../components/Page";
import InstallPWA from "../components/InstallPWA";
import BtxCard from "../components/BtxCard";
import UpdatedAgo from "../components/UpdatedAgo";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { btxSurfaceOn } from "../../lib/features";
import { prlIncompleteNote, useWalletBalances } from "../hooks/useWalletBalances";
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
  const pearlDiscoveryHandler = useWallet((s) => s.pearlDiscoveryHandler);
  const b = useWalletBalances({
    pool,
    changePool: addresses?.pearlChange,
    deriveMore: derivePearlAddresses,
    bindOnDiscovered: pearlDiscoveryHandler,
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
      <div className="dashboard-balance">
        {b.totalUsd !== null ? (
          <div className="dashboard-total break-words font-mono tabular-nums">{formatUSD(b.totalUsd)}</div>
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
            {b.totalStatus === "partial" ? "Some balances couldn't be read completely. The total is an estimate and may be higher or lower." : "Showing last known balance."}
          </div>
        )}
        <UpdatedAgo at={b.prl.updatedAt} />
        <div className="dashboard-assets">
          <div className="dashboard-asset">
            <h2>PRL</h2>
            <div className="dashboard-asset-detail">
              <div className="dashboard-amount">
                {b.prl.value !== null ? <span className="font-mono tabular-nums">{formatGrains(b.prl.value)}</span> : b.prl.status === "error" ? "Unavailable" : b.prl.status === "loading" ? (
                  <span role="status" className="block">
                    <span className="sr-only">Loading PRL balance</span>
                    <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse motion-reduce:animate-none rounded-pb bg-surface-3" />
                  </span>
                ) : "—"}
              </div>
              <div className="dashboard-valuation">{usdOf(b.prl.value)}</div>
              {(b.prl.status === "partial" || b.prl.stale) && (
                <div className="mt-1 text-xs text-warn">
                  {prlIncompleteNote(b.prl)}{" "}
                  <button
                    type="button"
                    onClick={() => b.refetch()}
                    disabled={b.scan.running}
                    className="inline-flex min-h-11 min-w-11 items-center underline decoration-line underline-offset-4 hover:decoration-accent"
                  >
                    Rescan
                  </button>
                </div>
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
              <div className="dashboard-asset">
                <h2>WPRL</h2>
                <div className="dashboard-asset-detail">
                  <div className="dashboard-amount">
                    {b.wprl?.value != null ? <span className="font-mono tabular-nums">{formatWprl(b.wprl.value)}</span> : b.wprl?.status === "error" ? "Unavailable" : b.wprl?.status === "loading" ? (
                      <span role="status" className="block">
                        <span className="sr-only">Loading WPRL balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse motion-reduce:animate-none rounded-pb bg-surface-3" />
                      </span>
                    ) : "—"}
                  </div>
                  <div className="dashboard-valuation">{usdOf(b.wprl?.value ?? null)}</div>
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
              <div className="dashboard-asset">
                <h2>ETH</h2>
                <div className="dashboard-asset-detail">
                  <div className="dashboard-amount">
                    {b.eth?.value != null ? <span className="font-mono tabular-nums">{formatWei(b.eth.value)}</span> : b.eth?.status === "error" ? "Unavailable" : b.eth?.status === "loading" ? (
                      <span role="status" className="block">
                        <span className="sr-only">Loading ETH balance</span>
                        <span aria-hidden="true" className="ml-auto block h-6 w-28 max-w-full animate-pulse motion-reduce:animate-none rounded-pb bg-surface-3" />
                      </span>
                    ) : "—"}
                  </div>
                  <div className="dashboard-valuation">network fees</div>
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

        <div className="dashboard-actions">
          {ethEnabled ? (
            <details className="dashboard-send">
              <summary className="bracket-button" aria-label="Send">[ SEND ]</summary>
              <nav className="dashboard-send-options" aria-label="Send an asset">
                <Link to="/send/prl">Send PRL</Link>
                <Link to="/send/wprl">Send WPRL</Link>
                <Link to="/send/eth">Send ETH</Link>
              </nav>
            </details>
          ) : (
            <Link to="/send/prl" className="bracket-button" aria-label="Send PRL">[ SEND ]</Link>
          )}
          <Link to="/receive" className="bracket-button" aria-label="Receive">[ RECEIVE ]</Link>
          {ethEnabled && <Link to="/bridge" className="bracket-button" aria-label="Bridge">[ BRIDGE ]</Link>}
        </div>
        {/* Always offered; Send surfaces this when its input limit is reached. */}
        <div className="dashboard-tools">
          <Link to="/consolidate">Combine small coins</Link>
          {multisigEnabled && <Link to="/vaults">Vaults</Link>}
          {offlineSigningEnabled && (
            <Link to="/offline-sign">Offline signing <span className="text-warn">(experimental)</span></Link>
          )}
          <Link to="/history">Activity</Link>
        </div>
      </div>

      {btxOn && <BtxCard />}
    </Page>
  );
}
