import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useWallet, AUTO_LOCK_MS, type WalletStatus } from "./state/wallet-store";
import { useUI } from "./state/ui-store";
import { monotonicNow } from "./lib/monotonic";
import Splash from "./ui/pages/Splash";
import OnboardingCreate from "./ui/pages/OnboardingCreate";
import OnboardingRestore from "./ui/pages/OnboardingRestore";
import Unlock from "./ui/pages/Unlock";
import Dashboard from "./ui/pages/Dashboard";
import Receive from "./ui/pages/Receive";
import SendPRL from "./ui/pages/SendPRL";
import SendWPRL from "./ui/pages/SendWPRL";
import SendETH from "./ui/pages/SendETH";
import Bridge from "./ui/pages/Bridge";
import History from "./ui/pages/History";
import Settings from "./ui/pages/Settings";
import About from "./ui/pages/About";
import Vaults from "./ui/pages/Vaults";
import CreateVault from "./ui/pages/CreateVault";
import VaultDetail from "./ui/pages/VaultDetail";
import SendFromVault from "./ui/pages/SendFromVault";
import SignMultisigPsbt from "./ui/pages/SignMultisigPsbt";
import VaultPendingTxDetail from "./ui/pages/VaultPendingTxDetail";
import Footer from "./ui/components/Footer";

/**
 * Pure routing-guard decision. Returns the path to redirect to, or
 * null if the current path is allowed for the given wallet status.
 *
 * Allowed-paths matrix:
 *   initializing → null (always allowed; init() will resolve shortly)
 *   no-wallet    → "/" and "/onboarding/*"
 *   locked       → "/unlock" and "/onboarding/restore"
 *                  (the latter is the documented forgot-password path
 *                   — overwriting requires the seed, so a locked user
 *                   may reach it. Everything else must unlock first.)
 *   unlocked     → everything EXCEPT "/", "/unlock", "/onboarding/*"
 *                  (those bounce to /dashboard so a logged-in user
 *                   doesn't see the login or onboarding screens)
 *
 * Exported so the routing matrix is unit-testable in isolation
 * (vitest runs node-env, no jsdom/react-router needed).
 */
export function routeGuardTarget(
  status: WalletStatus,
  path: string,
): string | null {
  if (status === "initializing") return null;
  // Match "/onboarding" exactly OR "/onboarding/..." — NOT "/onboarding-fake"
  // or "/onboardingX". Belt-and-braces: the only routes the Routes
  // block exposes are `/onboarding/create` and `/onboarding/restore`,
  // so a typo-prefix would bounce on the catch-all anyway, but
  // keeping the matrix tight makes intent explicit.
  const isOnboarding =
    path === "/onboarding" || path.startsWith("/onboarding/");
  if (status === "no-wallet") {
    if (path === "/" || isOnboarding) return null;
    return "/";
  }
  if (status === "locked") {
    if (path === "/unlock" || path === "/onboarding/restore") return null;
    return "/unlock";
  }
  // unlocked
  if (path === "/" || path === "/unlock" || isOnboarding) {
    return "/dashboard";
  }
  return null;
}

export default function App() {
  const init = useWallet((s) => s.init);
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);
  const touch = useWallet((s) => s.touch);
  const theme = useUI((s) => s.theme);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    void init();
  }, [init]);

  // Apply theme class on root.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme === "dark") root.classList.add("dark");
    else if (theme === "light") root.classList.add("light");
  }, [theme]);

  // Activity-based idle tracking. Real user input (pointer, key, touch,
  // focus) bumps lastActivity, so an active user never auto-locks
  // mid-flow. Throttled to 1 Hz to avoid thrashing the store on
  // mousemove.
  //
  // Visibility-change is handled SEPARATELY (below). A naive
  // "if visible: bump()" lets a bystander revive a tab that's been
  // idle past the auto-lock window by clicking back into it — because
  // background-tab `setInterval` is throttled to ~1/min, the lock-poll
  // hasn't run yet when the visibility handler fires synchronously. So
  // we check elapsed-since-lastActivity FIRST and lock if expired,
  // BEFORE allowing the bump.
  useEffect(() => {
    if (status !== "unlocked") return;
    let lastBump = 0;
    const bump = () => {
      const now = monotonicNow();
      if (now - lastBump < 1000) return;
      lastBump = now;
      touch();
    };
    const events = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "focus"];
    for (const ev of events) window.addEventListener(ev, bump, { passive: true });
    const onVis = () => {
      if (document.hidden) return;
      // On revival, check whether the auto-lock window already elapsed
      // while we were backgrounded. If so, lock first, don't bump.
      // monotonicNow() — Date.now() would let a backward clock step (NTP,
      // VM-resume, hostile OS) trick this check into negative elapsed.
      const since = monotonicNow() - useWallet.getState().lastActivity;
      if (since > AUTO_LOCK_MS) {
        // v0.2.4 (SEC fix): await lock() before navigate. The previous
        // `void lock(); navigate(...)` shape let the navigate land
        // before status flipped to "locked", which made the route guard
        // see status="unlocked" && path="/unlock" and bounce back to
        // /dashboard — exposing a brief render window with addresses
        // still populated and useQuery firing on stale derivation.
        void (async () => {
          await lock();
          navigate("/unlock");
        })();
        return;
      }
      bump();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      for (const ev of events) window.removeEventListener(ev, bump);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [status, touch, lock, navigate]);

  // Auto-lock poll. Reads lastActivity from the store each tick so we
  // don't need the effect to re-run on every bump (which would tear
  // down/restore the activity listeners 60×/min).
  useEffect(() => {
    if (status !== "unlocked") return;
    const timer = setInterval(() => {
      const since = monotonicNow() - useWallet.getState().lastActivity;
      if (since > AUTO_LOCK_MS) {
        // v0.2.4 (SEC fix): await lock() before navigate — see onVis
        // comment for the same rationale. Without this the route guard
        // momentarily sees an "unlocked" tab on /unlock and re-routes
        // back to /dashboard.
        void (async () => {
          await lock();
          navigate("/unlock");
        })();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status, lock, navigate]);

  // Auto-route on status OR navigation. Skip while "initializing" — we
  // don't know yet whether a keystore exists and any navigate() call
  // here would just bounce the user once init() resolves and the real
  // status arrives.
  //
  // v0.2.4 (SEC fix): deps now include location.pathname. The previous
  // [status]-only deps let a locked user click any <Link to=...> and
  // land on the target page without re-firing the guard, since location
  // changes don't change status. Concretely: clicking "Wipe this wallet"
  // on /unlock navigated to /settings while still locked, and from
  // there the TopBar logo (Link to /dashboard) revealed the full
  // wallet surface without a password. The fix re-checks on every nav.
  useEffect(() => {
    const target = routeGuardTarget(status, location.pathname);
    if (target !== null) navigate(target, { replace: true });
  }, [status, location.pathname, navigate]);

  // v0.2.0: bounce eth-only routes when the user has the Ethereum
  // surface turned off in Settings. Deep links, stale bookmarks, and
  // back-button from a session that flipped the toggle off all land on
  // /dashboard rather than presenting a half-broken surface. The toggle
  // is also re-checked inside each individual eth-only page as
  // belt-and-braces (the SendETH / SendWPRL / Bridge pages each
  // useEffect-bounce on !ethEnabled).
  useEffect(() => {
    if (status !== "unlocked") return;
    if (ethEnabled) return;
    const path = location.pathname;
    if (
      path === "/send/wprl" ||
      path === "/send/eth" ||
      path === "/bridge"
    ) {
      navigate("/dashboard", { replace: true });
    }
  }, [ethEnabled, status, location.pathname, navigate]);

  // Same belt-and-braces for the multisig surface. Each multisig page
  // already useEffect-bounces on !multisigEnabled, but catching it here
  // prevents a brief render flash of the wrong page on a deep-link.
  useEffect(() => {
    if (status !== "unlocked") return;
    if (multisigEnabled) return;
    if (location.pathname.startsWith("/vaults")) {
      navigate("/dashboard", { replace: true });
    }
  }, [multisigEnabled, status, location.pathname, navigate]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Routes>
          <Route path="/" element={<Splash />} />
          <Route path="/onboarding/create" element={<OnboardingCreate />} />
          <Route path="/onboarding/restore" element={<OnboardingRestore />} />
          <Route path="/unlock" element={<Unlock />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/send/prl" element={<SendPRL />} />
          <Route path="/send/wprl" element={<SendWPRL />} />
          <Route path="/send/eth" element={<SendETH />} />
          <Route path="/bridge" element={<Bridge />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/about" element={<About />} />
          <Route path="/vaults" element={<Vaults />} />
          <Route path="/vaults/new" element={<CreateVault />} />
          <Route path="/vaults/sign" element={<SignMultisigPsbt />} />
          <Route path="/vaults/:id" element={<VaultDetail />} />
          <Route path="/vaults/:id/send" element={<SendFromVault />} />
          <Route path="/vaults/:id/tx/:txid" element={<VaultPendingTxDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <Footer />
    </div>
  );
}
