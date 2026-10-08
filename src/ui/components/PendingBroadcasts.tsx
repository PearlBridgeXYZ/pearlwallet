// Banner for broadcasts whose outcome is still open: in flight (in any
// tab, or interrupted by a reload), "status unknown", or coins reserved
// without a recorded destination. Shown on the Send compose screen and the
// dashboard so leaving the Send result screen never hides an unresolved
// payment: its coins stay reserved and each entry can be checked (and, if
// the network really doesn't have it, released) right here.
//
// It also carries the warning that this tab holds reservations, intents or
// releases the browser couldn't save. That warning lives here, not in the
// per-transaction row: releasing a transaction removes its row at once,
// and a "couldn't save that" note inside the row would vanish with it.

import { pearlTxExplorerUrl, type PearlNetwork } from "../../chains/pearl/network";
import { formatGrains } from "../../lib/format";
import { pendingPersistenceIssue, unresolvedPendingTransactions } from "../../services/pending-spends";
import { usePendingSpendsVersion } from "../hooks/usePendingSpends";
import PendingTxCheck from "./PendingTxCheck";

function shortAddr(a: string): string {
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}

/** "The browser couldn't save …" — rendered while any pending-spend write
 *  of this tab has not reached storage. */
export function PendingPersistenceWarning({ className = "" }: { className?: string }) {
  usePendingSpendsVersion();
  const issue = pendingPersistenceIssue();
  if (!issue) return null;
  return (
    <div role="alert" className={`text-sm leading-7 text-warn ${className}`}>
      {issue.records && (
        <p>
          This browser couldn't save the wallet's record of a recent broadcast. This tab remembers it, but after a
          reload the wallet may not show it or warn before paying the same address again — check the transaction on
          the explorer first.
        </p>
      )}
      {issue.releases && (
        <p>
          Released in this tab, but the browser couldn't save that. After a reload, or in another open tab, those
          coins may show as reserved again until the reservation expires (6 hours).
        </p>
      )}
    </div>
  );
}

export default function PendingBroadcasts({ network, className = "" }: { network: PearlNetwork; className?: string }) {
  usePendingSpendsVersion();
  const open = unresolvedPendingTransactions();
  const issue = pendingPersistenceIssue();
  if (open.length === 0 && !issue) return null;
  const allInFlight = open.length > 0 && open.every((t) => t.inFlight);
  return (
    <section
      aria-label="Unconfirmed broadcasts"
      className={`rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn ${className}`}
    >
      {open.length > 0 && (
        <>
          <h2 className="text-base font-semibold">
            {allInFlight
              ? open.length === 1
                ? "A broadcast is in progress"
                : `${open.length} broadcasts are in progress`
              : open.length === 1
                ? "A broadcast needs checking"
                : `${open.length} broadcasts need checking`}
          </h2>
          <p className="mt-1">
            {allInFlight
              ? "The network hasn't confirmed receipt yet."
              : "The network didn't confirm receipt."}{" "}
            {open.length === 1 ? "It" : "Each"} may already be on its way, so its coins stay reserved. Check the
            status before paying the same address again.
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
                {t.metadataMissing && <div>Destination not recorded.</div>}
                <div>
                  {t.coins} coin{t.coins === 1 ? "" : "s"} reserved
                  {t.inFlight ? " · broadcasting now" : ""}
                </div>
                <PendingTxCheck
                  txid={t.spentBy}
                  explorerUrl={t.spentBy ? pearlTxExplorerUrl(network, t.spentBy) : undefined}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <PendingPersistenceWarning className={open.length > 0 ? "mt-2 border-t border-warn-line pt-2" : ""} />
    </section>
  );
}
