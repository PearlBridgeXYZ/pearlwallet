// The one banner for broadcasts whose fate is unknown (services/
// pending-spends.ts). Mounted by Page (the shell of every unlocked
// screen), so leaving
// the screen that broadcast never hides one. Each entry has "Check status";
// "Release" appears only after a check found the transaction absent and
// every coin it spends unspent, and needs an explicit acknowledgement (the
// release repeats that check inside the broadcast lock). It also says when
// the record itself can't be read or saved, and — in browsers without Web
// Locks — when another wallet tab blocks sending.

import { useState } from "react";
import { pearlTxExplorerUrl } from "../../chains/pearl/network";
import { formatGrains } from "../../lib/format";
import { checkBroadcast, releaseBroadcast, type BroadcastCheck } from "../../services/broadcast-status";
import {
  broadcastRecordIssue,
  BroadcastRefusedError,
  claimOnlyWalletTab,
  otherWalletTabOpen,
  resetUnreadableBroadcastRecord,
  unresolvedBroadcasts,
  type BroadcastRecord,
} from "../../services/pending-spends";
import { useWallet } from "../../state/wallet-store";
import { usePendingSpendsVersion } from "../hooks/usePendingSpends";

/** User-facing copy for a broadcast refused before anything was sent. */
export function refusalMessage(e: unknown): string | null {
  if (!(e instanceof BroadcastRefusedError)) return null;
  switch (e.reason) {
    case "unresolved":
      return "Not sent. An earlier broadcast from this wallet has an unknown status and may already have paid. Check it in the banner at the top first.";
    case "conflict":
      return "Not sent. A coin in this transaction is already being spent by another recent broadcast from this wallet.";
    case "storage":
      return "Not sent. This browser couldn't save the wallet's record of the broadcast, which the wallet needs to protect you from paying twice. Free some browser storage (or leave private browsing) and try again.";
    case "busy":
      return "Not sent. Another wallet tab is broadcasting right now. Try again when it has finished.";
    case "second-tab":
      return "Not sent. Another wallet tab is open, and this browser can't coordinate tabs. Close the other wallet tabs and try again.";
  }
}

const short = (s: string) => (s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);
const linkBtn = "inline-flex min-h-11 items-center underline underline-offset-4 disabled:opacity-50";

function describe(r: BroadcastRecord): string {
  if (r.kind === "consolidation") return "Combining coins";
  const what = r.kind === "vault" ? "Vault payment" : r.kind === "offline" ? "Offline-signed payment" : "Payment";
  const amount = r.amountGrains !== null ? ` of ${formatGrains(BigInt(r.amountGrains))} PRL` : "";
  return `${what}${amount} to ${r.destination ? short(r.destination) : "an address that wasn't recorded"}`;
}

function resolvedNote(txid: string, r: BroadcastCheck): string | null {
  if (r === "found") return `The network has ${short(txid)} (pending or confirmed). It's no longer unknown.`;
  if (r === "spent") {
    return `The network doesn't have ${short(txid)}, and a coin it spends was spent by another transaction, so it can never confirm. It was removed. Check the explorer if you're unsure which payment went through.`;
  }
  return null;
}

function Row({ rec, onResolved }: { rec: BroadcastRecord; onResolved: (text: string) => void }) {
  const network = useWallet((s) => s.pearlNetwork);
  const [result, setResult] = useState<BroadcastCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function run(release: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const r = release ? await releaseBroadcast(rec.txid) : await checkBroadcast(rec.txid);
      const done = release && r === "absent-unspent" ? `Released ${short(rec.txid)}: its coins can be spent again.` : resolvedNote(rec.txid, r);
      if (done) return onResolved(done);
      setResult(r);
      setAck(false);
      if (r === "unknown") setNote(release ? "Couldn't confirm that again, so nothing was released. Try again in a moment." : "Couldn't check right now. Try again in a moment.");
    } catch (e) {
      setNote(
        e instanceof BroadcastRefusedError && e.reason === "busy"
          ? "Another wallet tab is broadcasting right now. Try again when it has finished."
          : `Nothing was released: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="min-w-0 border-t border-warn-line pt-2 text-xs leading-6">
      <div className="text-sm">{describe(rec)}</div>
      <div className="break-all font-mono tabular-nums">{rec.txid}</div>
      <div className="flex flex-wrap items-center gap-x-4">
        <button type="button" className={linkBtn} disabled={busy} onClick={() => void run(false)}>
          {busy ? "Checking…" : "Check status"}
        </button>
        <a href={pearlTxExplorerUrl(network, rec.txid)} target="_blank" rel="noopener noreferrer" className={`${linkBtn} text-accent`}>
          View on explorer →
        </a>
      </div>
      {result === "absent-unspent" && (
        <div role="status">
          <p>
            The network doesn't have this transaction and none of its coins have moved. If it failed, releasing it makes
            its coins spendable again and lifts the hold on new payments. If a copy of it is still on its way, it could
            still arrive and pay.
          </p>
          <label className="mt-1 flex items-start gap-2">
            <input type="checkbox" className="mt-2" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I checked the explorer and it doesn't show this transaction. Release it.</span>
          </label>
          <button type="button" className={linkBtn} disabled={!ack || busy} onClick={() => void run(true)}>
            Release
          </button>
        </div>
      )}
      {note && <p role="alert">{note}</p>}
    </li>
  );
}

export default function PendingBroadcasts({ className = "" }: { className?: string }) {
  usePendingSpendsVersion();
  const [notes, setNotes] = useState<string[]>([]);
  const open = unresolvedBroadcasts();
  const issue = broadcastRecordIssue();
  const otherTab = otherWalletTabOpen();
  if (open.length === 0 && !issue && !otherTab && notes.length === 0) return null;
  return (
    <section
      aria-label="Broadcasts with unknown status"
      className={`mb-4 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn ${className}`}
    >
      {open.length > 0 && (
        <>
          <h2 className="text-base font-semibold">
            {open.length === 1 ? "A broadcast needs checking" : `${open.length} broadcasts need checking`}
          </h2>
          <p className="mt-1">
            The network didn't confirm receipt, so {open.length === 1 ? "it" : "each"} may already be on its way. Until
            it's resolved its coins stay reserved, Send asks before paying anyone, and combining coins, vault and
            offline-signed payments wait.
          </p>
          <ul className="mt-2 space-y-3">
            {open.map((r) => (
              <Row key={r.txid} rec={r} onResolved={(t) => setNotes((n) => [...n, t])} />
            ))}
          </ul>
        </>
      )}
      {notes.length > 0 && (
        <div role="status" className={open.length > 0 ? "mt-2 border-t border-warn-line pt-2" : ""}>
          {notes.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
          <button type="button" className={linkBtn} onClick={() => setNotes([])}>
            Dismiss
          </button>
        </div>
      )}
      {issue === "unreadable" && (
        <div role="alert" className="mt-2">
          <p>
            This browser's record of recent broadcasts can't be read, so sending is paused: the wallet can't tell
            whether an earlier payment is still on its way. Check your recent transactions on the explorer first.
          </p>
          <button type="button" className={linkBtn} onClick={() => void resetUnreadableBroadcastRecord().catch(() => {})}>
            I've checked. Reset the record
          </button>
        </div>
      )}
      {issue === "update-failed" && (
        <p role="alert" className="mt-2">
          The browser couldn't save the outcome of a recent broadcast, so it stays listed here until you check it.
        </p>
      )}
      {otherTab && (
        <div role="alert" className="mt-2">
          <p>
            This browser can't coordinate wallet tabs, and another wallet tab is open (or was closed unexpectedly).
            Sending works from one tab only: close the others.
          </p>
          <button type="button" className={linkBtn} onClick={claimOnlyWalletTab}>
            No other wallet tab is open
          </button>
        </div>
      )}
    </section>
  );
}
