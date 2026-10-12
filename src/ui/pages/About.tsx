import Page from "../components/Page";
import { TIP_POLICY_TEXT } from "../../chains/pearl/tip";
import { BUILD_GIT_SHA, BUILD_TIME, BUILD_VERSION } from "../../build-info";

export default function About() {
  return (
    <Page title="About PearlWallet">
      <p className="mb-8 max-w-xl text-base leading-7 text-text-2">
        An open-source, non-custodial wallet for PRL on Pearl and WPRL and ETH
        on Ethereum. Built by the PearlBridge team.
      </p>
      <div className="space-y-8 text-sm leading-7">
        <section className="card shadow-slabsm sm:shadow-slab">
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Your keys</p>
          <h2 className="mt-2 text-xl font-semibold">Your recovery phrase is your responsibility.</h2>
          <p className="mt-3 text-text-2">
            Your recovery phrase is created and encrypted in your browser. No
            server stores or receives your keys. Keep your 12- or 24-word phrase
            somewhere safe: there is no password reset or support unlock. If you
            lose access to your wallet and your phrase, your funds cannot be recovered.
          </p>
        </section>

        <section className="border-t border-heading pt-5">
          <h2 className="text-lg font-semibold">Open source. Publicly reviewed.</h2>
          <p className="mt-3 text-text-2">
            Read the code and build the wallet yourself. The repository includes
            public security review reports covering versions v0.1.0 through v0.4.3.
            These are AI-assisted, multi-model reviews; they do not guarantee
            that the current wallet is free of vulnerabilities.
          </p>
          <a
            href="https://github.com/PearlBridgeXYZ/pearlwallet"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
          >
            View source and review reports ↗
          </a>
        </section>

        <section className="border-t border-heading pt-5">
          <h2 className="text-lg font-semibold">Privacy and local protection</h2>
          <p className="mt-3 text-text-2">
            The app has no analytics or trackers. Balance and activity lookups
            use PearlBridge and public Ethereum RPC services. Those services can
            see your IP address and the wallet addresses you query.
          </p>
          <p className="mt-3 text-text-2">
            Your wallet is encrypted with AES-256-GCM. Signing runs in an isolated
            worker, and the wallet locks after five minutes of inactivity.
          </p>
        </section>

        <section className="border-t border-heading pt-5">
          <h2 className="text-lg font-semibold">Sign offline</h2>
          <p className="mt-3 text-text-2">
            Download the single-file HTML wallet from GitHub releases for
            signing on an offline machine. Check the asset&apos;s SHA-256 shown
            by GitHub. Broadcasting a signed transaction still requires an
            online machine.
          </p>
          <a
            href="https://github.com/PearlBridgeXYZ/pearlwallet/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
          >
            View downloads ↗
          </a>
        </section>

        <section className="border-t border-heading pt-5">
          <h2 className="text-lg font-semibold">Bridge between Pearl and Ethereum</h2>
          <p className="mt-3 text-text-2">
            PearlBridge lets you move between PRL on Pearl and WPRL on Ethereum.
            PRL backing is held on Pearl L1 and is publicly checkable. Bridging
            carries smart-contract and operational risk.
          </p>
          <a
            href="https://pearlbridge.xyz/audit"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
          >
            Check live bridge backing ↗
          </a>
        </section>

        <section className="border-t border-heading pt-5">
          <h2 className="text-lg font-semibold">Optional developer tip</h2>
          <p className="mt-3 text-text-2">
            PRL sends include an optional developer tip. {TIP_POLICY_TEXT} It is
            on by default; you can turn it off for any send or in Settings.
            Network and bridge fees are separate.
          </p>
        </section>

        <section className="border-t border-heading pt-5">
          <h2 className="text-lg font-semibold">Build information</h2>
          <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-text-2">
            <dt className="text-text-3">Version</dt>
            <dd className="break-all font-mono">{BUILD_VERSION}</dd>
            <dt className="text-text-3">Git SHA</dt>
            <dd className="break-all font-mono">{BUILD_GIT_SHA}</dd>
            <dt className="text-text-3">Built</dt>
            <dd className="break-all font-mono">{BUILD_TIME}</dd>
          </dl>
        </section>

        <aside className="border-t border-line pt-5 text-xs leading-6 text-text-3">
          <p>PearlBridge is an independent project, not affiliated with Pearl Research Labs. PearlWallet is experimental, pre-1.0 software. Only store what you can afford to lose.</p>
          <p className="mt-2">Report security issues to <a className="inline-flex min-h-11 items-center break-all text-accent underline underline-offset-4" href="mailto:bridgedev@mailbox.org">bridgedev@mailbox.org</a>.</p>
        </aside>
      </div>
    </Page>
  );
}
