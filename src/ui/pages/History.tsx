import { useState } from "react";
import Page from "../components/Page";

type Filter = "all" | "prl" | "wprl" | "bridge";

export default function History() {
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <Page title="History">
      <div className="mb-4 flex gap-2 text-sm">
        {(["all", "prl", "wprl", "bridge"] as Filter[]).map((f) => (
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
      <div className="card text-sm text-ink-500">
        No transactions yet. Activity appears here once you send, receive, or bridge.
      </div>
    </Page>
  );
}
