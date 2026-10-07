import {
  BUILD_VERSION,
  BUILD_GIT_SHA,
  BUILD_TIME,
  COMMIT_URL,
} from "../../build-info";

// Footer shown on every page. Surfaces the version, the exact commit SHA the
// build originates from, and a link to the public source. Users running a
// non-custodial wallet should always be able to verify what code they're
// loading from the page they're on.
export default function Footer() {
  const buildDate = BUILD_TIME ? BUILD_TIME.slice(0, 10) : "";
  return (
    <footer className="shell-width mt-12 pb-8 pt-6 text-xs text-text-3" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
      <div className="grid gap-6 border-t border-heading pt-8 sm:grid-cols-[1fr_auto]">
        <div>
          <p className="text-[22px] font-semibold tracking-tight text-heading">PearlWallet</p>
          <p className="mt-2 text-sm text-text-2">Your keys. Your browser.</p>
        </div>
        <nav aria-label="Resources" className="grid grid-cols-2 gap-x-8">
          <a className="footer-link" href="https://github.com/PearlBridgeXYZ/pearlwallet" target="_blank" rel="noreferrer noopener">Source code ↗</a>
          <a className="footer-link" href="https://pearlbridge.xyz" target="_blank" rel="noreferrer noopener">PearlBridge ↗</a>
          <a className="footer-link" href="https://github.com/PearlBridgeXYZ/pearlwallet/releases" target="_blank" rel="noreferrer noopener">Releases ↗</a>
          <a className="footer-link" href="https://pearlbridge.xyz/audit" target="_blank" rel="noreferrer noopener">Bridge backing ↗</a>
        </nav>
      </div>
      <div className="mt-6 border-t border-line pt-5 leading-relaxed">
        <p>PearlWallet is built by the PearlBridge team, an independent project not affiliated with Pearl Research Labs.</p>
        <p className="mt-1">Experimental, pre-1.0 software. Only store what you can afford to lose.</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>PearlWallet v{BUILD_VERSION}</span>
        <span aria-hidden="true">·</span>
        <a
          href={COMMIT_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="tap inline-flex items-center font-mono underline decoration-line underline-offset-4 hover:text-accent"
          title={`Built ${BUILD_TIME}`}
        >
          {BUILD_GIT_SHA}
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
