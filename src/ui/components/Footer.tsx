import { Link, useLocation } from "react-router-dom";
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
  return (
    <footer className="shell-width wallet-footer">
      <nav aria-label="Resources" className="footer-resources">
        <span>PearlWallet v{BUILD_VERSION}</span>
        <a href={COMMIT_URL} target="_blank" rel="noreferrer noopener" className="footer-link font-mono" title={`Built ${BUILD_TIME}`}>{BUILD_GIT_SHA}</a>
        <Link className="footer-link" to="/about">About / FAQ</Link>
        <a className="footer-link" href="https://github.com/PearlBridgeXYZ/pearlwallet" target="_blank" rel="noreferrer noopener">Source code ↗</a>
        <a className="footer-link" href="https://pearlbridge.xyz" target="_blank" rel="noreferrer noopener">PearlBridge ↗</a>
        <a className="footer-link" href="https://github.com/PearlBridgeXYZ/pearlwallet/releases" target="_blank" rel="noreferrer noopener">Releases ↗</a>
        <a className="footer-link" href="https://pearlbridge.xyz/audit" target="_blank" rel="noreferrer noopener">Bridge backing ↗</a>
      </nav>
      <p>Experimental, pre-1.0 software. Only store what you can afford to lose.</p>
      <p>PearlWallet is built by the PearlBridge team, an independent project not affiliated with Pearl Research Labs.</p>
    </footer>
  );
}
