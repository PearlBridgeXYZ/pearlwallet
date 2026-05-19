import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { fetchBalances } from "../../services/balances";
import { formatGrains, formatWei, formatUSD, shortAddr } from "../../lib/format";
export default function Dashboard() {
    const addresses = useWallet((s) => s.addresses);
    const balancesQ = useQuery({
        queryKey: ["balances", addresses?.pearl, addresses?.eth],
        queryFn: () => fetchBalances(addresses.pearl, addresses.eth),
        enabled: !!addresses,
        refetchInterval: 30_000,
    });
    const balances = balancesQ.data;
    const totalUsd = balances ? balances.prlUsd * Number(balances.prl) / 1e8 + balances.wprlUsd * Number(balances.wprl) / 1e18 : 0;
    return (_jsxs(Page, { children: [_jsxs("div", { className: "card", children: [_jsx("div", { className: "text-xs uppercase tracking-wide text-ink-500", children: "Total balance" }), _jsx("div", { className: "mt-1 text-3xl font-semibold", children: formatUSD(totalUsd) }), _jsxs("div", { className: "mt-5 grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs text-ink-500", children: "PRL" }), _jsx("div", { className: "text-xl font-medium", children: balances ? formatGrains(balances.prl) : "—" }), _jsx("div", { className: "text-xs text-ink-500", children: balances ? `≈ ${formatUSD(balances.prlUsd * Number(balances.prl) / 1e8)}` : "" })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs text-ink-500", children: "WPRL" }), _jsx("div", { className: "text-xl font-medium", children: balances ? formatWei(balances.wprl) : "—" }), _jsx("div", { className: "text-xs text-ink-500", children: balances ? `≈ ${formatUSD(balances.wprlUsd * Number(balances.wprl) / 1e18)}` : "" })] })] }), _jsxs("div", { className: "mt-5 grid grid-cols-3 gap-2", children: [_jsx(Link, { to: "/send/prl", className: "btn-secondary", children: "Send" }), _jsx(Link, { to: "/receive", className: "btn-secondary", children: "Receive" }), _jsx(Link, { to: "/bridge", className: "btn-primary", children: "Bridge" })] })] }), _jsxs("div", { className: "card mt-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Your addresses" }), _jsx(Link, { to: "/receive", className: "text-xs text-pearl-700 hover:underline", children: "View QR" })] }), _jsxs("dl", { className: "mt-3 space-y-2 text-sm", children: [_jsxs("div", { children: [_jsx("dt", { className: "text-xs text-ink-500", children: "Pearl L1" }), _jsx("dd", { className: "break-all font-mono", children: addresses ? shortAddr(addresses.pearl, 12, 8) : "—" })] }), _jsxs("div", { children: [_jsx("dt", { className: "text-xs text-ink-500", children: "Ethereum (WPRL)" }), _jsx("dd", { className: "break-all font-mono", children: addresses ? shortAddr(addresses.eth, 8, 6) : "—" })] })] })] }), _jsxs("div", { className: "card mt-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Recent activity" }), _jsx(Link, { to: "/history", className: "text-xs text-pearl-700 hover:underline", children: "See all" })] }), _jsx("p", { className: "mt-3 text-sm text-ink-500", children: "No activity yet." })] }), _jsx("div", { className: "mt-4 text-center text-xs text-ink-400", children: _jsx(Link, { to: "/about", className: "hover:underline", children: "About this wallet" }) })] }));
}
