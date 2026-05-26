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
      {chrome && <TopBar />}
      <main
        className="mx-auto max-w-2xl px-4 py-6 pl-safe pr-safe pb-safe"
        // Inline style adds the safe-area-inset to the existing px-4
        // (top) and py-6 (bottom) rather than replacing them — Tailwind's
        // padding utilities and our `.p?-safe` utilities don't combine
        // additively, so we mix them at the style level when both
        // matter (top: header is below the notch already, so px-4 is
        // enough for sides; bottom: home indicator on iPhone X+ needs
        // additional clearance over the existing py-6).
        style={{
          paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
          paddingLeft: "max(1rem, env(safe-area-inset-left))",
          paddingRight: "max(1rem, env(safe-area-inset-right))",
        }}
      >
        {title && <h1 className="mb-4 text-xl font-semibold">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
