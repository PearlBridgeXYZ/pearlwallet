import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link, useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
export default function TopBar() {
    const navigate = useNavigate();
    const status = useWallet((s) => s.status);
    const net = useWallet((s) => s.pearlNetwork);
    const lock = useWallet((s) => s.lock);
    return (_jsx("header", { className: "border-b border-ink-200 bg-white/80 backdrop-blur dark:border-ink-800 dark:bg-ink-950/80", children: _jsxs("div", { className: "mx-auto flex max-w-2xl items-center justify-between px-4 py-3", children: [_jsxs(Link, { to: "/dashboard", className: "flex items-center gap-2", children: [_jsx("div", { className: "h-7 w-7 rounded-full bg-gradient-to-br from-pearl-100 via-pearl-300 to-pearl-800" }), _jsx("span", { className: "text-sm font-semibold tracking-tight", children: "Pearl Wallet" })] }), _jsxs("div", { className: "flex items-center gap-3 text-xs", children: [_jsx("span", { className: net === "mainnet"
                                ? "rounded-full bg-emerald-100 px-2 py-1 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                                : "rounded-full bg-amber-100 px-2 py-1 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300", children: net }), status === "unlocked" && (_jsx("button", { type: "button", className: "text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100", onClick: async () => {
                                await lock();
                                navigate("/unlock");
                            }, "aria-label": "Lock wallet", children: "Lock" })), _jsx(Link, { to: "/settings", className: "text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100", children: "Settings" })] })] }) }));
}
