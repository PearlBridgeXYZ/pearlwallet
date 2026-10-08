import { Link } from "react-router-dom";
import { detectFileProtocol, detectStandalone } from "../../lib/pwa-install";
import { useWallet } from "../../state/wallet-store";
import mark from "../assets/brand/pearlbridge-mark.svg";
import LandingPage from "./landing/LandingPage";
import WalletActions from "./landing/WalletActions";

export default function Splash() {
  const status = useWallet((s) => s.status);
  const initializing = status === "initializing";
  const hasWallet = status === "locked" || status === "unlocked";

  // Suppress CTAs/marketing until init() resolves: a slow IndexedDB open could
  // flash "Create wallet" for a returning user and let them click into
  // /onboarding/create before the route guard catches up.
  if (initializing) {
    return (
      <main className="shell-width flex min-h-[60vh] items-center justify-center">
        <p role="status" className="text-sm text-text-3">Loading wallet…</p>
      </main>
    );
  }

  // Existing wallets go to Unlock, never create/restore: onboarding would
  // overwrite the keystore and strand funds without a backup. Replacement
  // goes through Settings → Danger Zone, which requires the password.
  if (hasWallet) {
    return (
      <main className="shell-width py-16">
        <div className="mx-auto max-w-md text-center">
          <img src={mark} alt="" width="64" height="64" className="mx-auto mb-6" />
          <h1 className="text-3xl font-semibold tracking-tight">Welcome back.</h1>
          <p className="mt-3 text-text-2">Your wallet is already on this device.</p>
          <Link to="/unlock" className="btn-primary mt-8 w-full">Unlock your wallet</Link>
          <p className="mt-4 text-sm leading-relaxed text-text-3">
            To replace it, unlock first, then use Settings → Danger Zone.
          </p>
        </div>
      </main>
    );
  }

  // REDESIGN-NOTE: file:// entry also needs the separate offline router fix;
  // BrowserRouter currently redirects the file path before this welcome opens.
  const compact = detectFileProtocol() || detectStandalone();

  if (compact) {
    return (
      <main className="shell-width py-16">
        <div className="mx-auto max-w-md text-center">
          <img src={mark} alt="" width="64" height="64" className="mx-auto mb-6" />
          <h1 className="text-3xl font-semibold tracking-tight">PearlWallet</h1>
          <p className="mb-8 mt-3 text-text-2">Your keys. Your browser. Your PRL.</p>
          <WalletActions />
        </div>
      </main>
    );
  }

  return <LandingPage />;
}
