import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import TopBar from "../components/TopBar";

// Whitelist of paths the `?next=` redirect honours. We never want to
// follow an arbitrary URL after unlock — open-redirect into an
// attacker-controlled origin would let a phishing link bounce through
// the wallet and steal session state. Allow only known internal routes.
//
// Exported so the open-redirect matrix is unit-testable in isolation
// (same pattern as `routeGuardTarget` in App.tsx).
export const NEXT_PATH_PATTERNS = [
  /^\/vault\/tx\/[A-Za-z0-9_-]{43}$/,
];

export function safeNext(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/")) return "/dashboard";
  if (NEXT_PATH_PATTERNS.some((re) => re.test(raw))) return raw;
  return "/dashboard";
}

export default function Unlock() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const unlock = useWallet((s) => s.unlock);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      navigate(next, { replace: true });
    } catch (e) {
      setError(e instanceof Error && e.message === "E_PASSWORD_WRONG"
        ? "Incorrect password."
        : e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <TopBar />
    <div className="shell-width flex min-h-full items-center justify-center py-10 sm:py-16">
      <div className="card w-full max-w-md shadow-slabsm sm:shadow-slab">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Wallet locked</p>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-.6px] sm:text-[34px]">Welcome back.</h1>
        <p className="mt-3 text-sm leading-7 text-text-2">Enter your password to unlock the wallet stored in this browser.</p>
        <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
          <label className="block">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? "Unlocking..." : "Unlock"}
          </button>
        </form>
        <div className="mt-6 flex flex-col gap-2 border-t border-line pt-4 text-sm">
          <Link to="/onboarding/restore" className="inline-flex min-h-11 items-center text-accent underline decoration-line underline-offset-4 hover:decoration-accent">
            Forgot your password? Import your recovery phrase
          </Link>
          <p className="text-xs leading-6 text-text-3">
            There is no password reset or support unlock. Your recovery phrase
            lets you import the wallet and choose a new password. To remove
            this wallet from the browser, unlock it and open Settings → Danger zone.
          </p>
        </div>
      </div>
    </div>
    </>
  );
}
