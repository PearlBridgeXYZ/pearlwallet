import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import Page from "../components/Page";
export default function History() {
    const [filter, setFilter] = useState("all");
    return (_jsxs(Page, { title: "History", children: [_jsx("div", { className: "mb-4 flex gap-2 text-sm", children: ["all", "prl", "wprl", "bridge"].map((f) => (_jsx("button", { type: "button", onClick: () => setFilter(f), className: filter === f
                        ? "rounded-full bg-pearl-700 px-3 py-1 text-white"
                        : "rounded-full border border-ink-300 px-3 py-1 text-ink-600 dark:border-ink-700 dark:text-ink-300", children: f.toUpperCase() }, f))) }), _jsx("div", { className: "card text-sm text-ink-500", children: "No transactions yet. Activity appears here once you send, receive, or bridge." })] }));
}
