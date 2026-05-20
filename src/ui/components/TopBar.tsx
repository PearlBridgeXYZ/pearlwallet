import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { AUTO_LOCK_MS } from "../../state/wallet-store";
import { monotonicNow } from "../../lib/monotonic";

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function TopBar() {
  const navigate = useNavigate();
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);
  const lastActivity = useWallet((s) => s.lastActivity);
  const [now, setNow] = useState(() => monotonicNow());

  // 1Hz tick while unlocked so the countdown actually counts. Otherwise
  // the user would see "5:00" frozen and assume the timer is dead.
  // monotonicNow() keeps the countdown source consistent with the
  // auto-lock check in App.tsx — using a wall-clock here while App uses
  // monotonic would make the countdown drift on clock steps.
  useEffect(() => {
    if (status !== "unlocked") return;
    const id = setInterval(() => setNow(monotonicNow()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const remaining = Math.max(0, AUTO_LOCK_MS - (now - lastActivity));
  const warning = remaining <= 60_000;

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
            <>
              <span
                className={
                  warning
                    ? "tabular-nums text-amber-600 dark:text-amber-400"
                    : "tabular-nums text-ink-500 dark:text-ink-400"
                }
                title="Time until automatic lock from inactivity"
                aria-label={`Auto-lock in ${formatRemaining(remaining)}`}
              >
                Lock in {formatRemaining(remaining)}
              </span>
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
            </>
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
