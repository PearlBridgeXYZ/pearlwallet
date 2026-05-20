import { create } from "zustand";
import type { PearlNetwork } from "../chains/pearl/network";
import type { EthNetwork } from "../chains/ethereum/network";
import { cryptoWorker } from "../crypto/worker-client";
import {
  db,
  loadKeystore,
  saveKeystore,
  wipeKeystore,
  type KeystoreRecord,
  type KeystoreBlobJSON,
} from "../storage/db";

// Idle window before the wallet auto-locks. Exported so the TopBar
// countdown and the App-level interval check stay in lockstep — if one
// side hardcodes a different value the user sees "1:23 until lock"
// while the wallet is already locked, which is exactly the v0.1.0
// Low-#2 audit finding this constant addresses.
export const AUTO_LOCK_MS = 5 * 60 * 1000;

// "initializing" is the boot state before init() has read the on-disk
// keystore. Splash renders a placeholder for it instead of the
// "Create a new wallet" funnel — otherwise a user with an existing
// wallet sees the create CTA flash on every cold load before
// auto-route bumps them to /unlock, which looks broken.
export type WalletStatus = "initializing" | "no-wallet" | "locked" | "unlocked";

interface Addresses {
  // Primary Pearl receive address (index 0).
  pearl: string;
  // Full external receive pool — RECEIVE_GAP_LIMIT entries, index 0..N-1.
  // Funds discovered at any of these is "ours" because the seed derives them
  // all. UTXO scans aggregate balances across this pool.
  pearlPool: string[];
  eth: string;
}

interface WalletState {
  status: WalletStatus;
  addresses: Addresses | null;
  pearlNetwork: PearlNetwork;
  ethNetwork: EthNetwork;
  blob: KeystoreBlobJSON | null;
  lastActivity: number;

  init(): Promise<void>;
  createWallet(
    strength: 128 | 256,
    password: string,
    opts?: { allowOverwrite?: boolean },
  ): Promise<{ mnemonic: string; addresses: Addresses }>;
  restoreWallet(
    mnemonic: string,
    password: string,
    opts?: { allowOverwrite?: boolean },
  ): Promise<{ addresses: Addresses }>;
  unlock(password: string): Promise<{ addresses: Addresses }>;
  lock(): Promise<void>;
  // Wipe requires the password so an attacker with brief physical access
  // can't nuke the on-device keystore (and the user's only copy of the
  // mnemonic-encrypted-at-rest) by clicking through Settings. Caller MUST
  // pass the current password; we verify by attempting to decrypt the blob.
  wipe(password: string): Promise<void>;
  exportMnemonic(password: string): Promise<string>;
  changePassword(oldPw: string, newPw: string): Promise<void>;
  touch(): void;
  setEthNetwork(net: EthNetwork): void;
}

// Cross-tab notification when the keystore blob is rewritten (currently:
// changePassword). Other tabs reload the on-disk record so a subsequent
// changePassword-from-Tab-B doesn't race-overwrite Tab-A's new password.
const KEYSTORE_BROADCAST_CHANNEL = "pearl-wallet-keystore";

// Per-tab sender id. Every KeystoreEvent we broadcast carries this id so
// the persistent receive handler can ignore our own messages — without
// it, a `changePassword` in Tab A broadcasts `blob-updated`, the same
// tab's listener receives it back, force-locks the freshly-rotated
// session, and the user sees "wallet locked itself after I changed my
// password" as flagged by the v0.1.7 audit (opus2 H3). crypto.randomUUID
// is fine here — it's a tag, not a secret.
const SENDER_ID: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type KeystoreEvent =
  | { type: "blob-updated"; sender: string }
  | { type: "wiped"; sender: string };

// Module-scope channel handle. Owned by init() to make BroadcastChannel
// allocation idempotent across React.StrictMode double-effects, and so a
// future dispose hook can close it.
let keystoreChannel: BroadcastChannel | null = null;
let storeInitialized = false;

function broadcastKeystoreEvent(ev: Omit<KeystoreEvent, "sender">): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const payload = { ...ev, sender: SENDER_ID } as KeystoreEvent;
    // Reuse the persistent channel if init() has wired it; otherwise
    // fall through to an ephemeral channel (covers wipe() called before
    // init() resolves in edge cases).
    if (keystoreChannel) {
      keystoreChannel.postMessage(payload);
      return;
    }
    const ch = new BroadcastChannel(KEYSTORE_BROADCAST_CHANNEL);
    ch.postMessage(payload);
    ch.close();
  } catch {
    // BroadcastChannel unsupported (older Safari) — silent fallback.
  }
}

/** Test-only export of the per-tab sender id. */
export function __broadcastSenderIdForTests(): string {
  return SENDER_ID;
}

/** Test-only export of the broadcast channel name. */
export function __broadcastChannelNameForTests(): string {
  return KEYSTORE_BROADCAST_CHANNEL;
}

// Test-only reset hook. The Zustand store is process-global so a vitest
// suite that exercises init() repeatedly needs a way to undo the
// once-only guard. Production code never calls this.
export function __resetWalletStoreForTests(): void {
  if (keystoreChannel) {
    try { keystoreChannel.close(); } catch { /* noop */ }
  }
  keystoreChannel = null;
  storeInitialized = false;
}

// Serializes mutating store operations against broadcast handlers so a
// cross-tab `wiped` event can't interleave with a local unlock/restore/
// changePassword. Without this, a peer-tab wipe can leave Tab A with
// status="unlocked", blob=null but addresses populated — the next refresh
// nukes the in-memory mnemonic the user just exfilable via Settings.
function makeAsyncLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((res) => (release = res));
    try {
      await prev;
    } catch {
      // prior operation failed — that's the prior caller's problem
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
const walletLock = makeAsyncLock();

export const useWallet = create<WalletState>((set, get) => ({
  status: "initializing",
  addresses: null,
  pearlNetwork: "mainnet",
  ethNetwork: "mainnet",
  blob: null,
  lastActivity: Date.now(),

  async init() {
    // Idempotent: under React.StrictMode dev, App's useEffect mounts
    // twice and would otherwise (a) re-overwrite an in-flight unlock
    // back to "locked" and (b) leak a duplicate BroadcastChannel
    // listener for every reload.
    if (storeInitialized) return;
    storeInitialized = true;
    const rec = await loadKeystore();
    if (rec) {
      set({
        status: "locked",
        blob: rec.blob,
        addresses: {
          pearl: rec.publicData.pearlAddress,
          pearlPool: rec.publicData.pearlAddressPool ?? [rec.publicData.pearlAddress],
          eth: rec.publicData.ethAddress,
        },
        pearlNetwork: "mainnet",
        ethNetwork: rec.publicData.ethNetwork,
      });
    } else {
      set({ status: "no-wallet" });
    }
    // Multi-tab keystore sync. Wired at init() instead of module-scope so
    // a test environment without BroadcastChannel doesn't blow up at
    // import time.
    if (typeof BroadcastChannel !== "undefined" && !keystoreChannel) {
      try {
        keystoreChannel = new BroadcastChannel(KEYSTORE_BROADCAST_CHANNEL);
        keystoreChannel.onmessage = (ev: MessageEvent<KeystoreEvent>) => {
          // Ignore our own broadcasts. BroadcastChannel delivers to every
          // listener bound to the channel name in the same origin —
          // including the very tab that posted the message. Without this
          // self-filter, Tab A's own `changePassword` would trigger Tab
          // A's force-lock handler. SENDER_ID is unique per tab so this
          // discriminator is exact (no false positives across tabs).
          if (ev.data && (ev.data as KeystoreEvent).sender === SENDER_ID) return;
          // Wrap inside the async lock so we cannot interleave with an
          // in-flight unlock/restoreWallet/changePassword. Without this,
          // a peer-tab wipe between `cryptoWorker.call("unlock")` resolving
          // and the post-resolve `set({status:"unlocked"})` would leave
          // status=unlocked but blob=null — wallet "works" until refresh
          // then loses the mnemonic.
          void walletLock(async () => {
            if (ev.data.type === "blob-updated") {
              const fresh = await loadKeystore();
              if (fresh) {
                // Lock this tab on a foreign password change — the in-memory
                // session was derived from the OLD password; using it against
                // the new blob would fail anyway, and the cleanest UX is to
                // require an unlock with the new password.
                cryptoWorker.reset();
                set({ status: "locked", blob: fresh.blob });
              } else {
                // Foreign update with no row — likely a wipe arrived first.
                // Treat as wiped so we don't dangle in stale "unlocked".
                cryptoWorker.reset();
                set({ status: "no-wallet", addresses: null, blob: null });
              }
            } else if (ev.data.type === "wiped") {
              cryptoWorker.reset();
              set({ status: "no-wallet", addresses: null, blob: null });
            }
          });
        };
      } catch {
        // BroadcastChannel unsupported — single-tab mode is still safe.
      }
    }
  },

  async createWallet(strength, password, opts) {
    return walletLock(async () => {
      // Existing-wallet guard — prevents the v0.1.5 fund-loss footgun where
      // clicking "Create a new wallet" from Splash silently overwrites the
      // existing encrypted keystore. Caller must explicitly opt-in by passing
      // allowOverwrite (the UI requires "wipe my wallet" confirmation).
      const existing = await loadKeystore();
      if (existing && !opts?.allowOverwrite) {
        throw new Error("E_WALLET_EXISTS");
      }
      const { pearlNetwork, ethNetwork } = get();
      const out = await cryptoWorker.call<"createWallet", {
        mnemonic: string;
        blob: KeystoreBlobJSON;
        addresses: Addresses;
      }>("createWallet", { strength, password, network: pearlNetwork });

      const rec: KeystoreRecord = {
        id: "primary",
        version: 1,
        blob: out.blob,
        publicData: {
          pearlAddress: out.addresses.pearl,
          pearlAddressPool: out.addresses.pearlPool,
          ethAddress: out.addresses.eth,
          pearlNetwork,
          ethNetwork,
          createdAt: Date.now(),
        },
      };
      await saveKeystore(rec);
      set({
        status: "unlocked",
        addresses: out.addresses,
        blob: out.blob,
        lastActivity: Date.now(),
      });
      return { mnemonic: out.mnemonic, addresses: out.addresses };
    });
  },

  async restoreWallet(mnemonic, password, opts) {
    return walletLock(async () => {
      const existing = await loadKeystore();
      if (existing && !opts?.allowOverwrite) {
        throw new Error("E_WALLET_EXISTS");
      }
      const { pearlNetwork, ethNetwork } = get();
      const out = await cryptoWorker.call<"restoreWallet", {
        mnemonic: string;
        blob: KeystoreBlobJSON;
        addresses: Addresses;
      }>("restoreWallet", { mnemonic, password, network: pearlNetwork });

      const rec: KeystoreRecord = {
        id: "primary",
        version: 1,
        blob: out.blob,
        publicData: {
          pearlAddress: out.addresses.pearl,
          pearlAddressPool: out.addresses.pearlPool,
          ethAddress: out.addresses.eth,
          pearlNetwork,
          ethNetwork,
          createdAt: Date.now(),
        },
      };
      await saveKeystore(rec);
      set({
        status: "unlocked",
        addresses: out.addresses,
        blob: out.blob,
        lastActivity: Date.now(),
      });
      return { addresses: out.addresses };
    });
  },

  async unlock(password) {
    return walletLock(async () => {
      const { blob, pearlNetwork } = get();
      if (!blob) throw new Error("E_NO_WALLET");
      const out = await cryptoWorker.call<"unlock", { addresses: Addresses }>("unlock", {
        blob,
        password,
        network: pearlNetwork,
      });
      // Cross-tab race guard: another tab may have wiped the keystore
      // between our `unlock` call landing and this resume. If the row is
      // gone now, the in-memory worker session would dangle without a
      // matching on-disk blob — clean up and surface E_WALLET_WIPED.
      const rec = await loadKeystore();
      if (!rec) {
        cryptoWorker.reset();
        set({ status: "no-wallet", addresses: null, blob: null });
        throw new Error("E_WALLET_WIPED");
      }
      // Persist the freshly-derived pool back to the keystore so a record
      // saved by an older build (without pearlAddressPool) gets upgraded
      // without requiring a wipe-and-restore.
      const needsUpdate =
        !Array.isArray(rec.publicData.pearlAddressPool) ||
        rec.publicData.pearlAddressPool.length !== out.addresses.pearlPool.length ||
        rec.publicData.pearlAddressPool.some((a, i) => a !== out.addresses.pearlPool[i]);
      if (needsUpdate) {
        rec.publicData.pearlAddressPool = out.addresses.pearlPool;
        rec.publicData.pearlAddress = out.addresses.pearl;
        await saveKeystore(rec);
      }
      set({ status: "unlocked", addresses: out.addresses, lastActivity: Date.now() });
      return { addresses: out.addresses };
    });
  },

  async lock() {
    await cryptoWorker.call<"lock">("lock", {}).catch(() => undefined);
    cryptoWorker.reset();
    set({ status: "locked" });
  },

  async wipe(password) {
    return walletLock(async () => {
      const { blob, status } = get();
      // No-wallet wipe is a UX trap: clicking "Wipe" against an empty
      // keystore would silently "succeed" with any password, which can
      // lull a user into thinking they wiped something they didn't.
      // Refuse explicitly.
      if (status === "no-wallet" || !blob) {
        throw new Error("E_NO_WALLET");
      }
      // Password-gate the wipe by attempting to decrypt the blob. A wrong
      // password throws E_PASSWORD_WRONG and we keep the keystore intact.
      await cryptoWorker.call<"exportMnemonic", { mnemonic: string }>(
        "exportMnemonic",
        { password, blob },
      );
      cryptoWorker.reset();
      await wipeKeystore();
      broadcastKeystoreEvent({ type: "wiped" });
      set({ status: "no-wallet", addresses: null, blob: null });
    });
  },

  async exportMnemonic(password) {
    const { blob } = get();
    if (!blob) throw new Error("E_NO_WALLET");
    const out = await cryptoWorker.call<"exportMnemonic", { mnemonic: string }>(
      "exportMnemonic",
      { password, blob },
    );
    return out.mnemonic;
  },

  async changePassword(oldPw, newPw) {
    return walletLock(async () => {
      const { blob } = get();
      if (!blob) throw new Error("E_NO_WALLET");
      const out = await cryptoWorker.call<"changePassword", { blob: KeystoreBlobJSON }>(
        "changePassword",
        { oldPassword: oldPw, newPassword: newPw, blob },
      );
      // Race window: another tab may have wiped between our worker call
      // and this resume. Without this guard we'd write `set({blob:newBlob})`
      // into memory, broadcast `blob-updated`, but the on-disk row is
      // gone — on refresh the mnemonic is lost.
      const rec = await loadKeystore();
      if (!rec) {
        cryptoWorker.reset();
        set({ status: "no-wallet", addresses: null, blob: null });
        throw new Error("E_WALLET_WIPED");
      }
      rec.blob = out.blob;
      await db.keystore.put(rec);
      set({ blob: out.blob });
      // Multi-tab safety: another open tab loaded the old blob into its
      // closure at init() time. Tell it the on-disk record changed so it
      // refreshes — otherwise that tab's next operation reads stale
      // ciphertext and either fails with E_PASSWORD_WRONG (confusing) or
      // races a saveKeystore that resurrects the old password.
      broadcastKeystoreEvent({ type: "blob-updated" });
    });
  },

  touch() {
    set({ lastActivity: Date.now() });
  },

  setEthNetwork(net) {
    set({ ethNetwork: net });
  },
}));
