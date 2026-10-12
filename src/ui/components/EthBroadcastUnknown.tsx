// Shown when an Ethereum broadcast's outcome could not be determined
// (EthBroadcastStatusUnknownError): the network may already have the tx,
// so the page's send button stays disabled until the user says they
// checked the hash and it was not sent. Used by Send ETH, Send WPRL and
// the bridge unwrap (approve / burn). The unacknowledged record lives in
// state/eth-unknown.ts (localStorage, keyed by network + address, plus a
// durable IndexedDB copy; either one unresolved blocks), so the block holds
// in every tab, across remounts, reloads, browser restarts and a browser
// crash right after submission. A record that could not be read has its
// own copy (ethUnknownCopy), with no zero hash or Etherscan link.
// On mount each unresolved hash is looked up once; one the network has is
// shown as sent and stops blocking.
//
// A record saved just before submission (in flight) is not shown as status
// unknown while its send may still be running: the sending tab shows
// nothing extra, other tabs a neutral "sending from another tab" note with
// nothing to acknowledge. The send stays blocked meanwhile. Once its
// sender is gone (the tab closed mid-send: the address's broadcast lock is
// free) it is shown, and acknowledged, as status unknown.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ethTxExplorerUrl, type EthNetwork } from "../../chains/ethereum/network";
import {
  acknowledgeEthUnknownChecked,
  clearEthUnknown,
  currentEthUnknown,
  ETH_UNKNOWN_ZERO_HASH,
  ethInflightSenderActive,
  isOwnInflight,
  isUnreadableEthUnknown,
  recordEthUnknown,
  subscribeEthUnknown,
} from "../../state/eth-unknown";
import { probeEthUnknownRecords, SigningSessionChangedError } from "../../services/eth-tx";
import { SESSION_CHANGED_MESSAGE } from "../../state/wallet-store";
import { BroadcastRefusedError } from "../../services/broadcast-lock";

/** A status-unknown broadcast the user has not yet cleared. */
export interface EthUnknownState {
  hash: `0x${string}`;
  /** What was being sent, e.g. "ETH transfer", "approval", "burn". */
  what: string;
  acknowledged: boolean;
  /** A later lookup found it on the network: it was sent (no block). */
  sent?: boolean;
  /** Saved before submission and its send may still be running, in this
   *  tab or another one: not status-unknown, and not acknowledgeable. */
  sending?: "this-tab" | "other-tab";
}

/** How often a page re-checks whether another tab's in-flight send is
 *  still running (its tab may close without a storage event). */
export const ETH_INFLIGHT_RECHECK_MS = 1000;

/** True while the page must refuse another send. */
export function ethUnknownBlocksSend(s: EthUnknownState | null): boolean {
  return s !== null && !s.acknowledged && !s.sent;
}

/**
 * The unacknowledged status-unknown broadcast for this network + address,
 * and a setter: a state with `acknowledged: false` records it, one with
 * `acknowledged: true` clears that hash ("I checked; it was not sent").
 * `null` changes nothing — only an acknowledgement clears a record.
 */
export function useEthUnknown(
  network: EthNetwork,
  from: string | undefined,
): [EthUnknownState | null, (s: EthUnknownState | null) => void] {
  // Flag: "1" sent, "0" status unknown, "m" in flight from this tab's
  // running send, "i" in flight from another (or an ended) send.
  const read = () => {
    const r = currentEthUnknown(network, from);
    if (!r) return "";
    const flag = r.sent ? "1" : !r.inflight ? "0" : isOwnInflight(r) ? "m" : "i";
    return `${r.hash}|${flag}|${r.what}`;
  };
  const snap = useSyncExternalStore(subscribeEthUnknown, read, read);
  // In-flight hashes whose sender was found gone: from then on they are
  // status unknown (a sender that is gone does not come back).
  const [senderGone, setSenderGone] = useState<ReadonlySet<string>>(() => new Set());
  const state = useMemo<EthUnknownState | null>(() => {
    if (!snap) return null;
    const [hash, flag] = snap.split("|", 2) as [string, string];
    const what = snap.slice(hash.length + flag.length + 2);
    const s: EthUnknownState = { hash: hash as `0x${string}`, what, acknowledged: false, sent: flag === "1" };
    if (flag === "m") s.sending = "this-tab";
    else if (flag === "i" && !senderGone.has(hash.toLowerCase())) s.sending = "other-tab";
    return s;
  }, [snap, senderGone]);
  // Another tab's in-flight record: check (and keep re-checking) whether
  // its send is still running. Until the first answer it counts as
  // running (nothing to acknowledge).
  const inflightHash = snap && snap.split("|", 2)[1] === "i" ? snap.split("|", 1)[0]!.toLowerCase() : null;
  useEffect(() => {
    if (!inflightHash || senderGone.has(inflightHash)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const r = currentEthUnknown(network, from);
      if (stopped || !r || r.hash.toLowerCase() !== inflightHash || !r.inflight || r.sent) return;
      const active = await ethInflightSenderActive(r);
      if (stopped) return;
      if (!active) setSenderGone((prev) => new Set(prev).add(inflightHash));
      else timer = setTimeout(() => void check(), ETH_INFLIGHT_RECHECK_MS);
    };
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [network, from, inflightHash, senderGone]);
  // Once per mount: look each unresolved hash up; found → "it was sent".
  useEffect(() => {
    void probeEthUnknownRecords(network, from);
  }, [network, from]);
  const set = useCallback(
    (s: EthUnknownState | null) => {
      if (!s || !from) return;
      // A record found sent is dismissed as is; "I checked; it was not
      // sent" clears an in-flight record only once its sender is gone.
      if (s.acknowledged && s.sent) void clearEthUnknown(network, from, s.hash);
      else if (s.acknowledged) void acknowledgeEthUnknownChecked(network, from, s.hash);
      else void recordEthUnknown({ network, from, hash: s.hash, what: s.what });
    },
    [network, from],
  );
  return [state, set];
}

/** Shown for a saved send record that could not be read (it still blocks
 *  this address until acknowledged): there is no trustworthy hash to show. */
export const ETH_UNREADABLE_RECORD_COPY =
  "A saved send record from this address could not be read. Check your recent transactions before sending again.";

/** What the status-unknown card shows for `state`: a heading, the body,
 *  and the hash with its explorer link (both null for an unreadable record
 *  without a usable hash: the zero hash is never shown or linked). */
export function ethUnknownCopy(
  network: EthNetwork,
  state: { hash: string; what: string },
): { title: string; body: string; hash: string | null; explorerUrl: string | null } {
  const hasHash = state.hash.toLowerCase() !== ETH_UNKNOWN_ZERO_HASH;
  const hash = hasHash ? state.hash : null;
  const explorerUrl = hasHash ? ethTxExplorerUrl(network, state.hash) : null;
  if (isUnreadableEthUnknown(state)) {
    return { title: "A saved send record could not be read", body: ETH_UNREADABLE_RECORD_COPY, hash, explorerUrl };
  }
  return {
    title: "Broadcast status unknown — check the transaction first",
    body: `The ${state.what} may already be on the network: its status could not be confirmed. Sending again could pay twice.`,
    hash,
    explorerUrl,
  };
}

/** The signing service refused: an unresolved record blocks this address.
 *  `what` (EthUnresolvedBroadcastError.what) selects the unreadable-record
 *  copy, which names no zero hash and links nothing. */
export function ethUnresolvedMessage(network: EthNetwork, hash: string, what?: string): string {
  if (what !== undefined && isUnreadableEthUnknown({ what })) {
    const c = ethUnknownCopy(network, { hash, what });
    return `Nothing was signed: ${c.body}${c.hash ? ` Record hash ${c.hash} (Etherscan: ${c.explorerUrl}).` : ""} Then confirm below.`;
  }
  return `Nothing was signed: an earlier transaction from this address (${hash}) may already be on the network. Check it on Etherscan (${ethTxExplorerUrl(network, hash)}) and confirm below before sending again.`;
}

/** The signing service refused before signing or sending (another tab is
 *  sending from this address, a second tab without Web Locks, the record
 *  could not be saved, or the wallet was locked after the send was
 *  confirmed); null for any other error. */
export function ethRefusalMessage(e: unknown): string | null {
  if (e instanceof SigningSessionChangedError) return SESSION_CHANGED_MESSAGE;
  if (e instanceof Error && e.message.startsWith("E_SIGN_TIMEOUT")) {
    return "Nothing was sent: signing didn't finish in time. Reload the page and try again.";
  }
  if (!(e instanceof BroadcastRefusedError)) return null;
  if (e.reason === "busy") return "Nothing was sent: another wallet tab is sending from this address. Wait for it to finish, then try again.";
  if (e.reason === "second-tab") return "Nothing was sent: another wallet tab is open. Close other wallet tabs, then try again.";
  if (e.reason === "storage") return "Nothing was sent: this browser would not let the wallet save the transaction before sending it. Check that site storage is allowed, then try again.";
  return `Nothing was sent: ${e.message}`;
}

/** Plain-text message (also used where only an error string is shown). */
export function ethUnknownMessage(network: EthNetwork, hash: string, what: string): string {
  return `The ${what} may already be on the network: its status could not be confirmed. Tx hash ${hash} — check it on Etherscan (${ethTxExplorerUrl(network, hash)}) before trying again. Sending again could pay twice.`;
}

export default function EthBroadcastUnknown(props: {
  network: EthNetwork;
  state: EthUnknownState;
  onAcknowledge: (acknowledged: boolean) => void;
}) {
  const { network, state, onAcknowledge } = props;
  // This tab's own send: its page already shows that it is sending.
  if (state.sending === "this-tab") return null;
  if (state.sending === "other-tab") {
    return (
      <div role="status" className="mt-3 rounded-pb border border-line bg-surface-2 p-3 text-sm leading-relaxed break-words">
        <p className="font-semibold">Sending from another tab</p>
        <p className="mt-1">
          Another wallet tab is sending {articleFor(state.what)} {state.what} from this address. Wait for it to
          finish before sending again.
        </p>
      </div>
    );
  }
  if (state.sent) {
    return (
      <div role="status" className="mt-3 rounded-pb border border-line bg-surface-2 p-3 text-sm leading-relaxed break-words">
        <p className="font-semibold">Your earlier {state.what} was sent</p>
        <p className="mt-1">
          It was found on the network, so you can send again. Tx hash:{" "}
          <span className="break-all font-mono min-w-0 tabular-nums">{state.hash}</span>
        </p>
        <a
          href={ethTxExplorerUrl(network, state.hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4"
        >
          View it on Etherscan →
        </a>
        <button type="button" className="mt-2 ml-4 inline-flex min-h-11 items-center underline underline-offset-4" onClick={() => onAcknowledge(true)}>
          Dismiss
        </button>
      </div>
    );
  }
  const copy = ethUnknownCopy(network, state);
  return (
    <div role="alert" className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-3 text-sm text-warn leading-relaxed break-words">
      <p className="font-semibold">{copy.title}</p>
      <p className="mt-1">{copy.body}</p>
      {copy.hash && copy.explorerUrl && (
        <>
          <p className="mt-1">
            Tx hash: <span className="break-all font-mono min-w-0 tabular-nums">{copy.hash}</span>
          </p>
          <a
            href={copy.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Check it on Etherscan →
          </a>
        </>
      )}
      <label className="mt-2 flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={state.acknowledged}
          onChange={(e) => onAcknowledge(e.target.checked)}
        />
        <span>I checked; it was not sent</span>
      </label>
    </div>
  );
}

function articleFor(what: string): string {
  return /^[aeiou]/i.test(what) ? "an" : "a";
}
