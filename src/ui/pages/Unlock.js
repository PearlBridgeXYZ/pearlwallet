import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
export default function Unlock() {
    const navigate = useNavigate();
    const unlock = useWallet((s) => s.unlock);
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await unlock(password);
            navigate("/dashboard");
        }
        catch (e) {
            setError(e instanceof Error && e.message === "E_PASSWORD_WRONG"
                ? "Incorrect password."
                : e instanceof Error ? e.message : "Unlock failed.");
        }
        finally {
            setBusy(false);
        }
    }
    return (_jsx("div", { className: "flex min-h-full items-center justify-center px-4 py-8", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Welcome back." }), _jsxs("form", { onSubmit: submit, className: "mt-6 flex flex-col gap-3", children: [_jsxs("label", { className: "block", children: [_jsx("span", { className: "label", children: "Password" }), _jsx("input", { className: "input", type: "password", autoFocus: true, autoComplete: "current-password", value: password, onChange: (e) => setPassword(e.target.value) })] }), error && _jsx("p", { className: "text-sm text-red-600", children: error }), _jsx("button", { type: "submit", disabled: busy, className: "btn-primary w-full", children: busy ? "Unlocking..." : "Unlock" })] }), _jsxs("div", { className: "mt-6 flex flex-col gap-2 text-sm", children: [_jsx(Link, { to: "/onboarding/restore", className: "text-pearl-700 hover:underline", children: "Wrong password? Restore from recovery phrase" }), _jsx(Link, { to: "/settings", className: "text-ink-500 hover:underline", children: "Wipe this wallet" })] })] }) }));
}
