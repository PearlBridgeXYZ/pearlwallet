import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";

export default function Unlock() {
  const navigate = useNavigate();
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
      navigate("/dashboard");
    } catch (e) {
      setError(e instanceof Error && e.message === "E_PASSWORD_WRONG"
        ? "Incorrect password."
        : e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Welcome back.</h1>
        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
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
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? "Unlocking..." : "Unlock"}
          </button>
        </form>
        <div className="mt-6 flex flex-col gap-2 text-sm">
          <Link to="/onboarding/restore" className="text-pearl-700 hover:underline">
            Wrong password? Restore from recovery phrase
          </Link>
          <p className="text-xs text-ink-500">
            To wipe this wallet without restoring, unlock first, then
            use Settings → Danger zone. Wiping requires your password
            so a passer-by with brief device access cannot nuke the
            keystore.
          </p>
        </div>
      </div>
    </div>
  );
}
