import { Link, useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";

export default function TopBar() {
  const navigate = useNavigate();
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);

  return (
    <header className="border-b border-ink-200 bg-white/80 backdrop-blur dark:border-ink-800 dark:bg-ink-950/80">
      <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
        <Link to="/dashboard" className="flex items-center gap-2">
          <img
            src="/logo-192.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-full"
          />
          <span className="text-sm font-semibold tracking-tight">PearlWallet</span>
        </Link>
        <div className="flex items-center gap-3 text-xs">
          {status === "unlocked" && (
            <button
              type="button"
              className="text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100"
              onClick={async () => {
                await lock();
                navigate("/unlock");
              }}
              aria-label="Lock wallet"
            >
              Lock
            </button>
          )}
          <Link
            to="/settings"
            className="text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100"
          >
            Settings
          </Link>
        </div>
      </div>
    </header>
  );
}
