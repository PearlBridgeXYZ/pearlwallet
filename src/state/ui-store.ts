import { create } from "zustand";

export type Theme = "system" | "light" | "dark";

interface UIState {
  theme: Theme;
  mockMode: boolean;
  setTheme(t: Theme): void;
  setMockMode(v: boolean): void;
}

const STORAGE_KEY = "pearl-wallet-ui";

interface PersistedUI {
  theme: Theme;
  mockMode: boolean;
}

function loadUI(): PersistedUI {
  if (typeof localStorage === "undefined") return { theme: "system", mockMode: true };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { theme: "system", mockMode: true };
    return JSON.parse(raw) as PersistedUI;
  } catch {
    return { theme: "system", mockMode: true };
  }
}

function saveUI(s: PersistedUI): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

const initial = loadUI();

export const useUI = create<UIState>((set, get) => ({
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
