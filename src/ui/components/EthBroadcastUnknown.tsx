// Shown when an Ethereum broadcast's outcome could not be determined
// (EthBroadcastStatusUnknownError): the network may already have the tx,
// so the page's send button stays disabled until the user says they
// checked the hash and it was not sent. Used by Send ETH, Send WPRL and
// the bridge unwrap (approve / burn). The unacknowledged record lives in
// state/eth-unknown.ts (sessionStorage, keyed by network + address), so the
// block survives the page unmounting and remounting.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ethTxExplorerUrl, type EthNetwork } from "../../chains/ethereum/network";
import {
  clearEthUnknown,
  currentEthUnknown,
  recordEthUnknown,
  subscribeEthUnknown,
} from "../../state/eth-unknown";

/** A status-unknown broadcast the user has not yet cleared. */
export interface EthUnknownState {
  hash: `0x${string}`;
  /** What was being sent, e.g. "ETH transfer", "approval", "burn". */
  what: string;
  acknowledged: boolean;
}

/** True while the page must refuse another send. */
export function ethUnknownBlocksSend(s: EthUnknownState | null): boolean {
  return s !== null && !s.acknowledged;
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
  const read = () => {
    const r = currentEthUnknown(network, from);
    return r ? `${r.hash}|${r.what}` : "";
  };
  const snap = useSyncExternalStore(subscribeEthUnknown, read, read);
  const state = useMemo<EthUnknownState | null>(() => {
    if (!snap) return null;
    const i = snap.indexOf("|");
    return { hash: snap.slice(0, i) as `0x${string}`, what: snap.slice(i + 1), acknowledged: false };
  }, [snap]);
  const set = useCallback(
    (s: EthUnknownState | null) => {
      if (!s || !from) return;
      if (s.acknowledged) clearEthUnknown(network, from, s.hash);
      else recordEthUnknown({ network, from, hash: s.hash, what: s.what });
    },
    [network, from],
  );
  return [state, set];
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
  return (
    <div role="alert" className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-3 text-sm text-warn leading-relaxed break-words">
      <p className="font-semibold">Broadcast status unknown — check the transaction first</p>
      <p className="mt-1">
        The {state.what} may already be on the network: its status could not be confirmed. Sending
        again could pay twice.
      </p>
      <p className="mt-1">
        Tx hash: <span className="break-all font-mono min-w-0 tabular-nums">{state.hash}</span>
      </p>
      <a
        href={ethTxExplorerUrl(network, state.hash)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4"
      >
        Check it on Etherscan →
      </a>
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
