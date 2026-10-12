import type { ReactNode } from "react";
import { TIP_POLICY_TEXT } from "../../../chains/pearl/tip";
import mark from "../../assets/brand/pearlbridge-mark.svg";
import InstallPWA from "../../components/InstallPWA";
import WalletActions from "./WalletActions";
import "./landing.css";

const SOURCE = "https://github.com/PearlBridgeXYZ/pearlwallet";
const RELEASE = `${SOURCE}/releases/latest`;
const BACKING = "https://pearlbridge.xyz/audit";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="landing-link" href={href} target="_blank" rel="noopener noreferrer">{children}<span aria-hidden="true"> ↗</span></a>;
}

function SectionHead({ id, kicker, children }: { id: string; kicker: string; children: ReactNode }) {
  return (
    <div className="landing-section-head">
      <p className="landing-kicker">{kicker}</p>
      <h2 id={id}>{children}</h2>
    </div>
  );
}

const pillars = [
  { title: "You hold the keys.", text: "Your recovery phrase is created and encrypted in your browser. AES-256-GCM encryption uses a key derived with 600,000 rounds of PBKDF2-SHA256. No server receives or stores your keys." },
  { title: "Built to resist a hostile web.", text: "Signing runs in an isolated worker. A strict content policy limits connections. The wallet locks after five idle minutes and tries to clear copied addresses from the clipboard after 60 seconds." },
  { title: "Reviewed in the open.", text: "Public review reports document findings by severity and how they were handled. These are AI-assisted multi-model reviews. Their scope and limits are set out below." },
  { title: "Source you can inspect.", text: "Read the code, build it yourself, or check the SHA-256 digest GitHub provides for release assets. The source is public, so you can see what you are running." },
  { title: "An offline signing option.", text: "Download the single-file HTML build to sign on an air-gapped machine. Offline signing keeps that step separate from the device you use to connect to the network." },
  { title: "One phrase, two chains.", text: "Hold PRL on Pearl and WPRL and ETH on Ethereum from one recovery phrase. PearlBridge is built in for PRL ↔ WPRL transfers. Multisig vaults support shared funds and co-signing." },
];

const steps = [
  { title: "Create or import.", text: "Start with a new recovery phrase, or bring an existing 12- or 24-word phrase. Keep a written backup somewhere safe." },
  { title: "Set your password.", text: "Your wallet is encrypted on this device. Keep your recovery phrase: there is no password reset or support unlock." },
  { title: "Review, then sign.", text: "Send and receive, or bridge PRL and WPRL. A PRL send shows the destination, amount and network fee before you sign; a bridge transfer shows the bridge fee and its Pearl network fee or Ethereum gas." },
];

const faqs: { question: string; answer: ReactNode }[] = [
  { question: "Can the team access my wallet keys?", answer: "No server receives or stores your wallet keys. Your recovery phrase is created and encrypted in your browser. Keep it private: anyone who has it can access your wallet." },
  { question: "What if I lose my recovery phrase?", answer: "Without your recovery phrase, you cannot restore your wallet if you lose access to this device. There is no password reset or support unlock. Write down the phrase and keep it somewhere safe." },
  { question: "What security reviews are available?", answer: <>There are 36 public review reports covering v0.1.0 through v0.4.3. They are AI-assisted multi-model reviews. No paid third-party audit has taken place yet. <ExternalLink href={SOURCE}>Read the reports</ExternalLink></> },
  { question: "Does the wallet track me?", answer: "The app has no analytics or trackers. Pearl balance and history lookups go through PearlBridge’s public RPC. Network providers can see your IP address and the wallet addresses you query." },
  { question: "Is there a fee?", answer: `PRL sends include an optional developer tip. ${TIP_POLICY_TEXT} It is on by default; you can turn it off for any send or in Settings. PRL sends show the network fee before you sign. Bridge transfers show the bridge fee and their Pearl network fee or Ethereum gas before you sign.` },
  { question: "Is WPRL backed?", answer: <>WPRL is intended to be backed by PRL held on Pearl. Review the live backing information before bridging. <ExternalLink href={BACKING}>Check bridge backing</ExternalLink></> },
  { question: "Who builds PearlWallet?", answer: <>The PearlBridge team, an independent project not affiliated with Pearl Research Labs. For responsible security disclosure, contact <a className="landing-link" href="mailto:bridgedev@mailbox.org">bridgedev@mailbox.org</a>.</> },
];

export default function LandingPage() {
  return (
    <div className="landing">
      <a href="#landing-main" className="skip-link">Skip to content</a>
      <header className="wallet-header">
        <div className="landing-container landing-header">
          <a href="#landing-main" className="landing-brand">
            <img src={mark} alt="" width="36" height="36" />
            <span className="wallet-wordmark">PearlWallet</span>
          </a>
          <nav aria-label="On this page" className="landing-nav">
            <a href="#how-it-works">How it works</a>
            <a href="#security-reviews">Security reviews</a>
            <a href="#questions">FAQ</a>
          </nav>
        </div>
      </header>

      <main id="landing-main" className="landing-container" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div>
            <p className="landing-kicker">Pearl ↔ Ethereum</p>
            <h1 id="landing-title">Your keys.<br />Your browser.<br />Your PRL.</h1>
            <p className="landing-lead">PearlWallet is an open-source, non-custodial wallet for PRL on Pearl and WPRL and ETH on Ethereum, with PearlBridge built in.</p>
            <dl className="landing-keyline">
              <div><dt>Pearl</dt><dd>PRL</dd></div>
              <div><dt>Ethereum</dt><dd>WPRL / ETH</dd></div>
              <div><dt>Shared funds</dt><dd>Multisig vaults</dd></div>
            </dl>
          </div>
          <div className="landing-start">
            <div className="landing-slab">
              <p className="landing-kicker">On your device</p>
              <h2>Start with your own keys.</h2>
              <p>Create a wallet, or bring your recovery phrase. You keep control of the keys.</p>
              <WalletActions />
              <div className="landing-downloads">
                <ExternalLink href={RELEASE}>Download offline version</ExternalLink>
                <ExternalLink href={SOURCE}>View source</ExternalLink>
              </div>
              <p className="landing-small">Keep your recovery phrase safe. There is no reset.</p>
            </div>
            {/* Install-first nudge for fresh visitors: iOS PWA storage is isolated
                from Safari, so a wallet created there is invisible in the home-screen app.
                Self-suppresses when installed, on file://, or in unsupported browsers. */}
            <div className="mt-6"><InstallPWA variant="banner" /></div>
          </div>
        </section>

        <ul className="landing-trust-strip" aria-label="At a glance">
          <li>Open source</li><li>Non-custodial</li><li>36 public review reports</li><li>Offline signing build</li>
        </ul>

        <section className="landing-section" aria-labelledby="principles-title">
          <SectionHead id="principles-title" kicker="Designed for self-custody">Know what you are trusting.</SectionHead>
          <div className="landing-pillars">
            {pillars.map((pillar) => <article key={pillar.title}><h3>{pillar.title}</h3><p>{pillar.text}</p></article>)}
          </div>
        </section>

        <dl className="landing-stats" aria-label="Wallet security facts">
          <div><dt>Key derivation</dt><dd>600,000-round<span>PBKDF2-SHA256</span></dd></div>
          <div><dt>Local encryption</dt><dd>AES-256-GCM<span>Encrypted on this device</span></dd></div>
          <div><dt>Idle protection</dt><dd>5-minute auto-lock<span>After inactivity</span></dd></div>
          <div><dt>Published reviews</dt><dd>36 public review reports<span>AI-assisted · v0.1.0–v0.4.3</span></dd></div>
        </dl>

        <section id="how-it-works" className="landing-section" aria-labelledby="steps-title">
          <SectionHead id="steps-title" kicker="How it works">A wallet, in three steps.</SectionHead>
          <ol className="landing-steps">
            {steps.map((step, i) => <li key={step.title}><span className="landing-step-number" aria-hidden="true">0{i + 1}</span><h3>{step.title}</h3><p>{step.text}</p></li>)}
          </ol>
        </section>

        <section className="landing-ink" aria-labelledby="keys-title">
          <div><p className="landing-kicker">Before you begin</p><h2 id="keys-title">Your keys stay<br />with you.</h2></div>
          <div><p>Your recovery phrase is created and encrypted in your browser. No server receives or stores your keys.</p><p>That also makes the backup your responsibility. Write down your recovery phrase and keep it private. Without it, a lost device can mean lost funds.</p></div>
        </section>

        <div className="landing-evidence">
          <section id="security-reviews" className="landing-section" aria-labelledby="reviews-title">
            <SectionHead id="reviews-title" kicker="Read the evidence">Security reviews</SectionHead>
            <p>36 public review reports cover v0.1.0 through v0.4.3, with findings by severity and how they were handled. These are AI-assisted multi-model reviews.</p>
            <p className="font-semibold text-heading">No paid third-party audit has taken place yet.</p>
            <p>The reports cover particular versions. They do not establish that the current release is free of vulnerabilities.</p>
            <ExternalLink href={SOURCE}>Read the public review reports</ExternalLink>
          </section>
          <section className="landing-section" aria-labelledby="backing-title">
            <SectionHead id="backing-title" kicker="Across networks">Bridge backing</SectionHead>
            <p>PRL is held on Pearl to back WPRL on Ethereum. The backing is publicly checkable, and the bridge contracts are source-verified.</p>
            <p>Check the live backing information before you bridge. A source-verified contract is not a promise of safety.</p>
            <ExternalLink href={BACKING}>View live bridge backing</ExternalLink>
          </section>
        </div>

        <section id="questions" className="landing-section" aria-labelledby="questions-title">
          <SectionHead id="questions-title" kicker="Before you decide">Questions, answered plainly.</SectionHead>
          <div className="landing-faq">
            {faqs.map(({ question, answer }) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}
          </div>
        </section>

        <aside className="landing-fees" aria-labelledby="fees-title">
          <h2 id="fees-title">A note on fees</h2>
          <p>PRL sends include an optional <strong>developer tip</strong>. {TIP_POLICY_TEXT} It is on by default; you can turn it off for any send or in Settings. PRL sends show the network fee before you sign. Bridge transfers show the bridge fee and their Pearl network fee or Ethereum gas before you sign.</p>
        </aside>

        <section className="landing-closing" aria-labelledby="closing-title">
          <div><p className="landing-kicker">Make it yours</p><h2 id="closing-title">Start with a wallet you control.</h2><p>Experimental, pre-1.0 software. Only store what you can afford to lose.</p></div>
          <WalletActions />
        </section>
      </main>
    </div>
  );
}
