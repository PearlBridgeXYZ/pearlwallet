import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useWallet } from "./state/wallet-store";
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

export default function App() {
  const init = useWallet((s) => s.init);
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);
  const lastActivity = useWallet((s) => s.lastActivity);
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

  // Auto-lock after 5 minutes idle.
  useEffect(() => {
    if (status !== "unlocked") return;
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > 5 * 60 * 1000) {
        void lock();
        navigate("/unlock");
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [status, lastActivity, lock, navigate]);

  // Auto-route on status change.
  useEffect(() => {
    const path = location.pathname;
    if (status === "no-wallet" && !path.startsWith("/onboarding") && path !== "/") {
      navigate("/", { replace: true });
    } else if (status === "locked" && path !== "/unlock" && !path.startsWith("/onboarding")) {
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
  );
}
