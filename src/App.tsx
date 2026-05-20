import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useWallet, AUTO_LOCK_MS } from "./state/wallet-store";
import { useUI } from "./state/ui-store";
import Splash from "./ui/pages/Splash";
import OnboardingCreate from "./ui/pages/OnboardingCreate";
import OnboardingRestore from "./ui/pages/OnboardingRestore";
import Unlock from "./ui/pages/Unlock";
import Dashboard from "./ui/pages/Dashboard";
import Receive from "./ui/pages/Receive";
import SendPRL from "./ui/pages/SendPRL";
import SendWPRL from "./ui/pages/SendWPRL";
import Bridge from "./ui/pages/Bridge";
import History from "./ui/pages/History";
import Settings from "./ui/pages/Settings";
import About from "./ui/pages/About";
import Footer from "./ui/components/Footer";

export default function App() {
  const init = useWallet((s) => s.init);
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);
  const touch = useWallet((s) => s.touch);
  const theme = useUI((s) => s.theme);
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

  // Activity-based idle tracking. Before v0.1.6 the auto-lock was fixed:
  // 5 min after unlock, regardless of whether the user was actively
  // using the wallet. Now real user input (pointer, key, touch, focus,
  // visibility-change) bumps lastActivity, so an active typing/clicking
  // user never auto-locks mid-flow. Throttled to once per second to
  // avoid thrashing the Zustand store on mousemove.
  useEffect(() => {
    if (status !== "unlocked") return;
    let lastBump = 0;
    const bump = () => {
      const now = Date.now();
      if (now - lastBump < 1000) return;
      lastBump = now;
      touch();
    };
    const events = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "focus"];
    for (const ev of events) window.addEventListener(ev, bump, { passive: true });
    const onVis = () => { if (!document.hidden) bump(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      for (const ev of events) window.removeEventListener(ev, bump);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [status, touch]);

  // Auto-lock poll. Reads lastActivity from the store each tick so we
  // don't need the effect to re-run on every bump (which would tear
  // down/restore the activity listeners 60×/min).
  useEffect(() => {
    if (status !== "unlocked") return;
    const timer = setInterval(() => {
      const since = Date.now() - useWallet.getState().lastActivity;
      if (since > AUTO_LOCK_MS) {
        void lock();
        navigate("/unlock");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status, lock, navigate]);

  // Auto-route on status change.
  useEffect(() => {
    const path = location.pathname;
    if (status === "no-wallet" && !path.startsWith("/onboarding") && path !== "/") {
      navigate("/", { replace: true });
    } else if (status === "locked" && path !== "/unlock") {
      // v0.1.6: also bounce locked users off /onboarding/*. Pre-fix, a
      // locked user could deep-link to /onboarding/create and overwrite
      // the existing keystore. The store-level E_WALLET_EXISTS guard now
      // catches that, but it's cleaner to never present the form at all.
      navigate("/unlock", { replace: true });
    } else if (
      status === "unlocked" &&
      (path === "/" || path === "/unlock" || path.startsWith("/onboarding"))
    ) {
      navigate("/dashboard", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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
          <Route path="/bridge" element={<Bridge />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <Footer />
    </div>
  );
}
