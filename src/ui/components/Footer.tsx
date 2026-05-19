import {
  BUILD_VERSION,
  BUILD_GIT_SHA,
  BUILD_TIME,
  REPO_URL,
  COMMIT_URL,
} from "../../build-info";

// Footer shown on every page. Surfaces the version, the exact commit SHA the
// build originates from, and a link to the public source. Users running a
// non-custodial wallet should always be able to verify what code they're
// loading from the page they're on.
export default function Footer() {
  const buildDate = BUILD_TIME ? BUILD_TIME.slice(0, 10) : "";
  return (
    <footer className="mt-12 border-t border-ink-200 py-4 text-center text-xs text-ink-500 dark:border-ink-800 dark:text-ink-400">
      <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4">
        <span>
          PearlWallet v{BUILD_VERSION}
        </span>
        <span aria-hidden="true">·</span>
        <a
          href={COMMIT_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono hover:text-ink-900 dark:hover:text-ink-100"
          title={`Built ${BUILD_TIME}`}
        >
          {BUILD_GIT_SHA}
        </a>
        <span aria-hidden="true">·</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-ink-900 dark:hover:text-ink-100"
        >
          Source
        </a>
        {buildDate && (
          <>
            <span aria-hidden="true">·</span>
            <span>{buildDate}</span>
          </>
        )}
      </div>
    </footer>
  );
}
