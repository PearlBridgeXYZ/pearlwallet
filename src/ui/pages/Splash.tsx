import { Link } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { BUILD_GIT_SHA, BUILD_VERSION } from "../../build-info";

export default function Splash() {
  const status = useWallet((s) => s.status);
  const hasWallet = status !== "no-wallet";

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 h-20 w-20 rounded-full bg-gradient-to-br from-pearl-100 via-pearl-300 to-pearl-800 shadow-lg" />
        <h1 className="text-3xl font-semibold tracking-tight">Pearl Web Wallet</h1>
        <p className="mt-2 text-sm text-ink-500 dark:text-ink-400">
          Non-custodial. PRL and WPRL in one place.
        </p>

        <div className="mt-8 flex flex-col gap-2">
          <Link to="/onboarding/create" className="btn-primary w-full">
            Create a new wallet
          </Link>
          <Link to="/onboarding/restore" className="btn-secondary w-full">
            Restore from recovery phrase
          </Link>
          {hasWallet && (
            <Link to="/unlock" className="text-sm text-ink-500 underline-offset-2 hover:underline dark:text-ink-400">
              Unlock existing wallet
            </Link>
          )}
        </div>

        <footer className="mt-12 text-xs text-ink-400">
          v{BUILD_VERSION} · build {BUILD_GIT_SHA}
        </footer>
      </div>
    </div>
  );
}
