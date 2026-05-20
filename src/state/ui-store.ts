import { create } from "zustand";

export type Theme = "system" | "light" | "dark";

// RPC override allowlist. CSP `connect-src` already restricts which hosts
// the browser can fetch from, but the override field is persisted to
// localStorage — a stray bookmarklet or malicious extension could write
// arbitrary URLs there. Validating at the store boundary makes the
// allowlist single-sourced (CSP + here) and gives the Settings UI a
// machine-readable rejection reason. Empty string = use the default.
const RPC_OVERRIDE_ALLOWED_HOSTS: readonly string[] = [
  "rpc.pearlwallet.xyz",
  "ethereum-rpc.publicnode.com",
  "eth.drpc.org",
  "pearlbridge.xyz",
];

export function isAllowedRpcOverride(url: string): boolean {
  if (url === "") return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return RPC_OVERRIDE_ALLOWED_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

interface UIState {
  theme: Theme;
  // Empty string = use the built-in default sentry RPC.
  pearlRpcOverride: string;
  // PearlBridge developer tip — opt-in by default. Disabling sends no
  // extra output and costs nothing beyond on-chain fees.
  tipEnabled: boolean;
  // Experimental multisig surface. Default OFF — flips on a Vaults entry
  // in the nav and exposes the multisig flows behind it. Off means the
  // wallet behaves exactly as singlesig has shipped since v0.1.x. We
  // gate the surface (not the build) so users can flip the toggle to
  // help test before the v0.2.0 audit lands.
  multisigEnabled: boolean;
  setTheme(t: Theme): void;
  setPearlRpcOverride(url: string): void;
  setTipEnabled(v: boolean): void;
  setMultisigEnabled(v: boolean): void;
}

// Bump the storage key whenever the shape changes so a stale persisted
// blob doesn't carry forward a field that no longer exists (or worse,
// is type-different).
const STORAGE_KEY = "pearl-wallet-ui-v4";

interface PersistedUI {
  theme: Theme;
  pearlRpcOverride: string;
  tipEnabled: boolean;
  multisigEnabled: boolean;
}

const DEFAULT_UI: PersistedUI = {
  theme: "system",
  pearlRpcOverride: "",
  tipEnabled: true,
  multisigEnabled: false,
};

function loadUI(): PersistedUI {
  if (typeof localStorage === "undefined") return DEFAULT_UI;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_UI;
    const parsed = JSON.parse(raw) as Partial<PersistedUI>;
    const merged = { ...DEFAULT_UI, ...parsed };
    // Defense in depth: a stale localStorage value (or one tampered by a
    // bookmarklet) bypasses the setter's allowlist. Re-validate on load.
    if (!isAllowedRpcOverride(merged.pearlRpcOverride)) {
      merged.pearlRpcOverride = "";
    }
    return merged;
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
  multisigEnabled: initial.multisigEnabled,
  setTheme(t) {
    set({ theme: t });
    saveUI({ ...persistedSnapshot(get()), theme: t });
  },
  setPearlRpcOverride(url) {
    // Reject non-allowlisted hosts at the boundary. The Settings UI
    // should validate before calling, but a programmatic call (devtools,
    // legacy migration, future deeplink handler) must not silently
    // persist a sentry URL that CSP will block at runtime anyway.
    if (!isAllowedRpcOverride(url)) {
      throw new Error("E_RPC_OVERRIDE_NOT_ALLOWED");
    }
    set({ pearlRpcOverride: url });
    saveUI({ ...persistedSnapshot(get()), pearlRpcOverride: url });
  },
  setTipEnabled(v) {
    set({ tipEnabled: v });
    saveUI({ ...persistedSnapshot(get()), tipEnabled: v });
  },
  setMultisigEnabled(v) {
    set({ multisigEnabled: v });
    saveUI({ ...persistedSnapshot(get()), multisigEnabled: v });
  },
}));

function persistedSnapshot(s: UIState): PersistedUI {
  return {
    theme: s.theme,
    pearlRpcOverride: s.pearlRpcOverride,
    tipEnabled: s.tipEnabled,
    multisigEnabled: s.multisigEnabled,
  };
}
