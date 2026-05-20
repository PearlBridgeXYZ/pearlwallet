import { useState } from "react";
import Page from "../components/Page";
import ActivityList from "../components/ActivityList";

type Filter = "all" | "prl" | "wprl";

export default function History() {
  const [filter, setFilter] = useState<Filter>("all");

  return (
    <Page title="History">
      <div className="mb-4 flex gap-2 text-sm">
        {(["all", "prl", "wprl"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              filter === f
                ? "rounded-full bg-pearl-700 px-3 py-1 text-white"
                : "rounded-full border border-ink-300 px-3 py-1 text-ink-600 dark:border-ink-700 dark:text-ink-300"
            }
          >
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="card">
        <ActivityList filter={filter} limit={100} />
        <p className="mt-4 text-xs text-ink-500">
          Pearl is scanned via your configured sentry RPC; WPRL is scanned via
          the last ~100k Ethereum blocks. Native ETH transfers are not listed
          here — view your Ethereum address on Etherscan for the full picture.
        </p>
      </div>
    </Page>
  );
}
