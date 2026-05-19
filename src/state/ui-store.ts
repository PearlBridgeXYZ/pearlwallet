import { create } from "zustand";

export type Theme = "system" | "light" | "dark";

interface UIState {
  theme: Theme;
  // Empty string = use the built-in default sentry RPC.
  pearlRpcOverride: string;
  // PearlBridge developer tip — opt-in by default. Disabling sends no
  // extra output and costs nothing beyond on-chain fees.
  tipEnabled: boolean;
  setTheme(t: Theme): void;
  setPearlRpcOverride(url: string): void;
  setTipEnabled(v: boolean): void;
}

const STORAGE_KEY = "pearl-wallet-ui-v3";

interface PersistedUI {
  theme: Theme;
  pearlRpcOverride: string;
  tipEnabled: boolean;
}

const DEFAULT_UI: PersistedUI = {
  theme: "system",
  pearlRpcOverride: "",
  tipEnabled: true,
};

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
  pearlRpcOverride: initial.pearlRpcOverride,
  tipEnabled: initial.tipEnabled,
  setTheme(t) {
    set({ theme: t });
    saveUI({ ...persistedSnapshot(get()), theme: t });
  },
  setPearlRpcOverride(url) {
    set({ pearlRpcOverride: url });
    saveUI({ ...persistedSnapshot(get()), pearlRpcOverride: url });
  },
  setTipEnabled(v) {
    set({ tipEnabled: v });
    saveUI({ ...persistedSnapshot(get()), tipEnabled: v });
  },
}));

function persistedSnapshot(s: UIState): PersistedUI {
  return {
    theme: s.theme,
    pearlRpcOverride: s.pearlRpcOverride,
    tipEnabled: s.tipEnabled,
  };
}
