import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
export default function Settings() {
    const navigate = useNavigate();
    const status = useWallet((s) => s.status);
    const lock = useWallet((s) => s.lock);
    const wipe = useWallet((s) => s.wipe);
    const exportMnemonic = useWallet((s) => s.exportMnemonic);
    const changePassword = useWallet((s) => s.changePassword);
    const pearlNetwork = useWallet((s) => s.pearlNetwork);
    const setPearlNetwork = useWallet((s) => s.setPearlNetwork);
    const theme = useUI((s) => s.theme);
    const setTheme = useUI((s) => s.setTheme);
    const mockMode = useUI((s) => s.mockMode);
    const setMockMode = useUI((s) => s.setMockMode);
    const [showMnemonic, setShowMnemonic] = useState(false);
    const [mnemonicValue, setMnemonicValue] = useState(null);
    const [pwExport, setPwExport] = useState("");
    const [oldPw, setOldPw] = useState("");
    const [newPw, setNewPw] = useState("");
    const [newPw2, setNewPw2] = useState("");
    const [wipePhrase, setWipePhrase] = useState("");
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    async function doExport() {
        setError(null);
        try {
            const mnemonic = await exportMnemonic(pwExport);
            setMnemonicValue(mnemonic);
            setShowMnemonic(true);
        }
        catch (e) {
            setError(e instanceof Error && e.message === "E_PASSWORD_WRONG"
                ? "Incorrect password."
                : e instanceof Error ? e.message : "Export failed.");
        }
    }
    async function doChangePassword() {
        setError(null);
        setSuccess(null);
        if (newPw !== newPw2) {
            setError("New passwords don't match.");
            return;
        }
        if (newPw.length < 10) {
            setError("New password must be at least 10 characters.");
            return;
        }
        try {
            await changePassword(oldPw, newPw);
            setSuccess("Password changed.");
            setOldPw("");
            setNewPw("");
            setNewPw2("");
        }
        catch (e) {
            setError(e instanceof Error && e.message === "E_PASSWORD_WRONG"
                ? "Incorrect current password."
                : e instanceof Error ? e.message : "Change failed.");
        }
    }
    async function doWipe() {
        if (wipePhrase.trim().toLowerCase() !== "wipe my wallet") {
            setError('Type "wipe my wallet" exactly to confirm.');
            return;
        }
        await wipe();
        navigate("/");
    }
    return (_jsxs(Page, { title: "Settings", children: [_jsxs("section", { className: "card mb-4", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Account" }), _jsx("div", { className: "mt-3 flex flex-wrap gap-2", children: _jsx("button", { disabled: status !== "unlocked", onClick: async () => {
                                await lock();
                                navigate("/unlock");
                            }, className: "btn-secondary", children: "Lock now" }) })] }), _jsxs("section", { className: "card mb-4", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Change password" }), _jsxs("div", { className: "mt-3 flex flex-col gap-2", children: [_jsx("input", { className: "input", type: "password", placeholder: "Current password", value: oldPw, onChange: (e) => setOldPw(e.target.value) }), _jsx("input", { className: "input", type: "password", placeholder: "New password", value: newPw, onChange: (e) => setNewPw(e.target.value) }), _jsx("input", { className: "input", type: "password", placeholder: "Confirm new password", value: newPw2, onChange: (e) => setNewPw2(e.target.value) }), _jsx("button", { onClick: doChangePassword, className: "btn-primary self-start", children: "Change password" })] })] }), _jsxs("section", { className: "card mb-4", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Export recovery phrase" }), _jsx("p", { className: "mt-2 text-xs text-ink-500", children: "Re-enter your password to view your 12-word phrase. Never share it. Never enter it on any website." }), _jsxs("div", { className: "mt-3 flex gap-2", children: [_jsx("input", { className: "input", type: "password", placeholder: "Password", value: pwExport, onChange: (e) => setPwExport(e.target.value) }), _jsx("button", { onClick: doExport, className: "btn-secondary", children: "Show" })] }), showMnemonic && mnemonicValue && (_jsxs("div", { className: "card mt-3 bg-amber-50 dark:bg-amber-900/20", children: [_jsx("p", { className: "text-xs text-amber-700 dark:text-amber-400", children: "Don't screenshot this. Write it down." }), _jsx("pre", { className: "mt-2 whitespace-pre-wrap break-words font-mono text-sm", children: mnemonicValue }), _jsx("button", { onClick: () => {
                                    setShowMnemonic(false);
                                    setMnemonicValue(null);
                                    setPwExport("");
                                }, className: "btn-secondary mt-3", children: "Hide" })] }))] }), _jsxs("section", { className: "card mb-4", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Network" }), _jsxs("div", { className: "mt-3 flex items-center gap-3 text-sm", children: [_jsx("span", { children: "Pearl L1:" }), _jsxs("label", { className: "flex items-center gap-1", children: [_jsx("input", { type: "radio", checked: pearlNetwork === "mainnet", onChange: () => setPearlNetwork("mainnet") }), "Mainnet"] }), _jsxs("label", { className: "flex items-center gap-1", children: [_jsx("input", { type: "radio", checked: pearlNetwork === "testnet", onChange: () => setPearlNetwork("testnet") }), "Testnet"] })] })] }), _jsxs("section", { className: "card mb-4", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Display" }), _jsxs("div", { className: "mt-3 flex items-center gap-3 text-sm", children: [_jsx("span", { children: "Theme:" }), ["system", "light", "dark"].map((t) => (_jsxs("label", { className: "flex items-center gap-1 capitalize", children: [_jsx("input", { type: "radio", checked: theme === t, onChange: () => setTheme(t) }), t] }, t)))] })] }), _jsxs("section", { className: "card mb-4", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Developer" }), _jsxs("label", { className: "mt-3 flex items-center gap-2 text-sm", children: [_jsx("input", { type: "checkbox", checked: mockMode, onChange: (e) => setMockMode(e.target.checked) }), "Mock mode (balances + send + bridge are simulated until live RPCs are wired)"] })] }), _jsxs("section", { className: "card mb-4 border-red-200 dark:border-red-900/40", children: [_jsx("h2", { className: "text-sm font-semibold text-red-700 dark:text-red-400", children: "Danger zone" }), _jsx("p", { className: "mt-2 text-xs text-ink-500", children: "Wiping the wallet from this browser deletes the encrypted keystore here. You'll need your recovery phrase to restore." }), _jsxs("div", { className: "mt-3 flex gap-2", children: [_jsx("input", { className: "input", placeholder: 'Type "wipe my wallet"', value: wipePhrase, onChange: (e) => setWipePhrase(e.target.value) }), _jsx("button", { onClick: doWipe, className: "btn-danger", children: "Wipe" })] })] }), error && _jsx("p", { className: "text-sm text-red-600", children: error }), success && _jsx("p", { className: "text-sm text-emerald-700", children: success })] }));
}
