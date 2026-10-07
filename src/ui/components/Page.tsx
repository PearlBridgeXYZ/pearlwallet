import type { ReactNode } from "react";
import TopBar from "./TopBar";

interface PageProps {
  children: ReactNode;
  chrome?: boolean;
  title?: string;
}

export default function Page({ children, chrome = true, title }: PageProps) {
  return (
    <div className="min-h-full">
      <a href="#main-content" className="skip-link">Skip to content</a>
      {chrome && <TopBar />}
      <main
        id="main-content"
        tabIndex={-1}
        className="shell-width page-main"
        style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}
      >
        {title && <h1 className="page-title">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
