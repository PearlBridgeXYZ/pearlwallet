import { create } from "zustand";
const STORAGE_KEY = "pearl-wallet-ui";
function loadUI() {
    if (typeof localStorage === "undefined")
        return { theme: "system", mockMode: true };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return { theme: "system", mockMode: true };
        return JSON.parse(raw);
    }
    catch {
        return { theme: "system", mockMode: true };
    }
}
function saveUI(s) {
    if (typeof localStorage === "undefined")
        return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
const initial = loadUI();
export const useUI = create((set, get) => ({
    theme: initial.theme,
    mockMode: initial.mockMode,
    setTheme(t) {
        set({ theme: t });
        saveUI({ theme: t, mockMode: get().mockMode });
    },
    setMockMode(v) {
        set({ mockMode: v });
        saveUI({ theme: get().theme, mockMode: v });
    },
}));
