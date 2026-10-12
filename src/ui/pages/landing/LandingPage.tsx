import { BUILD_VERSION, BUILD_GIT_SHA, COMMIT_URL } from "../../../build-info";
import InstallPWA from "../../components/InstallPWA";
import AsciiPearl from "./AsciiPearl";
import WalletActions from "./WalletActions";
import WalletGuide from "./WalletGuide";
import "./landing.css";

const SOURCE = "https://github.com/PearlBridgeXYZ/pearlwallet";

export default function LandingPage() {
  return (
    <div className="landing">
      <a href="#landing-main" className="skip-link">Skip to content</a>
      <AsciiPearl />
      <main id="landing-main" className="landing-main" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <h1 id="landing-title">pearlwallet<span className="landing-cursor" aria-hidden="true">_</span></h1>
          <div className="landing-copy">
            <p>your keys stay in your browser.</p>
            <p>PRL on Pearl. WPRL + ETH on Ethereum.</p>
            <p>bridge built in.</p>
            <p>open source. non-custodial.</p>
          </div>
          <WalletActions />
          <p className="landing-warning">Experimental, pre-1.0 software. Only store what you can afford to lose.</p>
          {/* Keep the existing install-before-create warning for iOS visitors. */}
          <div className="landing-install"><InstallPWA variant="banner" /></div>
        </section>
      </main>
      <div className="landing-bottom">
        <nav className="landing-resources" aria-label="Resources">
          <a href={`${SOURCE}/releases/latest`} target="_blank" rel="noopener noreferrer">offline version ↗</a>
          <a href={SOURCE} target="_blank" rel="noopener noreferrer">source ↗</a>
        </nav>
        {/* /about is wallet-guarded. A native disclosure keeps the complete
            guide one click away before onboarding. */}
        <details className="landing-about">
          <summary>about / FAQ</summary>
          <WalletGuide />
        </details>
        <p className="landing-build">
          <span>v{BUILD_VERSION}</span>
          <a href={COMMIT_URL} target="_blank" rel="noopener noreferrer" aria-label={`Source at commit ${BUILD_GIT_SHA}`}>{BUILD_GIT_SHA}</a>
        </p>
      </div>
    </div>
  );
}
