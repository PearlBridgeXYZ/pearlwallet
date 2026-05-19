import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { cryptoWorker } from "../../crypto/worker-client";
import { passwordStrength } from "../../lib/validate";
export default function OnboardingRestore() {
    const navigate = useNavigate();
    const restore = useWallet((s) => s.restoreWallet);
    const [length, setLength] = useState(12);
    const [words, setWords] = useState(() => Array(12).fill(""));
    const [password, setPassword] = useState("");
    const [passwordConfirm, setPasswordConfirm] = useState("");
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const pwStrength = useMemo(() => passwordStrength(password), [password]);
    function setLen(n) {
        setLength(n);
        setWords((prev) => {
            const next = Array(n).fill("");
            for (let i = 0; i < Math.min(prev.length, n); i++)
                next[i] = prev[i] ?? "";
            return next;
        });
    }
    function setWord(i, v) {
        setWords((prev) => {
            const next = prev.slice();
            next[i] = v.trim().toLowerCase();
            return next;
        });
    }
    async function submit() {
        setError(null);
        const mnemonic = words.join(" ").trim();
        const v = await cryptoWorker.call("validateMnemonic", { mnemonic });
        if (!v.valid) {
            setError("That doesn't look like a valid BIP-39 phrase. Check the words.");
            return;
        }
        if (password.length < 10) {
            setError("Password must be at least 10 characters.");
            return;
        }
        if (password !== passwordConfirm) {
            setError("Passwords don't match.");
            return;
        }
        if (!acknowledged) {
            setError("Please confirm you understand there is no recovery.");
            return;
        }
        setBusy(true);
        try {
            await restore(mnemonic, password);
            navigate("/dashboard");
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    }
    return (_jsxs("div", { className: "mx-auto max-w-md px-4 py-8", children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Restore your wallet." }), _jsx("p", { className: "mt-2 text-sm text-ink-500", children: "Enter your 12- or 24-word recovery phrase. Words are masked by default." }), _jsxs("div", { className: "mt-4 flex items-center gap-3 text-sm", children: [_jsx("span", { children: "Phrase length:" }), _jsxs("label", { className: "flex items-center gap-1", children: [_jsx("input", { type: "radio", checked: length === 12, onChange: () => setLen(12) }), "12 words"] }), _jsxs("label", { className: "flex items-center gap-1", children: [_jsx("input", { type: "radio", checked: length === 24, onChange: () => setLen(24) }), "24 words"] })] }), _jsx("div", { className: "mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3", children: words.map((w, i) => (_jsxs("label", { className: "block", children: [_jsxs("span", { className: "label", children: ["#", i + 1] }), _jsx("input", { className: "input mono", type: "password", autoComplete: "off", autoCapitalize: "off", spellCheck: false, value: w, onChange: (e) => setWord(i, e.target.value) })] }, i))) }), _jsxs("div", { className: "mt-6 flex flex-col gap-3", children: [_jsxs("label", { className: "block", children: [_jsx("span", { className: "label", children: "Set an unlock password" }), _jsx("input", { className: "input", type: "password", autoComplete: "new-password", value: password, onChange: (e) => setPassword(e.target.value) }), _jsxs("span", { className: "mt-1 block text-xs text-ink-500", children: ["Strength: ", pwStrength.label] })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "label", children: "Confirm password" }), _jsx("input", { className: "input", type: "password", autoComplete: "new-password", value: passwordConfirm, onChange: (e) => setPasswordConfirm(e.target.value) })] }), _jsxs("label", { className: "mt-2 flex items-start gap-2 text-sm", children: [_jsx("input", { type: "checkbox", checked: acknowledged, onChange: (e) => setAcknowledged(e.target.checked), className: "mt-1" }), _jsx("span", { children: "I understand there is no recovery. If I lose my recovery phrase, my funds are gone." })] })] }), error && _jsx("p", { className: "mt-3 text-sm text-red-600", children: error }), _jsx("button", { type: "button", onClick: submit, disabled: busy, className: "btn-primary mt-6 w-full", children: busy ? "Restoring..." : "Restore wallet" })] }));
}
