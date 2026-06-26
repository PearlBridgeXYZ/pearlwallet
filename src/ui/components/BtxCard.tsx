import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import CopyAddress from "./CopyAddress";
import { cryptoWorker } from "../../crypto/worker-client";
import { fetchBtxBalance } from "../../services/btx-indexer";
import { formatGrains } from "../../lib/format";

/**
 * BTX (post-quantum) surface — balance + receive address. Additive to the
 * PRL/WPRL/ETH dashboard; rendered only when ui.btxEnabled.
 *
 * The receive address is derived in the crypto worker (ML-DSA + SLH-DSA keygen,
 * ~1.8s, cached on the session). The balance comes from the BTX indexer edge.
 * BTX is pre-production with no market price, so we show the BTX amount only
 * (no USD), and surface read errors rather than a stale/fabricated number.
 */
export default function BtxCard() {
  const addrQ = useQuery({
    queryKey: ["btxAddress"],
    queryFn: () => cryptoWorker.call<"deriveBtx", { btx: string }>("deriveBtx", {}),
    staleTime: Infinity,
  });
  const address = addrQ.data?.btx;

  const balQ = useQuery({
    queryKey: ["btxBalance", address],
    queryFn: () => fetchBtxBalance(address!),
    enabled: !!address,
    refetchInterval: 30_000,
    retry: 1,
  });

  return (
    <div className="card mt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          BTX <span className="text-xs font-normal text-amber-700 dark:text-amber-400">(beta · post-quantum)</span>
        </h2>
        <Link to="/receive" className="text-xs text-pearl-700 hover:underline">View QR</Link>
      </div>

      <div className="mt-3">
        <div className="text-xs text-ink-500">Balance</div>
        <div className="text-xl font-medium">
          {balQ.data ? `${formatGrains(balQ.data.confirmedSat)} BTX` : addrQ.isLoading ? "deriving…" : balQ.isLoading ? "—" : "—"}
        </div>
        {balQ.isError && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">BTX indexer unreachable.</div>
        )}
        {balQ.data && balQ.data.utxoCount > 0 && (
          <div className="text-xs text-ink-500">{balQ.data.utxoCount} UTXO{balQ.data.utxoCount === 1 ? "" : "s"}</div>
        )}
      </div>

      <div className="mt-3">
        <CopyAddress label="BTX receive" value={address ?? "—"} />
      </div>

      <div className="mt-3">
        <Link to="/send/btx" className="btn-secondary tap block w-full text-center">Send BTX</Link>
      </div>
    </div>
  );
}
