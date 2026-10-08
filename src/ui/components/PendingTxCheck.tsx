// Per-transaction status check for a pending (or status-unknown) Pearl
// broadcast. Coins of such a transaction are reserved (services/
// pending-spends.ts) so no other send or consolidation spends them twice.
// The reservation is released only for THIS transaction, never while a
// submission of it is still in flight, and only after the node said twice
// (at least PENDING_RELEASE_RECHECK_MS apart) that it does not hold it —
// or once, plus the user's explicit "the explorer doesn't show it either".

import { useEffect, useState } from "react";
import { probePearlTx, type PearlTxProbe } from "../../services/pearl-rpc";
import {
  forgetPendingTransaction,
  manualReleaseState,
  notePendingTxProbe,
  withPendingSpendsLock,
  SubmissionInFlightError,
} from "../../services/pending-spends";
import { usePendingSpendsVersion } from "../hooks/usePendingSpends";

type CheckState = { state: "idle" } | { state: "checking" } | { state: "done"; result: PearlTxProbe };

const linkBtn = "inline-flex min-h-11 items-center underline underline-offset-4 disabled:opacity-50";

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
  usePendingSpendsVersion();
  const [check, setCheck] = useState<CheckState>({ state: "idle" });
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const [explorerAck, setExplorerAck] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseNote, setReleaseNote] = useState<{ text: string; done: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const gate = txid ? manualReleaseState(txid, explorerAck, now) : null;
  // Tick while a re-check window is counting down.
  useEffect(() => {
    if (gate?.state !== "recheck") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [gate?.state]);

  async function runCheck() {
    if (!txid) return;
    setCheck({ state: "checking" });
    let result: PearlTxProbe;
    try {
      result = await probePearlTx(txid);
    } catch {
      result = "unknown";
    }
    notePendingTxProbe(txid, result);
    setNow(Date.now());
    setCheck({ state: "done", result });
    if (result === "found") onFound?.();
  }

  async function release() {
    setReleasing(true);
    try {
      const durable = await withPendingSpendsLock(() => forgetPendingTransaction(txid));
      if (durable) {
        onReleased?.();
      } else {
        setReleaseNote({
          done: true,
          text:
            "Released in this tab, but the browser couldn't save that. After a reload, or in another open tab, these coins may show as reserved again until the reservation expires (6 hours).",
        });
      }
    } catch (e) {
      setReleaseNote({
        done: false,
        text:
          e instanceof SubmissionInFlightError
            ? "This transaction is being broadcast right now. Wait for that to finish, then check again."
            : `Couldn't release: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setReleasing(false);
    }
  }

  const result = check.state === "done" ? check.result : null;
  const inFlight = gate?.state === "in-flight";
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
            className={linkBtn}
            disabled={check.state === "checking"}
            onClick={() => void runCheck()}
          >
            {check.state === "checking" ? "Checking…" : result === "absent" ? "Check again" : "Check status"}
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
      {inFlight && <p role="status">This transaction is being broadcast right now. Its coins stay reserved.</p>}
      {result === "found" && (
        <p role="status">The network has this transaction (pending or confirmed). Its coins stay reserved.</p>
      )}
      {result === "unknown" && <p role="status">Couldn't check right now. Try again in a moment.</p>}
      {result === "absent" && !inFlight && gate && (
        <div role="status">
          <p>
            The node doesn't have this transaction. If it really failed or was dropped, its coins can be used
            again.
          </p>
          {gate.state === "recheck" && (
            <>
              <p>
                {gate.waitMs > 0 ? (
                  <>
                    To be sure, check again in{" "}
                    <span className="font-mono tabular-nums">{Math.ceil(gate.waitMs / 1000)}</span>s, or confirm on the
                    explorer.
                  </>
                ) : (
                  "To be sure, check again now, or confirm on the explorer."
                )}
              </p>
              <label className="mt-1 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-2"
                  checked={explorerAck}
                  onChange={(e) => setExplorerAck(e.target.checked)}
                />
                <span>I checked the explorer and it doesn't show this transaction either.</span>
              </label>
            </>
          )}
          {gate.state === "ready" && !releaseNote?.done && (
            <button type="button" className={linkBtn} disabled={releasing} onClick={() => void release()}>
              Release its coins
            </button>
          )}
        </div>
      )}
      {!txid && !releaseNote?.done && (
        <label className="mt-1 flex items-start gap-2">
          <input type="checkbox" className="mt-2" checked={confirmUnknown} onChange={(e) => setConfirmUnknown(e.target.checked)} />
          <span>
            I checked that this transaction failed.{" "}
            <button
              type="button"
              className={linkBtn}
              disabled={!confirmUnknown || releasing}
              onClick={() => void release()}
            >
              Release its coins
            </button>
          </span>
        </label>
      )}
      {releaseNote && (
        <p role="alert" className="mt-1 text-warn">
          {releaseNote.text}{" "}
          {releaseNote.done && (
            <button type="button" className={linkBtn} onClick={() => onReleased?.()}>
              Continue
            </button>
          )}
        </p>
      )}
    </div>
  );
}
