import { create } from "zustand";
import type { PearlNetwork } from "../chains/pearl/network";
import type { EthNetwork } from "../chains/ethereum/network";
import { cryptoWorker } from "../crypto/worker-client";
import { MAX_ADDRESSES_PER_BRANCH, RECEIVE_GAP_LIMIT, type HdBranch } from "../crypto/hd";
import { monotonicNow } from "../lib/monotonic";
import { clearBalanceMemory } from "./balance-memory";
import { clearPendingSpends } from "../services/pending-spends";
import {
  loadKeystore,
  replaceKeystoreBlob,
  saveKeystore,
  updateKeystoreAddresses,
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
  // External receive branch m/86'/808276'/0'/0/i, index 0..N-1. At least
  // RECEIVE_GAP_LIMIT entries; grows as address discovery finds used ones.
  pearlPool: string[];
  // Internal/change branch m/86'/808276'/0'/1/i, index 0..N-1. Same rules.
  // Optional only for records loaded before the first v0.7 unlock.
  pearlChange?: string[];
  eth: string;
}

/** Per-branch address counts to re-derive on unlock, from a stored record. */
export function storedBranchCounts(rec: KeystoreRecord): { external: number; internal: number } {
  const ext = rec.publicData.pearlAddressPool?.length ?? 0;
  const int = rec.publicData.pearlChangePool?.length ?? 0;
  return {
    external: Math.min(ext, MAX_ADDRESSES_PER_BRANCH),
    internal: Math.min(int, MAX_ADDRESSES_PER_BRANCH),
  };
}

/** True when `next` extends `cur` (same prefix, at least as long). */
export function isPrefixExtension(cur: readonly string[], next: readonly string[]): boolean {
  if (next.length < cur.length) return false;
  for (let i = 0; i < cur.length; i++) if (cur[i] !== next[i]) return false;
  return true;
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

interface WalletState {
  status: WalletStatus;
  addresses: Addresses | null;
  pearlNetwork: PearlNetwork;
  ethNetwork: EthNetwork;
  blob: KeystoreBlobJSON | null;
  lastActivity: number;
  /** Bumped by resetPearlAddresses. A discovery result produced by a scan
   *  that started under an older generation is refused, so an in-flight
   *  scan over the long list can't undo the reset. */
  pearlAddressGeneration: number;

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
  /** Derive more single-sig addresses of one branch (crypto worker). */
  derivePearlAddresses(branch: HdBranch, start: number, count: number): Promise<string[]>;
  /** Adopt + persist a discovered address set. Accepted only while
   *  unlocked and only as a prefix-extension of the current lists (so a
   *  scan that raced a wallet switch can never write foreign addresses). */
  extendPearlAddresses(
    next: { external: readonly string[]; internal: readonly string[] },
    generation?: number,
  ): Promise<boolean>;
  /** An onDiscovered callback bound to the CURRENT address generation —
   *  create it when a scan starts, not when it finishes. */
  pearlDiscoveryHandler(): (next: { external: readonly string[]; internal: readonly string[] }) => Promise<boolean>;
  /** Shrinks the tracked single-sig address lists back to the first
   *  RECEIVE_GAP_LIMIT of each branch (same addresses, a prefix) and
   *  persists that; the next scan rediscovers from there. For a list
   *  grown by a misbehaving RPC. */
  resetPearlAddresses(): Promise<boolean>;
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
  // monotonicNow() — see lib/monotonic.ts. Date.now() would be subject
  // to wall-clock manipulation that defeats the auto-lock window.
  lastActivity: monotonicNow(),
  pearlAddressGeneration: 0,

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
          pearlChange: rec.publicData.pearlChangePool ?? [],
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
                clearBalanceMemory();
                set({ status: "locked", blob: fresh.blob });
              } else {
                // Foreign update with no row — likely a wipe arrived first.
                // Treat as wiped so we don't dangle in stale "unlocked".
                cryptoWorker.reset();
                clearBalanceMemory();
                set({ status: "no-wallet", addresses: null, blob: null });
              }
            } else if (ev.data.type === "wiped") {
              cryptoWorker.reset();
              clearBalanceMemory();
              // This handler can run late (it queues behind an in-flight
              // operation), by which time the other tab may already have
              // restored or created a wallet. Lock onto that one rather
              // than showing "no wallet" while a record is stored.
              const fresh = await loadKeystore();
              if (fresh) {
                set({
                  status: "locked",
                  addresses: null,
                  blob: fresh.blob,
                  pearlAddressGeneration: get().pearlAddressGeneration + 1,
                });
              } else {
                set({ status: "no-wallet", addresses: null, blob: null });
              }
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
          pearlChangePool: out.addresses.pearlChange ?? [],
          ethAddress: out.addresses.eth,
          pearlNetwork,
          ethNetwork,
          createdAt: Date.now(),
        },
      };
      await saveKeystore(rec);
      // New wallet (possibly replacing another): drop the previous one's
      // remembered per-address balances and scan state.
      clearBalanceMemory();
      set({
        status: "unlocked",
        addresses: out.addresses,
        blob: out.blob,
        lastActivity: monotonicNow(),
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
          pearlChangePool: out.addresses.pearlChange ?? [],
          ethAddress: out.addresses.eth,
          pearlNetwork,
          ethNetwork,
          createdAt: Date.now(),
        },
      };
      await saveKeystore(rec);
      // New wallet (possibly replacing another): drop the previous one's
      // remembered per-address balances and scan state.
      clearBalanceMemory();
      set({
        status: "unlocked",
        addresses: out.addresses,
        blob: out.blob,
        lastActivity: monotonicNow(),
      });
      return { addresses: out.addresses };
    });
  },

  async unlock(password) {
    return walletLock(async () => {
      const { blob, pearlNetwork } = get();
      if (!blob) throw new Error("E_NO_WALLET");
      // Re-derive as many addresses per branch as discovery previously
      // found (persisted on the record); the worker clamps to
      // [RECEIVE_GAP_LIMIT, MAX_ADDRESSES_PER_BRANCH]. Records from before
      // v0.7 (20 external, no change pool) derive 20 + 20.
      const stored = await loadKeystore();
      const counts = stored ? storedBranchCounts(stored) : undefined;
      const out = await cryptoWorker.call<"unlock", { addresses: Addresses }>("unlock", {
        blob,
        password,
        network: pearlNetwork,
        ...(counts ? { counts } : {}),
      });
      // Cross-tab race guard: another tab may have wiped the keystore
      // between our `unlock` call landing and this resume. If the row is
      // gone now, the in-memory worker session would dangle without a
      // matching on-disk blob — clean up and surface E_WALLET_WIPED.
      const rec = await loadKeystore();
      if (!rec) {
        cryptoWorker.reset();
        clearBalanceMemory();
        set({ status: "no-wallet", addresses: null, blob: null });
        throw new Error("E_WALLET_WIPED");
      }
      // Persist the freshly-derived pools back to the keystore so a record
      // saved by an older build (without pearlAddressPool / pearlChangePool)
      // gets upgraded without requiring a wipe-and-restore. Only the
      // public address lists change; the encrypted blob is untouched.
      const change = out.addresses.pearlChange ?? [];
      const needsUpdate =
        !sameList(rec.publicData.pearlAddressPool, out.addresses.pearlPool) ||
        !sameList(rec.publicData.pearlChangePool, change) ||
        rec.publicData.pearlAddress !== out.addresses.pearl;
      if (needsUpdate) {
        // Address lists only: the blob is never rewritten from this read.
        await updateKeystoreAddresses({
          pearlAddress: out.addresses.pearl,
          pearlAddressPool: out.addresses.pearlPool,
          pearlChangePool: change,
        }, rec.publicData.pearlAddress);
      }
      set({ status: "unlocked", addresses: out.addresses, lastActivity: monotonicNow() });
      return { addresses: out.addresses };
    });
  },

  async lock() {
    await cryptoWorker.call<"lock">("lock", {}).catch(() => undefined);
    cryptoWorker.reset();
    // v0.2.4 (SEC, pass-2 M-2): clear addresses on lock. They survive
    // re-load because they sit in publicData on the keystore row, but
    // holding them in the live store while status="locked" means a
    // useQuery with `enabled: !!addresses` can fire one balance/activity
    // RPC during the lock-transition tick. Clearing them shuts that
    // window: addresses come back on the next successful unlock(),
    // which is the only path that legitimately needs them.
    // Remembered per-address balances and scan state must not outlive
    // the session either.
    clearBalanceMemory();
    // Bump the address generation too: an address write still awaiting
    // the keystore (extend / reset) must not publish its lists after this.
    set({ status: "locked", addresses: null, pearlAddressGeneration: get().pearlAddressGeneration + 1 });
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
      clearBalanceMemory();
      // Broadcast records (wipeKeystore removed the key too; this also
      // re-renders the banner). Lock keeps them on purpose: a lock must not
      // forget a broadcast whose fate is unknown.
      clearPendingSpends();
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
      const { blob, addresses } = get();
      if (!blob) throw new Error("E_NO_WALLET");
      // The identity this password change is bound to: the wallet whose
      // ciphertext is in memory. Captured before the worker call, which can
      // be suspended for a long time (frozen background tab, app switch).
      const primary = addresses?.pearl ?? (await loadKeystore())?.publicData.pearlAddress;
      if (!primary) throw new Error("E_NO_WALLET");
      const out = await cryptoWorker.call<"changePassword", { blob: KeystoreBlobJSON }>(
        "changePassword",
        { oldPassword: oldPw, newPassword: newPw, blob },
      );
      // Race window: while the worker ran, another tab may have wiped this
      // wallet, restored or created a different one under the same row, or
      // changed the password itself. The write is a compare-and-update on
      // the wallet identity and the exact ciphertext we started from; on
      // any mismatch nothing is written (writing would re-encrypt this
      // wallet's secret over another wallet's record, or revert the other
      // tab's password). Only the blob is replaced: the address lists on
      // disk may have been extended by another tab since we last read them.
      const result = await replaceKeystoreBlob(out.blob, { primary, blob });
      if (result !== "replaced") {
        cryptoWorker.reset();
        clearBalanceMemory();
        const fresh = result === "wiped" ? undefined : await loadKeystore();
        if (fresh) {
          // A wallet is still stored, just not the one this session held:
          // lock onto the stored record so the next unlock uses it.
          set({
            status: "locked",
            addresses: null,
            blob: fresh.blob,
            pearlAddressGeneration: get().pearlAddressGeneration + 1,
          });
          throw new Error("E_WALLET_CHANGED");
        }
        set({ status: "no-wallet", addresses: null, blob: null });
        throw new Error("E_WALLET_WIPED");
      }
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
    set({ lastActivity: monotonicNow() });
  },

  setEthNetwork(net) {
    set({ ethNetwork: net });
  },

  async derivePearlAddresses(branch, start, count) {
    const { pearlNetwork } = get();
    const out = await cryptoWorker.call<"derivePearlAddresses", { addresses: string[] }>(
      "derivePearlAddresses",
      { network: pearlNetwork, branch, start, count },
    );
    return out.addresses;
  },

  pearlDiscoveryHandler() {
    const generation = get().pearlAddressGeneration;
    return (next) => get().extendPearlAddresses(next, generation);
  },

  async extendPearlAddresses(next, generation) {
    return walletLock(async () => {
      const { status, addresses, pearlAddressGeneration: gen } = get();
      if (status !== "unlocked" || !addresses) return false;
      if (generation !== undefined && generation !== gen) return false;
      const curExt = addresses.pearlPool;
      const curInt = addresses.pearlChange ?? [];
      const ext = next.external.slice(0, MAX_ADDRESSES_PER_BRANCH);
      const int = next.internal.slice(0, MAX_ADDRESSES_PER_BRANCH);
      if (!isPrefixExtension(curExt, ext) || !isPrefixExtension(curInt, int)) return false;
      if (ext.length === curExt.length && int.length === curInt.length) return false;
      // Address lists only, read and written in one transaction: a password
      // change another tab committed meanwhile is kept.
      const saved = await updateKeystoreAddresses(
        { pearlAddress: curExt[0]!, pearlAddressPool: ext, pearlChangePool: int },
        curExt[0],
      );
      if (!saved) return false;
      // A lock (or reset) while the keystore was written: publish nothing.
      if (get().status !== "unlocked" || get().pearlAddressGeneration !== gen) return false;
      set({ addresses: { ...addresses, pearlPool: [...ext], pearlChange: [...int] } });
      return true;
    });
  },

  async resetPearlAddresses() {
    // Bump first: every scan already running (or queued behind the lock)
    // was planned over the list being discarded.
    set({ pearlAddressGeneration: get().pearlAddressGeneration + 1 });
    return walletLock(async () => {
      const { status, addresses, pearlAddressGeneration: gen } = get();
      if (status !== "unlocked" || !addresses) return false;
      const ext = addresses.pearlPool.slice(0, RECEIVE_GAP_LIMIT);
      const int = (addresses.pearlChange ?? []).slice(0, RECEIVE_GAP_LIMIT);
      const saved = await updateKeystoreAddresses(
        { pearlAddress: addresses.pearlPool[0]!, pearlAddressPool: ext, pearlChangePool: int },
        addresses.pearlPool[0],
      );
      if (!saved) return false;
      // Locked while the keystore was written: publish nothing (lock
      // already cleared the session's memory).
      if (get().status !== "unlocked" || get().pearlAddressGeneration !== gen) return false;
      // Scan baselines and cached scans describe the longer lists.
      clearBalanceMemory();
      // Bump again as the short lists become visible: a scan that started
      // while this reset waited for the lock or the keystore bound the
      // first bump but copied the long lists, and must not extend them.
      set({
        addresses: { ...addresses, pearlPool: ext, pearlChange: int },
        pearlAddressGeneration: get().pearlAddressGeneration + 1,
      });
      return true;
    });
  },
}));
