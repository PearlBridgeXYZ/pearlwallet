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
    <header
      className="sticky top-0 z-30 border-b border-ink-200 bg-white/80 backdrop-blur dark:border-ink-800 dark:bg-ink-950/80"
      // Push the bar content below the iOS notch / Android status bar.
      // The bar itself spans edge-to-edge (the bg-color extends into
      // the safe area to avoid a jarring strip).
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div
        className="mx-auto flex max-w-2xl items-center justify-between gap-2 py-3"
        style={{
          paddingLeft: "max(1rem, env(safe-area-inset-left))",
          paddingRight: "max(1rem, env(safe-area-inset-right))",
        }}
      >
        <Link to="/dashboard" className="flex min-w-0 items-center gap-2">
          <img
            src="/logo-192.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-full"
          />
          <span className="truncate text-sm font-semibold tracking-tight">PearlWallet</span>
        </Link>
        <div className="flex shrink-0 items-center gap-1 text-xs sm:gap-3">
          {status === "unlocked" && (
            <>
              {/* Countdown — visible label on sm+, icon-only on narrow */}
              <span
                className={
                  warning
                    ? "tabular-nums text-amber-600 dark:text-amber-400"
                    : "tabular-nums text-ink-500 dark:text-ink-400"
                }
                title="Time until automatic lock from inactivity"
                aria-label={`Auto-lock in ${formatRemaining(remaining)}`}
              >
                <span className="hidden sm:inline">Lock in </span>
                {formatRemaining(remaining)}
              </span>
              <button
                type="button"
                className="rounded-md px-2 py-2 text-ink-500 hover:bg-ink-100 hover:text-ink-900 active:bg-ink-200 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-100"
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
            className="rounded-md px-2 py-2 text-ink-500 hover:bg-ink-100 hover:text-ink-900 active:bg-ink-200 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-100"
          >
            Settings
          </Link>
        </div>
      </div>
    </header>
  );
}
