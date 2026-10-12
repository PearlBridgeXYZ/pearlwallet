import { useEffect, useState } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { AUTO_LOCK_MS } from "../../state/wallet-store";
import { monotonicNow } from "../../lib/monotonic";

import { useUI } from "../../state/ui-store";

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function TopBar() {
  const navigate = useNavigate();
  const sending = useMatch("/send/*");
  const ethEnabled = useUI((s) => s.ethEnabled);
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
    <header className="wallet-header">
      <div className="shell-width wallet-header-inner">
        <Link to={status === "unlocked" ? "/dashboard" : "/"} className="tap flex min-w-0 items-center gap-2" aria-label="PearlWallet home">
          <span className="wallet-wordmark">pearlwallet<span className="text-accent" aria-hidden="true">_</span></span>
        </Link>
        {status === "unlocked" && (
          <nav className="wallet-nav" aria-label="Wallet">
            <NavLink to="/dashboard">Home</NavLink>
            <Link to="/send/prl" aria-current={sending ? "page" : undefined}>Send</Link>
            <NavLink to="/receive">Receive</NavLink>
            {ethEnabled && <NavLink to="/bridge">Bridge</NavLink>}
            <NavLink to="/history">Activity</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
        )}
        <div className="flex shrink-0 items-center gap-1 text-xs sm:gap-3">
          {status === "unlocked" && (
            <>
              {/* Keep the idle countdown visible without live-region announcements. */}
              <span
                className={
                  warning
                    ? "tabular-nums text-warn"
                    : "tabular-nums text-text-3"
                }
                title="Time until automatic lock from inactivity"
                aria-label={`Auto-lock in ${formatRemaining(remaining)}`}
              >
                <span className="hidden sm:inline">Lock in </span>
                {formatRemaining(remaining)}
              </span>
              <button
                type="button"
                className="btn-secondary px-3"
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
        </div>
      </div>
    </header>
  );
}
