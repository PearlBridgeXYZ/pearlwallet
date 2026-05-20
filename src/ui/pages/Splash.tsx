import { Link } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";

export default function Splash() {
  const status = useWallet((s) => s.status);
  const hasWallet = status !== "no-wallet";

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 h-20 w-20 rounded-full bg-gradient-to-br from-pearl-100 via-pearl-300 to-pearl-800 shadow-lg" />
        <h1 className="text-3xl font-semibold tracking-tight">PearlWallet</h1>
        <p className="mt-2 text-sm text-ink-500 dark:text-ink-400">
          Non-custodial. PRL and WPRL in one place.
        </p>

        <div className="mt-8 flex flex-col gap-2">
          {hasWallet ? (
            <>
              {/* Existing wallet on this device — funnel the user to unlock,
                  not create/restore (which would overwrite the keystore and
                  strand any funds they haven't backed up). Replacing the
                  wallet is still possible but routes through Settings ->
                  Danger Zone where it requires the password to wipe. */}
              <Link to="/unlock" className="btn-primary w-full">
                Unlock your wallet
              </Link>
              <p className="mt-3 text-xs text-ink-500 dark:text-ink-400">
                A wallet already exists on this device. To replace it with
                a different one, unlock first, then use Settings → Danger
                Zone to wipe it.
              </p>
            </>
          ) : (
            <>
              <Link to="/onboarding/create" className="btn-primary w-full">
                Create a new wallet
              </Link>
              <Link to="/onboarding/restore" className="btn-secondary w-full">
                Restore from recovery phrase
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
