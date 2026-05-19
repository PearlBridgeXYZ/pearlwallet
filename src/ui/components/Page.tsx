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
      <main className="mx-auto max-w-2xl px-4 py-6">
        {title && <h1 className="mb-4 text-xl font-semibold">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
