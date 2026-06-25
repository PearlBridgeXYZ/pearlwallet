import { create } from "zustand";

export type Theme = "system" | "light" | "dark";

// Pearl RPC override allowlist. CSP `connect-src` already restricts which
// hosts the browser can fetch from, but the override field is persisted
// to localStorage — a stray bookmarklet or malicious extension could
// write arbitrary URLs there. Validating at the store boundary makes the
// allowlist single-sourced (CSP + here) and gives the Settings UI a
// machine-readable rejection reason. Empty string = use the default.
// v0.2.5: extended to cover the sentry-fleet hostnames used by the
// auto-rotating RPC pool (see chains/pearl/network.ts PEARL_RPC_POOL).
// Must stay in sync with public/_headers CSP `connect-src`.
const PEARL_RPC_OVERRIDE_ALLOWED_HOSTS: readonly string[] = [
  "rpc.pearlbridge.xyz",
  "pearlbridge.xyz",
  "pearl-sentry-fsn1-1.pearlbridge.xyz",
  "pearl-sentry-nbg1-1.pearlbridge.xyz",
  "pearl-sentry-hel1-1.pearlbridge.xyz",
];

// Ethereum RPC override allowlist. Same model as Pearl side. Restricted
// to hosts CSP allows so a saved override never points at something the
// browser would refuse to load (silent breakage = worst UX).
const ETH_RPC_OVERRIDE_ALLOWED_HOSTS: readonly string[] = [
  "ethereum-rpc.publicnode.com",
  "ethereum-sepolia-rpc.publicnode.com",
  "eth.drpc.org",
  "sepolia.drpc.org",
  "cloudflare-eth.com",
];

// BTX RPC override allowlist. Separate chain, separate endpoints — must NOT
// share the Pearl list (a BTX override validated against Pearl hosts would
// always fall back silently). Mirror these EXACTLY in the CSP connect-src
// (public/_headers) and chains/btx/network.ts BTX_RPC_POOL.
const BTX_RPC_OVERRIDE_ALLOWED_HOSTS: readonly string[] = [
  "btx-rpc.pearlbridge.xyz",
  "btx-rpc2.pearlbridge.xyz",
  "btx-rpc3.pearlbridge.xyz",
];

export function isAllowedRpcOverride(url: string): boolean {
  if (url === "") return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return PEARL_RPC_OVERRIDE_ALLOWED_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

export function isAllowedEthRpcOverride(url: string): boolean {
  if (url === "") return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ETH_RPC_OVERRIDE_ALLOWED_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

export function isAllowedBtxRpcOverride(url: string): boolean {
  if (url === "") return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return BTX_RPC_OVERRIDE_ALLOWED_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

interface UIState {
  theme: Theme;
  // Empty string = use the built-in default sentry RPC.
  pearlRpcOverride: string;
  // Empty string = use the built-in default Ethereum RPC (publicnode +
  // drpc fallback). v0.2.0 surfaces this so a user running their own
  // archive node can point the wallet at it.
  ethRpcOverride: string;
  // PearlBridge developer tip — opt-in by default. Disabling sends no
  // extra output and costs nothing beyond on-chain fees.
  tipEnabled: boolean;
  // Multisig vault surface. Default ON as of v0.5.0 (graduated from the
  // earlier opt-in/experimental toggle once create/sign/send + cosign
  // auto-import shipped and were audited). Surfaces a Vaults entry in the
  // nav. Users who prefer a pure-singlesig wallet can still turn it OFF
  // (opt-out) in Settings; that choice is respected across reloads.
  multisigEnabled: boolean;
  // Ethereum surface (WPRL + ETH gas + PearlBridge). Default OFF in
  // v0.2.0 — a Pearl-native user who never touches Eth shouldn't be
  // forced to look at WPRL/ETH columns. Off hides the WPRL/ETH balance
  // tiles, the Send WPRL / Send ETH / Bridge buttons, the Eth address
  // line on Dashboard, and bounces the corresponding routes back to
  // /dashboard. Singlesig PRL only stays the default-on experience.
  ethEnabled: boolean;
  // Experimental: Armory-style offline signing. Off (default) hides
  // the entire "Offline signing" page + nav entry. On exposes the
  // watcher / signer / broadcaster flows and QR data-transfer UX.
  // Marked experimental because the wire format is v1 and may evolve;
  // do NOT rely on a payload encoded today being decodable by a future
  // major version. See src/lib/offline-signing/payload.ts.
  offlineSigningEnabled: boolean;
  setTheme(t: Theme): void;
  setPearlRpcOverride(url: string): void;
  setEthRpcOverride(url: string): void;
  setTipEnabled(v: boolean): void;
  setMultisigEnabled(v: boolean): void;
  setEthEnabled(v: boolean): void;
  setOfflineSigningEnabled(v: boolean): void;
}

// Bump the storage key whenever the shape changes so a stale persisted
// blob doesn't carry forward a field that no longer exists (or worse,
// is type-different). v4 → v5 in v0.2.0 for ethEnabled + ethRpcOverride.
// v5 → v6 in v0.2.8 for offlineSigningEnabled.
const STORAGE_KEY = "pearl-wallet-ui-v6";

interface PersistedUI {
  theme: Theme;
  pearlRpcOverride: string;
  ethRpcOverride: string;
  tipEnabled: boolean;
  multisigEnabled: boolean;
  ethEnabled: boolean;
  offlineSigningEnabled: boolean;
  // One-time migration marker (v0.4.2): present + true once the
  // "ETH surface on by default" migration has run for this device. Lets
  // existing users get the surface enabled once WITHOUT a STORAGE_KEY bump
  // (which would also wipe theme/RPC/multisig prefs), while a user who
  // later turns ETH off keeps it off.
  ethDefaultedOn: boolean;
  // One-time migration marker (v0.5.0): same pattern as ethDefaultedOn, for
  // graduating the multisig vault surface to default-on. Existing users get
  // Vaults enabled once, stamped, so a later opt-out is preserved.
  multisigDefaultedOn: boolean;
}

const DEFAULT_UI: PersistedUI = {
  theme: "system",
  pearlRpcOverride: "",
  ethRpcOverride: "",
  tipEnabled: true,
  multisigEnabled: true,
  ethEnabled: true,
  offlineSigningEnabled: false,
  ethDefaultedOn: true,
  multisigDefaultedOn: true,
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
    if (!isAllowedEthRpcOverride(merged.ethRpcOverride)) {
      merged.ethRpcOverride = "";
    }
    // One-time default-on migrations: a stored blob that predates a marker
    // gets that surface enabled once, then stamped so a later opt-out is
    // respected. Other prefs in the blob are untouched. v0.4.2: ETH;
    // v0.5.0: multisig vaults.
    let migrated = false;
    if (parsed.ethDefaultedOn !== true) {
      merged.ethEnabled = true;
      merged.ethDefaultedOn = true;
      migrated = true;
    }
    if (parsed.multisigDefaultedOn !== true) {
      merged.multisigEnabled = true;
      merged.multisigDefaultedOn = true;
      migrated = true;
    }
    if (migrated) saveUI(merged);
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
  ethRpcOverride: initial.ethRpcOverride,
  tipEnabled: initial.tipEnabled,
  multisigEnabled: initial.multisigEnabled,
  ethEnabled: initial.ethEnabled,
  offlineSigningEnabled: initial.offlineSigningEnabled,
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
  setEthRpcOverride(url) {
    if (!isAllowedEthRpcOverride(url)) {
      throw new Error("E_ETH_RPC_OVERRIDE_NOT_ALLOWED");
    }
    set({ ethRpcOverride: url });
    saveUI({ ...persistedSnapshot(get()), ethRpcOverride: url });
  },
  setTipEnabled(v) {
    set({ tipEnabled: v });
    saveUI({ ...persistedSnapshot(get()), tipEnabled: v });
  },
  setMultisigEnabled(v) {
    set({ multisigEnabled: v });
    saveUI({ ...persistedSnapshot(get()), multisigEnabled: v });
  },
  setEthEnabled(v) {
    set({ ethEnabled: v });
    saveUI({ ...persistedSnapshot(get()), ethEnabled: v });
  },
  setOfflineSigningEnabled(v) {
    set({ offlineSigningEnabled: v });
    saveUI({ ...persistedSnapshot(get()), offlineSigningEnabled: v });
  },
}));

function persistedSnapshot(s: UIState): PersistedUI {
  return {
    theme: s.theme,
    pearlRpcOverride: s.pearlRpcOverride,
    ethRpcOverride: s.ethRpcOverride,
    tipEnabled: s.tipEnabled,
    multisigEnabled: s.multisigEnabled,
    ethEnabled: s.ethEnabled,
    offlineSigningEnabled: s.offlineSigningEnabled,
    ethDefaultedOn: true,
    multisigDefaultedOn: true,
  };
}
