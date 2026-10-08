// Banner for broadcasts whose outcome is still open ("status unknown", or
// coins recorded without a txid). Shown on the Send compose screen and the
// dashboard so leaving the Send result screen never hides an unresolved
// payment: its coins stay reserved and each entry can be checked (and, if
// the network really doesn't have it, released) right here.

import { pearlTxExplorerUrl, type PearlNetwork } from "../../chains/pearl/network";
import { formatGrains } from "../../lib/format";
import { unresolvedPendingTransactions } from "../../services/pending-spends";
import { usePendingSpendsVersion } from "../hooks/usePendingSpends";
import PendingTxCheck from "./PendingTxCheck";

function shortAddr(a: string): string {
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}

export default function PendingBroadcasts({ network, className = "" }: { network: PearlNetwork; className?: string }) {
  usePendingSpendsVersion();
  const open = unresolvedPendingTransactions();
  if (open.length === 0) return null;
  return (
    <section
      aria-label="Unconfirmed broadcasts"
      className={`rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn ${className}`}
    >
      <h2 className="text-base font-semibold">
        {open.length === 1 ? "A broadcast needs checking" : `${open.length} broadcasts need checking`}
      </h2>
      <p className="mt-1">
        The network didn't confirm receipt. {open.length === 1 ? "It" : "Each"} may already be on its way, so its
        coins stay reserved. Check the status before paying the same address again.
      </p>
      <ul className="mt-2 space-y-3">
        {open.map((t) => (
          <li key={t.spentBy ?? "unknown"} className="min-w-0 border-t border-warn-line pt-2">
            {t.intent?.destination && (
              <div className="break-words">
                {t.intent.amountGrains !== null && (
                  <span className="font-mono tabular-nums">{formatGrains(BigInt(t.intent.amountGrains))} PRL</span>
                )}{" "}
                to <span className="break-all font-mono">{shortAddr(t.intent.destination)}</span>
              </div>
            )}
            <div>
              {t.coins} coin{t.coins === 1 ? "" : "s"} reserved
            </div>
            <PendingTxCheck txid={t.spentBy} explorerUrl={t.spentBy ? pearlTxExplorerUrl(network, t.spentBy) : undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}
