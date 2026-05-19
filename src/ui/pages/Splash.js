import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { BUILD_GIT_SHA, BUILD_VERSION } from "../../build-info";
export default function Splash() {
    const status = useWallet((s) => s.status);
    const hasWallet = status !== "no-wallet";
    return (_jsx("div", { className: "flex min-h-full items-center justify-center px-6 py-10", children: _jsxs("div", { className: "w-full max-w-md text-center", children: [_jsx("div", { className: "mx-auto mb-6 h-20 w-20 rounded-full bg-gradient-to-br from-pearl-100 via-pearl-300 to-pearl-800 shadow-lg" }), _jsx("h1", { className: "text-3xl font-semibold tracking-tight", children: "Pearl Web Wallet" }), _jsx("p", { className: "mt-2 text-sm text-ink-500 dark:text-ink-400", children: "Non-custodial. PRL and WPRL in one place." }), _jsxs("div", { className: "mt-8 flex flex-col gap-2", children: [_jsx(Link, { to: "/onboarding/create", className: "btn-primary w-full", children: "Create a new wallet" }), _jsx(Link, { to: "/onboarding/restore", className: "btn-secondary w-full", children: "Restore from recovery phrase" }), hasWallet && (_jsx(Link, { to: "/unlock", className: "text-sm text-ink-500 underline-offset-2 hover:underline dark:text-ink-400", children: "Unlock existing wallet" }))] }), _jsxs("footer", { className: "mt-12 text-xs text-ink-400", children: ["v", BUILD_VERSION, " \u00B7 build ", BUILD_GIT_SHA] })] }) }));
}
