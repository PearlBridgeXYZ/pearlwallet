import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { fetchBalances } from "../../services/balances";
import { formatGrains, formatWei, formatUSD, shortAddr } from "../../lib/format";

export default function Dashboard() {
  const addresses = useWallet((s) => s.addresses);

  const balancesQ = useQuery({
    queryKey: ["balances", addresses?.pearl, addresses?.eth],
    queryFn: () => fetchBalances(addresses!.pearl, addresses!.eth),
    enabled: !!addresses,
    refetchInterval: 30_000,
  });

  const balances = balancesQ.data;
  const totalUsd = balances ? balances.prlUsd * Number(balances.prl) / 1e8 + balances.wprlUsd * Number(balances.wprl) / 1e18 : 0;

  return (
    <Page>
      <div className="card">
        <div className="text-xs uppercase tracking-wide text-ink-500">Total balance</div>
        <div className="mt-1 text-3xl font-semibold">{formatUSD(totalUsd)}</div>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-ink-500">PRL</div>
            <div className="text-xl font-medium">
              {balances ? formatGrains(balances.prl) : "—"}
            </div>
            <div className="text-xs text-ink-500">
              {balances ? `≈ ${formatUSD(balances.prlUsd * Number(balances.prl) / 1e8)}` : ""}
            </div>
          </div>
          <div>
            <div className="text-xs text-ink-500">WPRL</div>
            <div className="text-xl font-medium">
              {balances ? formatWei(balances.wprl) : "—"}
            </div>
            <div className="text-xs text-ink-500">
              {balances ? `≈ ${formatUSD(balances.wprlUsd * Number(balances.wprl) / 1e18)}` : ""}
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2">
          <Link to="/send/prl" className="btn-secondary">Send</Link>
          <Link to="/receive" className="btn-secondary">Receive</Link>
          <Link to="/bridge" className="btn-primary">Bridge</Link>
        </div>
      </div>

      <div className="card mt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Your addresses</h2>
          <Link to="/receive" className="text-xs text-pearl-700 hover:underline">View QR</Link>
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs text-ink-500">Pearl L1</dt>
            <dd className="break-all font-mono">{addresses ? shortAddr(addresses.pearl, 12, 8) : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Ethereum (WPRL)</dt>
            <dd className="break-all font-mono">{addresses ? shortAddr(addresses.eth, 8, 6) : "—"}</dd>
          </div>
        </dl>
      </div>

      <div className="card mt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <Link to="/history" className="text-xs text-pearl-700 hover:underline">See all</Link>
        </div>
        <p className="mt-3 text-sm text-ink-500">No activity yet.</p>
      </div>

      <div className="mt-4 text-center text-xs text-ink-400">
        <Link to="/about" className="hover:underline">About this wallet</Link>
      </div>
    </Page>
  );
}
