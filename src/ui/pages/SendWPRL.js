import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { validEth } from "../../lib/validate";
import { formatWei, parseWPRL } from "../../lib/format";
const GAS_BY_TIER = {
    low: "1 gwei",
    normal: "2 gwei",
    high: "3 gwei",
};
export default function SendWPRL() {
    const navigate = useNavigate();
    const mockMode = useUI((s) => s.mockMode);
    const [destination, setDestination] = useState("");
    const [amount, setAmount] = useState("");
    const [tier, setTier] = useState("normal");
    const [password, setPassword] = useState("");
    const [stage, setStage] = useState("compose");
    const [error, setError] = useState(null);
    const [txHash, setTxHash] = useState(null);
    function validate() {
        if (!validEth(destination)) {
            setError("That doesn't look like a valid Ethereum address.");
            return null;
        }
        let wei;
        try {
            wei = parseWPRL(amount);
        }
        catch {
            setError("Enter a valid WPRL amount.");
            return null;
        }
        if (wei <= 0n) {
            setError("Amount must be greater than 0.");
            return null;
        }
        setError(null);
        return { dest: destination.trim(), wei };
    }
    async function broadcast() {
        if (!mockMode) {
            setError("Live Eth send not wired yet (gated on Q4/Q5 in docs/11).");
            return;
        }
        if (password.length < 1) {
            setError("Enter your password to authorize the send.");
            return;
        }
        await new Promise((r) => setTimeout(r, 800));
        setTxHash("0x" + Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64));
        setStage("sent");
    }
    if (stage === "sent") {
        return (_jsx(Page, { title: "Send WPRL", children: _jsxs("div", { className: "card", children: [_jsx("h2", { className: "text-lg font-semibold", children: "Broadcast." }), _jsxs("p", { className: "mt-2 text-sm", children: ["Tx hash: ", _jsx("span", { className: "break-all font-mono", children: txHash })] }), _jsx("button", { onClick: () => navigate("/dashboard"), className: "btn-primary mt-4 w-full", children: "Back to dashboard" })] }) }));
    }
    if (stage === "preview") {
        const v = validate();
        return (_jsx(Page, { title: "Send WPRL", children: _jsxs("div", { className: "card", children: [_jsx("h2", { className: "text-lg font-semibold", children: "Confirm" }), _jsxs("dl", { className: "mt-3 space-y-2 text-sm", children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("dt", { className: "text-ink-500", children: "To" }), _jsx("dd", { className: "break-all font-mono", children: v?.dest })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("dt", { className: "text-ink-500", children: "Amount" }), _jsxs("dd", { children: [v ? formatWei(v.wei) : "—", " WPRL"] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("dt", { className: "text-ink-500", children: "Gas tier" }), _jsxs("dd", { children: [tier, " (", GAS_BY_TIER[tier], " priority)"] })] })] }), _jsx("p", { className: "mt-4 text-sm text-amber-700 dark:text-amber-400", children: "This cannot be undone." }), _jsxs("label", { className: "mt-4 block", children: [_jsx("span", { className: "label", children: "Password (re-confirm)" }), _jsx("input", { className: "input", type: "password", autoComplete: "current-password", value: password, onChange: (e) => setPassword(e.target.value) })] }), error && _jsx("p", { className: "mt-2 text-sm text-red-600", children: error }), _jsxs("div", { className: "mt-4 flex gap-2", children: [_jsx("button", { onClick: () => setStage("compose"), className: "btn-secondary", children: "Back" }), _jsx("button", { onClick: broadcast, className: "btn-primary flex-1", children: "Send" })] })] }) }));
    }
    return (_jsx(Page, { title: "Send WPRL", children: _jsxs("div", { className: "card flex flex-col gap-3", children: [_jsxs("label", { className: "block", children: [_jsx("span", { className: "label", children: "Destination address" }), _jsx("input", { className: "input mono", placeholder: "0x...", value: destination, autoComplete: "off", autoCapitalize: "off", spellCheck: false, onChange: (e) => setDestination(e.target.value) })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "label", children: "Amount (WPRL)" }), _jsx("input", { className: "input mono", inputMode: "decimal", value: amount, onChange: (e) => setAmount(e.target.value) })] }), _jsxs("fieldset", { children: [_jsx("legend", { className: "label", children: "Gas tier" }), _jsx("div", { className: "grid grid-cols-3 gap-2", children: ["low", "normal", "high"].map((t) => (_jsxs("label", { className: tier === t
                                    ? "cursor-pointer rounded-xl border-2 border-pearl-700 bg-pearl-50 p-3 text-center text-sm dark:bg-pearl-900/30"
                                    : "cursor-pointer rounded-xl border border-ink-300 p-3 text-center text-sm dark:border-ink-700", children: [_jsx("input", { type: "radio", className: "sr-only", checked: tier === t, onChange: () => setTier(t) }), _jsx("div", { className: "font-medium capitalize", children: t }), _jsx("div", { className: "text-xs text-ink-500", children: GAS_BY_TIER[t] })] }, t))) })] }), error && _jsx("p", { className: "text-sm text-red-600", children: error }), _jsx("button", { onClick: () => {
                        if (validate())
                            setStage("preview");
                    }, className: "btn-primary", children: "Review" })] }) }));
}
