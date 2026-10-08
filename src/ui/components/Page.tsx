import type { ReactNode } from "react";
import TopBar from "./TopBar";
import PendingBroadcasts from "./PendingBroadcasts";

interface PageProps {
  children: ReactNode;
  chrome?: boolean;
  title?: string;
}

/** Moves focus to the page's main region without touching the URL. */
export function focusMain(): void {
  const main = document.getElementById("main-content");
  main?.focus();
  main?.scrollIntoView?.({ block: "start" });
}

export default function Page({ children, chrome = true, title }: PageProps) {
  return (
    <div className="min-h-full">
      {/* A button, not href="#main-content": under file:// the app runs on a
          HashRouter, where changing the fragment navigates away (to the
          dashboard) and would lose an offline signer's work. */}
      <button type="button" className="skip-link" onClick={focusMain}>
        Skip to content
      </button>
      {chrome && <TopBar />}
      <main
        id="main-content"
        tabIndex={-1}
        className="shell-width page-main"
        style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}
      >
        {/* Broadcasts with an unknown status: visible on every screen. */}
        {chrome && <PendingBroadcasts />}
        {title && <h1 className="page-title">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
