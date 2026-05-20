// Renders an ActivityResult as a list of in/out items with explorer
// links. Used by Dashboard (top 5) and History (full).

import { useQuery } from "@tanstack/react-query";
import { useWallet } from "../../state/wallet-store";
import { fetchActivity, type ActivityItem } from "../../services/activity";
import { formatGrains, formatWei } from "../../lib/format";
import { pearlTxExplorerUrl } from "../../chains/pearl/network";
import { ethTxExplorerUrl } from "../../chains/ethereum/network";

interface Props {
  limit?: number;
  /** When true, only show the top `limit` items. Used by Dashboard. */
  truncate?: boolean;
  /** Optional filter: "all" | "prl" | "wprl". */
  filter?: "all" | "prl" | "wprl";
}

export default function ActivityList({ limit = 25, truncate = false, filter = "all" }: Props) {
  const addresses = useWallet((s) => s.addresses);
  const ethNetwork = useWallet((s) => s.ethNetwork);

  const activityQ = useQuery({
    queryKey: [
      "activity",
      addresses?.pearlPool?.join(",") ?? addresses?.pearl,
      addresses?.eth,
      ethNetwork,
      limit,
    ],
    queryFn: () =>
      fetchActivity(
        addresses!.pearlPool ?? [addresses!.pearl],
        addresses!.eth as `0x${string}`,
        ethNetwork,
        limit,
      ),
    enabled: !!addresses,
    // Activity is more expensive than balances (pool walk + getLogs).
    // Refetch every 90s — fast enough to catch a fresh receive, slow
    // enough not to hammer the public sentry / public Eth RPC.
    refetchInterval: 90_000,
    staleTime: 60_000,
  });

  if (!addresses) return null;

  if (activityQ.isLoading) {
    return <p className="mt-3 text-sm text-ink-500">Scanning Pearl + Eth for recent activity…</p>;
  }

  if (activityQ.isError) {
    return (
      <p className="mt-3 text-sm text-red-600 dark:text-red-400">
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
        <p key={w} className="mt-2 text-xs text-amber-700 dark:text-amber-400">{w}</p>
      ))}
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">
          {data.pearlSource === "live" && data.wprlSource === "live"
            ? "No activity yet."
            : "No activity found in the scanned window."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
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
    : `${formatWei(item.amount)} WPRL`;
  const url = item.chain === "pearl"
    ? pearlTxExplorerUrl("mainnet", item.txid)
    : ethTxExplorerUrl(ethNetwork, item.txid);
  const chainLabel = item.chain === "pearl" ? "Pearl" : "Eth";

  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-ink-200 p-3 text-sm dark:border-ink-800">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={
              isOut
                ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                : "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
            }
          >
            {isOut ? "Sent" : "Received"}
          </span>
          <span className="text-xs text-ink-500">{chainLabel}</span>
        </div>
        <div className="mt-1 font-medium">
          <span className={isOut ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}>
            {sign} {amountStr}
          </span>
        </div>
        {item.counterparty && (
          <div className="mt-0.5 text-xs text-ink-500">
            {isOut ? "to " : "from "}
            <span className="break-all font-mono">{item.counterparty}</span>
          </div>
        )}
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-xs text-pearl-700 underline dark:text-pearl-300"
      >
        Explorer ↗
      </a>
    </li>
  );
}
