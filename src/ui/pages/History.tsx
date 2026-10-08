import { useState } from "react";
import Page from "../components/Page";
import ActivityList from "../components/ActivityList";

type Filter = "all" | "prl" | "wprl";

export default function History() {
  const [filter, setFilter] = useState<Filter>("all");

  return (
    <Page title="History">
      <p className="mb-6 text-sm leading-7 text-text-2">Your PRL and WPRL activity, with transaction details from each network.</p>
      <div className="mb-6 inline-flex gap-1 rounded-pb border border-line bg-surface-2 p-1 text-sm">
        {(["all", "prl", "wprl"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={
              filter === f
                ? "min-h-11 min-w-16 rounded-pb bg-accent-bg px-4 py-2 font-semibold text-on-accent"
                : "min-h-11 min-w-16 rounded-pb px-4 py-2 text-text-3 hover:text-heading"
            }
          >
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="card">
        <ActivityList filter={filter} limit={100} />
        <p className="mt-6 border-t border-line pt-4 text-xs leading-6 text-text-3">
          Pearl activity comes from your configured RPC. WPRL activity covers
          roughly the latest 100,000 Ethereum blocks. Native ETH transfers are not listed
          here — view your Ethereum address on Etherscan for the full picture.
        </p>
      </div>
    </Page>
  );
}
