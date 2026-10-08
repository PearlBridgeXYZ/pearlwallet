// Renders an ActivityResult as a list of in/out items with explorer
// links. Used by Dashboard (top 5) and History (full).

import { useQuery } from "@tanstack/react-query";
import { useWallet } from "../../state/wallet-store";
import { fetchActivity, type ActivityItem } from "../../services/activity";
import { formatGrains, formatWprl } from "../../lib/format";
import { pearlTxExplorerUrl } from "../../chains/pearl/network";
import { ethTxExplorerUrl } from "../../chains/ethereum/network";

interface Props {
  limit?: number;
  /** When true, only show the top `limit` items. Used by Dashboard. */
  truncate?: boolean;
  /** Optional filter: "all" | "prl" | "wprl". */
  filter?: "all" | "prl" | "wprl";
  /** Defer the scan (Dashboard holds it until the first balance scan
   *  settles so the two don't compete for the RPC budget). */
  enabled?: boolean;
}

export default function ActivityList({ limit = 25, truncate = false, filter = "all", enabled = true }: Props) {
  const addresses = useWallet((s) => s.addresses);
  const ethNetwork = useWallet((s) => s.ethNetwork);

  // Both single-sig branches: without the change branch a send would be
  // shown as spending its change too.
  const pearlAll = addresses
    ? [...(addresses.pearlPool ?? [addresses.pearl]), ...(addresses.pearlChange ?? [])]
    : [];

  const activityQ = useQuery({
    queryKey: [
      "activity",
      pearlAll.join(","),
      addresses?.eth,
      ethNetwork,
      limit,
    ],
    queryFn: () =>
      fetchActivity(
        pearlAll,
        addresses!.eth as `0x${string}`,
        ethNetwork,
        limit,
      ),
    enabled: !!addresses && enabled,
    // Activity is more expensive than balances (pool walk + getLogs).
    // Refetch every 90s — fast enough to catch a fresh receive, slow
    // enough not to hammer the public sentry / public Eth RPC.
    refetchInterval: 90_000,
    staleTime: 60_000,
  });

  if (!addresses) return null;

  if (activityQ.isLoading || (!enabled && !activityQ.data)) {
    return <p role="status" className="border-b border-line py-5 text-sm text-text-3">Scanning Pearl + Eth for recent activity…</p>;
  }

  if (activityQ.isError) {
    return (
      <p role="status" className="mt-3 rounded-pb border border-danger-line bg-danger-bg p-3 text-sm text-danger">
        Couldn't scan for activity. Try again in a moment.
      </p>
    );
  }

  const data = activityQ.data;
  if (!data) return null;

  let items = data.items;
  if (filter === "prl") items = items.filter((i) => i.chain === "pearl");
  else if (filter === "wprl") items = items.filter((i) => i.chain === "wprl");

  if (truncate) items = items.slice(0, limit);

  // Source warnings. Surface partial/error so the user knows the list
  // is incomplete rather than empty-by-fact.
  const warnings: string[] = [];
  if (data.pearlSource === "partial") {
    warnings.push("Pearl scan partial — sentry errors on some addresses.");
  } else if (data.pearlSource === "error") {
    warnings.push("Pearl scan failed — sentry unreachable.");
  }
  if (data.wprlSource === "error") {
    warnings.push("WPRL scan failed — Ethereum RPC unreachable.");
  }

  return (
    <div>
      {warnings.map((w) => (
        <p key={w} className="mt-2 rounded-pb border border-warn-line bg-warn-bg p-3 text-xs leading-relaxed text-warn">{w}</p>
      ))}
      {items.length === 0 ? (
        <p role="status" className="border-b border-line py-5 text-sm text-text-3">
          {data.pearlSource === "live" && data.wprlSource === "live"
            ? "No activity yet."
            : "No activity found in the scanned window."}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {items.map((it) => (
            <ActivityRow key={`${it.chain}:${it.txid}`} item={it} ethNetwork={ethNetwork} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityRow({ item, ethNetwork }: { item: ActivityItem; ethNetwork: "mainnet" | "sepolia" }) {
  const isOut = item.direction === "out";
  const sign = isOut ? "−" : "+";
  const amountStr = item.chain === "pearl"
    ? `${formatGrains(item.amount)} PRL`
    : `${formatWprl(item.amount)} WPRL`;
  const url = item.chain === "pearl"
    ? pearlTxExplorerUrl("mainnet", item.txid)
    : ethTxExplorerUrl(ethNetwork, item.txid);
  const chainLabel = item.chain === "pearl" ? "Pearl" : "Eth";

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-4 text-sm">
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex items-center gap-2">
          <span
            className={
              isOut
                ? "text-xs font-semibold text-text-2"
                : "text-xs font-semibold text-ok"
            }
          >
            {isOut ? "Sent" : "Received"}
          </span>
          <span className="text-xs text-text-3">{chainLabel}</span>
        </div>
        <div className="mt-1 break-all text-base font-semibold tabular-nums">
          <span className={isOut ? "text-text" : "text-ok"}>
            {sign} {amountStr}
          </span>
        </div>
        {item.counterparty && (
          <div className="mt-0.5 text-xs text-text-3">
            {isOut ? "to " : "from "}
            <span className="break-all font-mono">{item.counterparty}</span>
          </div>
        )}
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="tap inline-flex shrink-0 items-center text-xs text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
      >
        Explorer ↗
      </a>
    </li>
  );
}
