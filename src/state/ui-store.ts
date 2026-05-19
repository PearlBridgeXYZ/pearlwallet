import { create } from "zustand";

export type Theme = "system" | "light" | "dark";

interface UIState {
  theme: Theme;
  mockMode: boolean;
  // Empty string = use the built-in default for the current network.
  pearlRpcOverride: string;
  setTheme(t: Theme): void;
  setMockMode(v: boolean): void;
  setPearlRpcOverride(url: string): void;
}

const STORAGE_KEY = "pearl-wallet-ui";

interface PersistedUI {
  theme: Theme;
  mockMode: boolean;
  pearlRpcOverride: string;
}

const DEFAULT_UI: PersistedUI = { theme: "system", mockMode: true, pearlRpcOverride: "" };

function loadUI(): PersistedUI {
  if (typeof localStorage === "undefined") return DEFAULT_UI;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_UI;
    const parsed = JSON.parse(raw) as Partial<PersistedUI>;
    return { ...DEFAULT_UI, ...parsed };
  } catch {
    return DEFAULT_UI;
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
  pearlRpcOverride: initial.pearlRpcOverride,
  setTheme(t) {
    set({ theme: t });
    saveUI({ ...persistedSnapshot(get()), theme: t });
  },
  setMockMode(v) {
    set({ mockMode: v });
    saveUI({ ...persistedSnapshot(get()), mockMode: v });
  },
  setPearlRpcOverride(url) {
    set({ pearlRpcOverride: url });
    saveUI({ ...persistedSnapshot(get()), pearlRpcOverride: url });
  },
}));

function persistedSnapshot(s: UIState): PersistedUI {
  return { theme: s.theme, mockMode: s.mockMode, pearlRpcOverride: s.pearlRpcOverride };
}
