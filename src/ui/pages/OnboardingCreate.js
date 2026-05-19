import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { cryptoWorker } from "../../crypto/worker-client";
import { passwordStrength } from "../../lib/validate";
export default function OnboardingCreate() {
    const navigate = useNavigate();
    const [step, setStep] = useState("generate");
    const [strength, setStrength] = useState(128);
    const [mnemonic, setMnemonic] = useState("");
    const [canContinue, setCanContinue] = useState(false);
    const [verifyInputs, setVerifyInputs] = useState({
        w3: "",
        w7: "",
        w11: "",
    });
    const [verifyAttempts, setVerifyAttempts] = useState(0);
    const [password, setPassword] = useState("");
    const [passwordConfirm, setPasswordConfirm] = useState("");
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [addresses, setAddresses] = useState(null);
    // Generate mnemonic on mount (and on strength change).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const out = await cryptoWorker.call("generateMnemonic", { strength });
                if (!cancelled) {
                    setMnemonic(out.mnemonic);
                    setCanContinue(false);
                    const t = setTimeout(() => setCanContinue(true), 5000);
                    return () => clearTimeout(t);
                }
            }
            catch (e) {
                setError(String(e));
            }
            return undefined;
        })();
        return () => {
            cancelled = true;
        };
    }, [strength]);
    const words = useMemo(() => mnemonic.split(/\s+/).filter(Boolean), [mnemonic]);
    const pwStrength = useMemo(() => passwordStrength(password), [password]);
    function checkVerify() {
        return (verifyInputs.w3.trim().toLowerCase() === words[2] &&
            verifyInputs.w7.trim().toLowerCase() === words[6] &&
            verifyInputs.w11.trim().toLowerCase() === words[10]);
    }
    async function submit() {
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
        setError(null);
        try {
            // We already have a mnemonic from step 1 — use restoreWallet path to preserve it.
            // But useWallet.createWallet generates a fresh one. To use the user-displayed mnemonic,
            // we call restoreWallet (which accepts a mnemonic).
            const out = await useWallet
                .getState()
                .restoreWallet(mnemonic, password);
            setAddresses(out.addresses);
            setStep("done");
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    }
    if (step === "generate") {
        return (_jsxs("div", { className: "mx-auto max-w-md px-4 py-8", children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Your new wallet is ready." }), _jsx("p", { className: "mt-2 text-sm text-ink-500", children: "Write these words down on paper and store them somewhere safe. Anyone with these words controls your wallet." }), _jsxs("div", { className: "mt-4 flex items-center gap-3 text-sm", children: [_jsx("span", { children: "Phrase length:" }), _jsxs("label", { className: "flex items-center gap-1", children: [_jsx("input", { type: "radio", checked: strength === 128, onChange: () => setStrength(128) }), "12 words"] }), _jsxs("label", { className: "flex items-center gap-1", children: [_jsx("input", { type: "radio", checked: strength === 256, onChange: () => setStrength(256) }), "24 words"] })] }), _jsx("div", { className: "card mt-4", children: _jsx("ol", { className: "grid grid-cols-3 gap-3 font-mono text-sm", children: words.map((w, i) => (_jsxs("li", { className: "flex items-baseline gap-2", children: [_jsxs("span", { className: "w-6 text-right text-xs text-ink-400", children: [i + 1, "."] }), _jsx("span", { children: w })] }, i))) }) }), _jsx("p", { className: "mt-3 text-xs text-ink-500", children: "Writing down is safer. Clipboard can be read by malware." }), _jsx("div", { className: "mt-6 flex gap-3", children: _jsx("button", { type: "button", disabled: !canContinue || words.length === 0, onClick: () => setStep("verify"), className: "btn-primary flex-1", children: canContinue ? "I've written it down" : "Look carefully..." }) })] }));
    }
    if (step === "verify") {
        return (_jsxs("div", { className: "mx-auto max-w-md px-4 py-8", children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Confirm your phrase." }), _jsx("p", { className: "mt-2 text-sm text-ink-500", children: "Type words 3, 7, and 11 below." }), _jsx("div", { className: "mt-4 flex flex-col gap-3", children: [
                        { key: "w3", n: 3 },
                        { key: "w7", n: 7 },
                        { key: "w11", n: 11 },
                    ].map((row) => (_jsxs("label", { className: "block", children: [_jsxs("span", { className: "label", children: ["Word #", row.n] }), _jsx("input", { className: "input", autoComplete: "off", autoCapitalize: "off", spellCheck: false, value: verifyInputs[row.key], onChange: (e) => setVerifyInputs((p) => ({ ...p, [row.key]: e.target.value })) })] }, row.key))) }), verifyAttempts > 0 && !checkVerify() && (_jsx("p", { className: "mt-3 text-sm text-red-600", children: "Words don't match. Check what you wrote down." })), _jsxs("div", { className: "mt-6 flex gap-3", children: [_jsx("button", { type: "button", onClick: () => setStep("generate"), className: "btn-secondary", children: "Back" }), _jsx("button", { type: "button", onClick: () => {
                                if (checkVerify())
                                    setStep("password");
                                else
                                    setVerifyAttempts((a) => a + 1);
                            }, className: "btn-primary flex-1", children: "Continue" })] })] }));
    }
    if (step === "password") {
        return (_jsxs("div", { className: "mx-auto max-w-md px-4 py-8", children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Set an unlock password." }), _jsx("p", { className: "mt-2 text-sm text-ink-500", children: "This password protects your wallet on this device. It's separate from your recovery phrase. If you forget the password, restore from the recovery phrase. If you lose both, your funds are gone." }), _jsxs("div", { className: "mt-4 flex flex-col gap-3", children: [_jsxs("label", { className: "block", children: [_jsx("span", { className: "label", children: "Password" }), _jsx("input", { className: "input", type: "password", autoComplete: "new-password", value: password, onChange: (e) => setPassword(e.target.value) }), _jsxs("span", { className: "mt-1 block text-xs text-ink-500", children: ["Strength: ", pwStrength.label] })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "label", children: "Confirm password" }), _jsx("input", { className: "input", type: "password", autoComplete: "new-password", value: passwordConfirm, onChange: (e) => setPasswordConfirm(e.target.value) })] }), _jsxs("label", { className: "mt-2 flex items-start gap-2 text-sm", children: [_jsx("input", { type: "checkbox", checked: acknowledged, onChange: (e) => setAcknowledged(e.target.checked), className: "mt-1" }), _jsx("span", { children: "I understand there is no recovery. If I lose my recovery phrase, my funds are gone." })] })] }), error && _jsx("p", { className: "mt-3 text-sm text-red-600", children: error }), _jsxs("div", { className: "mt-6 flex gap-3", children: [_jsx("button", { type: "button", onClick: () => setStep("verify"), className: "btn-secondary", children: "Back" }), _jsx("button", { type: "button", disabled: busy, onClick: submit, className: "btn-primary flex-1", children: busy ? "Creating..." : "Create wallet" })] })] }));
    }
    // done
    return (_jsxs("div", { className: "mx-auto max-w-md px-4 py-8", children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Wallet created." }), _jsxs("div", { className: "card mt-6 space-y-3 text-sm", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs text-ink-500", children: "Your Pearl address" }), _jsx("div", { className: "break-all font-mono", children: addresses?.pearl })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs text-ink-500", children: "Your Ethereum address (for WPRL)" }), _jsx("div", { className: "break-all font-mono", children: addresses?.eth })] })] }), _jsx("button", { type: "button", onClick: () => navigate("/dashboard"), className: "btn-primary mt-6 w-full", children: "Open dashboard" })] }));
}
