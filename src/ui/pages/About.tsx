import Page from "../components/Page";
import { BUILD_GIT_SHA, BUILD_TIME, BUILD_VERSION } from "../../build-info";

export default function About() {
  return (
    <Page title="About PearlWallet">
      <div className="card space-y-4 text-sm">
        <section>
          <h2 className="font-semibold">What is this?</h2>
          <p className="mt-1 text-ink-600 dark:text-ink-300">
            PearlWallet is a non-custodial browser wallet for Pearl L1 (PRL) and the
            Ethereum-side wrapper (WPRL). Your keys are generated, encrypted, and used entirely
            in your browser. We never see them.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">Open source</h2>
          <p className="mt-1 text-ink-600 dark:text-ink-300">
            Every line of code that touches your keys is auditable. The repository lives at{" "}
            <a
              href="https://github.com/PearlBridgeXYZ/pearlwallet"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              github.com/PearlBridgeXYZ/pearlwallet
            </a>
            . Reproducible builds: the build SHA shown below matches the public commit.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">What "non-custodial" means</h2>
          <p className="mt-1 text-ink-600 dark:text-ink-300">
            You alone hold the recovery phrase. If you lose it, your funds are gone — there's no
            recovery, no support ticket, no remote unlock. That's not a flaw; it's the design.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">What the wallet does NOT do</h2>
          <ul className="mt-1 list-disc pl-5 text-ink-600 dark:text-ink-300">
            <li>Spend your funds without your authorization.</li>
            <li>See your balance on our servers — we look it up from public chain data.</li>
            <li>Hold your keys, ever.</li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold">Offline / air-gapped use</h2>
          <p className="mt-1 text-ink-600 dark:text-ink-300">
            Every GitHub release attaches a single-file HTML build —
            {" "}
            <span className="font-mono">pearlwallet-offline-vX.Y.Z.html</span>
            {" "}
            — that runs entirely from
            {" "}
            <span className="font-mono">file://</span>
            {" "}
            with no external fetches. Save it to a USB stick, audit the
            SHA-256, and sign transactions on a machine that never
            touches the network. Broadcasting still needs an online
            relay, but key material and signing stay air-gapped.{" "}
            <a
              href="https://github.com/PearlBridgeXYZ/pearlwallet/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Latest release ↗
            </a>
          </p>
        </section>

        <section>
          <h2 className="font-semibold">How the bridge works</h2>
          <p className="mt-1 text-ink-600 dark:text-ink-300">
            PearlBridge locks PRL on Pearl L1 and mints an equivalent amount of WPRL on Ethereum
            (and vice versa). It's a lock-and-mint design with multi-sig validation, not a swap.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">Build</h2>
          <dl className="mt-1 grid grid-cols-2 gap-2 text-ink-600 dark:text-ink-300">
            <dt>Version</dt>
            <dd className="font-mono">{BUILD_VERSION}</dd>
            <dt>Git SHA</dt>
            <dd className="font-mono">{BUILD_GIT_SHA}</dd>
            <dt>Built</dt>
            <dd className="font-mono">{BUILD_TIME}</dd>
          </dl>
        </section>
      </div>
    </Page>
  );
}
