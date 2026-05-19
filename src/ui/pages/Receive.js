import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { dataUrl } from "../../lib/qr";
export default function Receive() {
    const addresses = useWallet((s) => s.addresses);
    const [tab, setTab] = useState("prl");
    const [qr, setQr] = useState("");
    const [copied, setCopied] = useState(false);
    const addr = tab === "prl" ? addresses?.pearl : addresses?.eth;
    useEffect(() => {
        if (!addr)
            return;
        void dataUrl(addr).then(setQr);
    }, [addr]);
    async function copy() {
        if (!addr)
            return;
        try {
            await navigator.clipboard.writeText(addr);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }
        catch {
            // ignore
        }
    }
    return (_jsxs(Page, { title: "Receive", children: [_jsxs("div", { className: "mb-4 inline-flex rounded-xl border border-ink-200 p-1 text-sm dark:border-ink-800", children: [_jsx("button", { type: "button", onClick: () => setTab("prl"), className: tab === "prl"
                            ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                            : "rounded-lg px-3 py-1 text-ink-500", children: "PRL" }), _jsx("button", { type: "button", onClick: () => setTab("wprl"), className: tab === "wprl"
                            ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                            : "rounded-lg px-3 py-1 text-ink-500", children: "WPRL" })] }), _jsxs("div", { className: "card flex flex-col items-center", children: [qr ? (_jsx("img", { src: qr, alt: `${tab.toUpperCase()} receive address QR code`, className: "h-64 w-64 rounded-lg" })) : (_jsx("div", { className: "h-64 w-64 animate-pulse rounded-lg bg-ink-100 dark:bg-ink-800" })), _jsx("div", { className: "mt-4 max-w-full break-all font-mono text-sm", children: addr }), _jsx("button", { type: "button", onClick: copy, className: "btn-secondary mt-4", children: copied ? "Copied!" : "Copy address" })] }), _jsxs("p", { className: "mt-4 text-xs text-ink-500", children: ["Only send ", tab.toUpperCase(), " to this address. ", tab === "wprl" ? "This is an Ethereum address — sending other ERC-20s to it works (you'll see them in a block explorer), but the wallet only tracks WPRL." : "Pearl L1 only — do not send other assets."] })] }));
}
