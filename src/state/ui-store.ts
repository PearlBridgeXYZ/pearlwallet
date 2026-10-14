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
// v0.7: the never-resolving pearl-sentry-{fsn1,nbg1,hel1}-1 names were
// dropped here and from the CSP (a saved override naming one falls back to
// the default on load).
const PEARL_RPC_OVERRIDE_ALLOWED_HOSTS: readonly string[] = [
  "rpc.pearlbridge.xyz",
  "pearlbridge.xyz",
];

// Ethereum RPC override allowlist. Same model as Pearl side. Restricted
// to hosts CSP allows so a saved override never points at something the
// browser would refuse to load (silent breakage = worst UX).
const ETH_RPC_OVERRIDE_ALLOWED_HOSTS: readonly string[] = [
  "ethereum-rpc.publicnode.com",
  "ethereum-sepolia-rpc.publicnode.com",
  "eth.drpc.org",
  "sepolia.drpc.org",
  // cloudflare-eth.com dropped in v0.7 (it answers JSON-RPC errors; see
  // chains/ethereum/network.ts); removed from the CSP too.
];

// BTX RPC override allowlist. Separate chain, separate endpoints — must NOT
// share the Pearl list (a BTX override validated against Pearl hosts would
// always fall back silently). Mirror chains/btx/network.ts BTX_RPC_POOL.
// While BTX_UI_ENABLED (lib/features.ts) is false these hosts are NOT in
// the CSP connect-src (index.html, public/_headers), so nothing can reach
// them; flipping the switch back on means re-adding them there (a test
// in v018.test.ts holds the two together).
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
  // PearlBridge developer tip — ON by default (tipEnabled: true below),
  // can be turned off in Settings. Disabling sends no extra output and
  // costs nothing beyond on-chain fees.
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
  // BTX (post-quantum) surface. On shows the BTX balance card + receive/send.
  // Beta-first asset; additive to PRL/WPRL/ETH.
  btxEnabled: boolean;
  // Settings RPC override for the BTX indexer/RPC edge (validated against the
  // BTX allowlist, mirrored in CSP). Empty = use the default pool.
  btxRpcOverride: string;
  setTheme(t: Theme): void;
  setPearlRpcOverride(url: string): void;
  setEthRpcOverride(url: string): void;
  setTipEnabled(v: boolean): void;
  setMultisigEnabled(v: boolean): void;
  setEthEnabled(v: boolean): void;
  setOfflineSigningEnabled(v: boolean): void;
  setBtxEnabled(v: boolean): void;
  setBtxRpcOverride(url: string): void;
}

// Bump the storage key whenever the shape changes so a stale persisted
// blob doesn't carry forward a field that no longer exists (or worse,
// is type-different). v4 → v5 in v0.2.0 for ethEnabled + ethRpcOverride.
// v5 → v6 in v0.2.8 for offlineSigningEnabled.
// v6 → v7 for btxEnabled + btxRpcOverride (BTX surface).
const STORAGE_KEY = "pearl-wallet-ui-v7";

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
  btxEnabled: boolean;
  btxRpcOverride: string;
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
  btxEnabled: true,
  btxRpcOverride: "",
};

function loadUI(): PersistedUI {
  if (typeof localStorage === "undefined") return DEFAULT_UI;
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    let migrated = false;
    if (!raw) {
      for (let v = 6; v >= 1; v--) {
        const older = localStorage.getItem(`pearl-wallet-ui-v${v}`);
        if (older) { raw = older; migrated = true; break; }
      }
    }
    if (!raw) return { ...DEFAULT_UI };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_UI };
    const input = parsed as Record<string, unknown>;
    const merged = { ...DEFAULT_UI };
    for (const key of Object.keys(DEFAULT_UI) as (keyof PersistedUI)[]) {
      if (typeof input[key] === typeof DEFAULT_UI[key]) {
        Object.assign(merged, { [key]: input[key] });
      }
    }
    if (!["system", "light", "dark"].includes(merged.theme)) merged.theme = "system";
    // Defense in depth: a stale localStorage value (or one tampered by a
    // bookmarklet) bypasses the setter's allowlist. Re-validate on load.
    if (!isAllowedRpcOverride(merged.pearlRpcOverride)) {
      merged.pearlRpcOverride = "";
    }
    if (!isAllowedEthRpcOverride(merged.ethRpcOverride)) {
      merged.ethRpcOverride = "";
    }
    if (!isAllowedBtxRpcOverride(merged.btxRpcOverride)) {
      merged.btxRpcOverride = "";
    }
    // Adding a feature must never reverse an explicit privacy/financial opt-out.
    merged.ethDefaultedOn = true;
    merged.multisigDefaultedOn = true;
    if (migrated || input.ethDefaultedOn !== true || input.multisigDefaultedOn !== true) {
      try { saveUI(merged); } catch { /* preserve loaded choices if storage is read-only */ }
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
  ethRpcOverride: initial.ethRpcOverride,
  tipEnabled: initial.tipEnabled,
  multisigEnabled: initial.multisigEnabled,
  ethEnabled: initial.ethEnabled,
  offlineSigningEnabled: initial.offlineSigningEnabled,
  btxEnabled: initial.btxEnabled,
  btxRpcOverride: initial.btxRpcOverride,
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
  setBtxEnabled(v) {
    set({ btxEnabled: v });
    saveUI({ ...persistedSnapshot(get()), btxEnabled: v });
  },
  setBtxRpcOverride(url) {
    if (!isAllowedBtxRpcOverride(url)) {
      throw new Error("E_BTX_RPC_OVERRIDE_NOT_ALLOWED");
    }
    set({ btxRpcOverride: url });
    saveUI({ ...persistedSnapshot(get()), btxRpcOverride: url });
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
    btxEnabled: s.btxEnabled,
    btxRpcOverride: s.btxRpcOverride,
  };
}
