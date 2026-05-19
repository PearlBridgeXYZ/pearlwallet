import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
        if (theme === "dark")
            root.classList.add("dark");
        else if (theme === "light")
            root.classList.add("light");
    }, [theme]);
    // Auto-lock after 5 minutes idle.
    useEffect(() => {
        if (status !== "unlocked")
            return;
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
        }
        else if (status === "locked" && path !== "/unlock" && !path.startsWith("/onboarding")) {
            navigate("/unlock", { replace: true });
        }
        else if (status === "unlocked" &&
            (path === "/" || path === "/unlock" || path.startsWith("/onboarding"))) {
            navigate("/dashboard", { replace: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Splash, {}) }), _jsx(Route, { path: "/onboarding/create", element: _jsx(OnboardingCreate, {}) }), _jsx(Route, { path: "/onboarding/restore", element: _jsx(OnboardingRestore, {}) }), _jsx(Route, { path: "/unlock", element: _jsx(Unlock, {}) }), _jsx(Route, { path: "/dashboard", element: _jsx(Dashboard, {}) }), _jsx(Route, { path: "/receive", element: _jsx(Receive, {}) }), _jsx(Route, { path: "/send/prl", element: _jsx(SendPRL, {}) }), _jsx(Route, { path: "/send/wprl", element: _jsx(SendWPRL, {}) }), _jsx(Route, { path: "/bridge", element: _jsx(Bridge, {}) }), _jsx(Route, { path: "/history", element: _jsx(History, {}) }), _jsx(Route, { path: "/settings", element: _jsx(Settings, {}) }), _jsx(Route, { path: "/about", element: _jsx(About, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }));
}
