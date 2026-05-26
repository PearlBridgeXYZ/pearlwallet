import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import ActivityList from "../components/ActivityList";
import CopyAddress from "../components/CopyAddress";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { fetchBalances } from "../../services/balances";
import { formatGrains, formatWei, formatUSD } from "../../lib/format";

export default function Dashboard() {
  const addresses = useWallet((s) => s.addresses);
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const offlineSigningEnabled = useUI((s) => s.offlineSigningEnabled);

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
      + (ethEnabled ? balances.wprlUsd * Number(balances.wprl) / 1e18 : 0)
    : 0;

  return (
    <Page>
      <div className="card">
        <div className="text-xs uppercase tracking-wide text-ink-500">Total balance</div>
        {balances ? (
          <div className="mt-1 text-3xl font-semibold">{formatUSD(totalUsd)}</div>
        ) : (
          <div className="mt-1 text-sm text-ink-500">Loading, please wait a few seconds…</div>
        )}

        <div className={`mt-5 grid gap-4 ${ethEnabled ? "grid-cols-3" : "grid-cols-1"}`}>
          <div>
            <div className="text-xs text-ink-500">PRL</div>
            <div className="text-xl font-medium">
              {balances ? formatGrains(balances.prl) : "—"}
            </div>
            <div className="text-xs text-ink-500">
              {balances ? `≈ ${formatUSD(balances.prlUsd * Number(balances.prl) / 1e8)}` : ""}
            </div>
            {balances?.prlSource === "error" && (
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
                  {balances ? formatWei(balances.wprl) : "—"}
                </div>
                <div className="text-xs text-ink-500">
                  {balances ? `≈ ${formatUSD(balances.wprlUsd * Number(balances.wprl) / 1e18)}` : ""}
                </div>
                {balances?.wprlSource === "error" && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                    Eth RPC unreachable.
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-ink-500">ETH (gas)</div>
                <div className="text-xl font-medium">
                  {balances ? formatWei(balances.eth) : "—"}
                </div>
                {balances?.ethSource === "error" && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                    Eth RPC unreachable.
                  </div>
                )}
                {balances && balances.wprl > 0n && balances.eth === 0n && balances.ethSource === "live" && (
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
            <div className="mt-5 grid grid-cols-3 gap-2">
              <Link to="/send/prl" className="btn-secondary">Send PRL</Link>
              <Link to="/send/wprl" className="btn-secondary">Send WPRL</Link>
              <Link to="/send/eth" className="btn-secondary">Send ETH</Link>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Link to="/receive" className="btn-secondary">Receive</Link>
              <Link to="/bridge" className="btn-primary">Bridge</Link>
            </div>
          </>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Link to="/send/prl" className="btn-secondary">Send PRL</Link>
            <Link to="/receive" className="btn-secondary">Receive</Link>
          </div>
        )}
        {multisigEnabled && (
          <div className="mt-2">
            <Link to="/vaults" className="btn-secondary block w-full text-center">
              Vaults <span className="text-xs text-amber-700 dark:text-amber-400">(experimental)</span>
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

      <div className="card mt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <Link to="/history" className="text-xs text-pearl-700 hover:underline">See all</Link>
        </div>
        <ActivityList limit={5} truncate />
      </div>

      <div className="mt-4 text-center text-xs text-ink-400">
        <Link to="/about" className="hover:underline">About this wallet</Link>
      </div>
    </Page>
  );
}
