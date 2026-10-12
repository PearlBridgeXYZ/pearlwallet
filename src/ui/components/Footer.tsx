import { useLocation } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { detectFileProtocol, detectStandalone } from "../../lib/pwa-install";
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
  const { pathname } = useLocation();
  const status = useWallet((s) => s.status);
  // The one-screen visitor landing supplies its own source/build links and guide.
  if (pathname === "/" && status === "no-wallet" && !detectFileProtocol() && !detectStandalone()) return null;
  const buildDate = BUILD_TIME ? BUILD_TIME.slice(0, 10) : "";
  return (
    <footer className="shell-width mt-8 pb-6 pt-4 text-xs text-text-3" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
      <div className="flex flex-wrap items-center justify-between gap-x-8 border-t border-line pt-4">
        <nav aria-label="Resources" className="flex flex-wrap gap-x-6">
          <a className="footer-link" href="https://github.com/PearlBridgeXYZ/pearlwallet" target="_blank" rel="noreferrer noopener">Source code ↗</a>
          <a className="footer-link" href="https://pearlbridge.xyz" target="_blank" rel="noreferrer noopener">PearlBridge ↗</a>
          <a className="footer-link" href="https://github.com/PearlBridgeXYZ/pearlwallet/releases" target="_blank" rel="noreferrer noopener">Releases ↗</a>
          <a className="footer-link" href="https://pearlbridge.xyz/audit" target="_blank" rel="noreferrer noopener">Bridge backing ↗</a>
        </nav>
      </div>
      <div className="mt-3 leading-relaxed">
        <p>PearlWallet is built by the PearlBridge team, an independent project not affiliated with Pearl Research Labs.</p>
        <p className="mt-1">Experimental, pre-1.0 software. Only store what you can afford to lose.</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
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
