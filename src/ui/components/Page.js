import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import TopBar from "./TopBar";
export default function Page({ children, chrome = true, title }) {
    return (_jsxs("div", { className: "min-h-full", children: [chrome && _jsx(TopBar, {}), _jsxs("main", { className: "mx-auto max-w-2xl px-4 py-6", children: [title && _jsx("h1", { className: "mb-4 text-xl font-semibold", children: title }), children] })] }));
}
