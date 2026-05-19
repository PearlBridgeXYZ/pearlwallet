import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { formatGrains, formatWei, parsePRL, parseWPRL, shortAddr } from "../../lib/format";
const MINT_FEE_BPS = 50; // 0.5% — placeholder until contracts.ts populated.
const BURN_FEE_BPS = 50;
export default function Bridge() {
    const navigate = useNavigate();
    const addresses = useWallet((s) => s.addresses);
    const mockMode = useUI((s) => s.mockMode);
    const [direction, setDirection] = useState("prl-to-wprl");
    const [amount, setAmount] = useState("");
    const [password, setPassword] = useState("");
    const [step, setStep] = useState("compose");
    const [error, setError] = useState(null);
    const [statusStep, setStatusStep] = useState(0);
    const isPrlSide = direction === "prl-to-wprl";
    const symbol = isPrlSide ? "PRL" : "WPRL";
    const recvSymbol = isPrlSide ? "WPRL" : "PRL";
    const preview = useMemo(() => {
        try {
            if (!amount.trim())
                return null;
            const native = isPrlSide ? parsePRL(amount) : parseWPRL(amount);
            const feeBps = BigInt(isPrlSide ? MINT_FEE_BPS : BURN_FEE_BPS);
            const fee = (native * feeBps) / 10000n;
            const recv = native - fee;
            return { native, fee, recv };
        }
        catch {
            return null;
        }
    }, [amount, isPrlSide]);
    async function bridge() {
        if (!mockMode) {
            setError("Live bridge integration gated on docs/11 Q6 (relayer API) and Q4 (contract addresses).");
            return;
        }
        if (!password) {
            setError("Enter your password to authorize.");
            return;
        }
        setStep("status");
        // Mock the 3-step progression.
        setStatusStep(1);
        await new Promise((r) => setTimeout(r, 1500));
        setStatusStep(2);
        await new Promise((r) => setTimeout(r, 1500));
        setStatusStep(3);
    }
    if (step === "status") {
        const steps = isPrlSide
            ? ["Pearl deposit", "Relayer signature", "Eth mint"]
            : ["Eth burn", "Relayer signature", "Pearl release"];
        return (_jsx(Page, { title: "Bridge in progress", children: _jsxs("div", { className: "card", children: [_jsx("ol", { className: "space-y-3 text-sm", children: steps.map((label, i) => {
                            const done = statusStep > i;
                            const active = statusStep === i;
                            return (_jsxs("li", { className: "flex items-center gap-3", children: [_jsx("span", { className: done
                                            ? "h-6 w-6 rounded-full bg-emerald-600 text-center text-white"
                                            : active
                                                ? "h-6 w-6 animate-pulse rounded-full bg-pearl-600 text-center text-white"
                                                : "h-6 w-6 rounded-full border border-ink-300 text-center dark:border-ink-700", children: done ? "✓" : i + 1 }), _jsx("span", { className: done ? "text-ink-500 line-through" : "", children: label })] }, label));
                        }) }), _jsx("p", { className: "mt-4 text-xs text-ink-500", children: "Bridge actions can't be cancelled once broadcast." }), statusStep === 3 && (_jsx("button", { onClick: () => navigate("/dashboard"), className: "btn-primary mt-4 w-full", children: "Done" }))] }) }));
    }
    if (step === "preview" && preview) {
        return (_jsx(Page, { title: "Confirm bridge", children: _jsxs("div", { className: "card", children: [_jsxs("dl", { className: "space-y-2 text-sm", children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("dt", { className: "text-ink-500", children: "You send" }), _jsxs("dd", { children: [isPrlSide ? formatGrains(preview.native) : formatWei(preview.native), " ", symbol] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsxs("dt", { className: "text-ink-500", children: ["Bridge fee (", (isPrlSide ? MINT_FEE_BPS : BURN_FEE_BPS) / 100, "%)"] }), _jsxs("dd", { children: [isPrlSide ? formatGrains(preview.fee) : formatWei(preview.fee), " ", symbol] })] }), _jsxs("div", { className: "flex justify-between border-t border-ink-200 pt-2 dark:border-ink-700", children: [_jsx("dt", { className: "font-medium", children: "You receive" }), _jsxs("dd", { className: "font-medium", children: [isPrlSide ? formatGrains(preview.recv) : formatWei(preview.recv), " ", recvSymbol] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("dt", { className: "text-ink-500", children: "Recipient" }), _jsx("dd", { className: "break-all font-mono text-xs", children: isPrlSide
                                            ? addresses?.eth && shortAddr(addresses.eth, 8, 6)
                                            : addresses?.pearl && shortAddr(addresses.pearl, 12, 8) })] })] }), _jsx("p", { className: "mt-4 text-sm text-amber-700 dark:text-amber-400", children: "This cannot be undone." }), _jsxs("label", { className: "mt-4 block", children: [_jsx("span", { className: "label", children: "Password" }), _jsx("input", { className: "input", type: "password", autoComplete: "current-password", value: password, onChange: (e) => setPassword(e.target.value) })] }), error && _jsx("p", { className: "mt-2 text-sm text-red-600", children: error }), _jsxs("div", { className: "mt-4 flex gap-2", children: [_jsx("button", { onClick: () => setStep("compose"), className: "btn-secondary", children: "Back" }), _jsx("button", { onClick: bridge, className: "btn-primary flex-1", children: "Bridge" })] })] }) }));
    }
    return (_jsx(Page, { title: "Bridge", children: _jsxs("div", { className: "card flex flex-col gap-3", children: [_jsxs("div", { className: "inline-flex self-start rounded-xl border border-ink-200 p-1 text-sm dark:border-ink-800", children: [_jsx("button", { type: "button", onClick: () => setDirection("prl-to-wprl"), className: direction === "prl-to-wprl"
                                ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                                : "rounded-lg px-3 py-1 text-ink-500", children: "PRL \u2192 WPRL" }), _jsx("button", { type: "button", onClick: () => setDirection("wprl-to-prl"), className: direction === "wprl-to-prl"
                                ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                                : "rounded-lg px-3 py-1 text-ink-500", children: "WPRL \u2192 PRL" })] }), _jsxs("label", { className: "block", children: [_jsxs("span", { className: "label", children: ["Amount (", symbol, ")"] }), _jsx("input", { className: "input mono", inputMode: "decimal", value: amount, onChange: (e) => setAmount(e.target.value) })] }), preview && (_jsxs("div", { className: "rounded-xl bg-ink-100 p-3 text-xs dark:bg-ink-800/60", children: ["You'll receive \u2248 ", isPrlSide ? formatGrains(preview.recv) : formatWei(preview.recv), " ", recvSymbol, _jsx("br", {}), "Estimated time: \u2248 8 minutes"] })), error && _jsx("p", { className: "text-sm text-red-600", children: error }), _jsx("button", { onClick: () => {
                        if (!preview) {
                            setError("Enter an amount greater than 0.");
                            return;
                        }
                        setError(null);
                        setStep("preview");
                    }, className: "btn-primary", children: "Review" })] }) }));
}
