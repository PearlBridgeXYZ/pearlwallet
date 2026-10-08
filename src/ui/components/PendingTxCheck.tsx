// Per-transaction status check for a pending (or status-unknown) Pearl
// broadcast. Coins of such a transaction are reserved (services/
// pending-spends.ts) so no other send or consolidation spends them twice.
// The reservation is released only for THIS transaction, and only after
// the node says it does not hold it — never as a blanket "forget all".

import { useState } from "react";
import { probePearlTx, type PearlTxProbe } from "../../services/pearl-rpc";
import { forgetPendingTransaction } from "../../services/pending-spends";

type CheckState = { state: "idle" } | { state: "checking" } | { state: "done"; result: PearlTxProbe };

export default function PendingTxCheck({
  txid,
  explorerUrl,
  onFound,
  onReleased,
}: {
  /** Spending txid, or null when it is unknown. */
  txid: string | null;
  explorerUrl?: string;
  /** The node holds the transaction (pending or confirmed). */
  onFound?: () => void;
  /** The coins of this transaction were released. */
  onReleased?: () => void;
}) {
  const [check, setCheck] = useState<CheckState>({ state: "idle" });
  const [confirmUnknown, setConfirmUnknown] = useState(false);

  async function runCheck() {
    setCheck({ state: "checking" });
    let result: PearlTxProbe;
    try {
      result = await probePearlTx(txid);
    } catch {
      result = "unknown";
    }
    setCheck({ state: "done", result });
    if (result === "found") onFound?.();
  }

  function release() {
    forgetPendingTransaction(txid);
    onReleased?.();
  }

  const result = check.state === "done" ? check.result : null;
  return (
    <div className="text-xs leading-6">
      {txid ? (
        <div className="break-all font-mono tabular-nums">{txid}</div>
      ) : (
        <div>Transaction id unknown.</div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-4">
        {txid && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center underline underline-offset-4"
            disabled={check.state === "checking"}
            onClick={() => void runCheck()}
          >
            {check.state === "checking" ? "Checking…" : "Check status"}
          </button>
        )}
        {txid && explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center text-accent underline underline-offset-4"
          >
            View on explorer →
          </a>
        )}
      </div>
      {result === "found" && (
        <p role="status">The network has this transaction (pending or confirmed). Its coins stay reserved.</p>
      )}
      {result === "unknown" && <p role="status">Couldn't check right now. Try again in a moment.</p>}
      {result === "absent" && (
        <p role="status">
          The node doesn't have this transaction. If the explorer agrees, it failed or was dropped and its coins can be
          used again.{" "}
          <button type="button" className="inline-flex min-h-11 items-center underline underline-offset-4" onClick={release}>
            Release its coins
          </button>
        </p>
      )}
      {!txid && (
        <label className="mt-1 flex items-start gap-2">
          <input type="checkbox" className="mt-2" checked={confirmUnknown} onChange={(e) => setConfirmUnknown(e.target.checked)} />
          <span>
            I checked that this transaction failed.{" "}
            <button
              type="button"
              className="inline-flex min-h-11 items-center underline underline-offset-4 disabled:opacity-50"
              disabled={!confirmUnknown}
              onClick={release}
            >
              Release its coins
            </button>
          </span>
        </label>
      )}
    </div>
  );
}
