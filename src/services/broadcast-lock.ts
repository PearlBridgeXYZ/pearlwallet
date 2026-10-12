// The wallet's broadcast lock (services/pending-spends.ts). Every write of
// the broadcast records — and every broadcast, from signing until its
// outcome is saved — runs inside one exclusive Web Locks lock
// (navigator.locks), so tabs are serialised by the browser itself: a tab
// that stalls or is suspended mid-broadcast still holds the lock, and no
// other tab can release its coins or start a broadcast meanwhile. Waiting
// is bounded; a lock that isn't granted refuses ("busy") and nothing runs.
//
// Without Web Locks (old browsers): an in-tab queue with the same rules,
// and a single-tab guard — open tabs list themselves under
// WALLET_TABS_STORAGE_KEY and a tab broadcasts only while it is the only
// one listed (fail closed). A tab that died listed is cleared by the user,
// never by a timer.

export type RefusalReason = "conflict" | "unresolved" | "storage" | "busy" | "second-tab";

/** A broadcast refused before anything was sent. */
export class BroadcastRefusedError extends Error {
  constructor(readonly reason: RefusalReason, message: string, readonly txids: string[] = []) {
    super(message);
    this.name = "BroadcastRefusedError";
  }
}

export const WALLET_TABS_STORAGE_KEY = "pearl-wallet-tabs-v1";
/** How long a broadcast or release waits for another tab's broadcast. */
export const LOCK_WAIT_MS = 15_000;
const LOCK_NAME = "pearl-wallet-broadcast";

/** The cross-tab lock every Ethereum send (ETH, WPRL, approve, burn) from
 *  this network + address holds from its unresolved-record check through
 *  nonce read, signing, broadcast and outcome recording (services/eth-tx). */
export function ethBroadcastLockName(network: string, from: string): string {
  return `pearl-wallet-eth-broadcast:${network}:${from.toLowerCase()}`;
}

const busy = () => new BroadcastRefusedError("busy", "E_BROADCAST_BUSY: another wallet tab is broadcasting");

type LockOptions = { mode: "exclusive"; signal?: AbortSignal; ifAvailable?: boolean };
interface LockManagerLike {
  request<T>(name: string, opts: LockOptions, cb: (lock: unknown) => Promise<T>): Promise<T>;
  query?: () => Promise<{ held?: Array<{ name?: string }> }>;
}

function lockManager(): LockManagerLike | null {
  try {
    const l = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    return l && typeof l.request === "function" ? l : null;
  } catch {
    return null;
  }
}

/** Runs `fn` holding the wallet's exclusive broadcast lock, waiting at most
 *  `waitMs` (with `ifAvailable`: not at all). Not granted → "busy" refusal
 *  and `fn` never runs. Without Web Locks: an in-tab queue with the same
 *  rules plus the single-tab guard below. `name` picks another lock (the
 *  Ethereum sends lock per network + address: ethBroadcastLockName). */
export async function withBroadcastLock<T>(
  fn: () => Promise<T>,
  opts: { waitMs?: number; ifAvailable?: boolean; name?: string } = {},
): Promise<T> {
  const locks = lockManager();
  if (!locks) return withTabGuard(fn, opts);
  const ctrl = new AbortController();
  const timer = opts.ifAvailable ? undefined : setTimeout(() => ctrl.abort(), opts.waitMs ?? LOCK_WAIT_MS);
  let granted = false;
  try {
    const how = opts.ifAvailable ? { ifAvailable: true } : { signal: ctrl.signal };
    return await locks.request(opts.name ?? LOCK_NAME, { mode: "exclusive", ...how }, async (lock) => {
      granted = true;
      clearTimeout(timer);
      if (lock === null) throw busy();
      return fn();
    });
  } catch (e) {
    throw granted ? e : busy();
  } finally {
    clearTimeout(timer);
  }
}

/** With Web Locks: whether some context (any tab) holds lock `name` now.
 *  Reads navigator.locks.query() (takes nothing); where query is missing,
 *  tries the lock with `ifAvailable` and lets it go at once. Throws if
 *  neither works; the caller decides how to fail. */
export async function webLockHeld(name: string): Promise<boolean> {
  const locks = lockManager();
  if (!locks) throw new Error("no Web Locks");
  if (typeof locks.query === "function") {
    const snap = await locks.query();
    return (snap.held ?? []).some((l) => l.name === name);
  }
  return locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => lock === null);
}

// ─── Single-tab guard (no Web Locks) ─────────────────────────────────────

const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let tabQueue: Promise<void> = Promise.resolve();

function listedTabs(): string[] | null {
  try {
    const raw = localStorage.getItem(WALLET_TABS_STORAGE_KEY);
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(v) && v.every((t) => typeof t === "string") ? v : null;
  } catch {
    return null;
  }
}

function listTabs(ids: string[]): void {
  try {
    localStorage.setItem(WALLET_TABS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* the guard then refuses */
  }
}

if (!lockManager() && typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const others = () => (listedTabs() ?? []).filter((t) => t !== tabId);
  listTabs([...others(), tabId]);
  // A page entering the back/forward cache (persisted) is still a live
  // tab that can resume mid-broadcast: it stays listed. Only a real unload
  // unlists it.
  window.addEventListener("pagehide", (e: Event) => {
    if ((e as { persisted?: boolean }).persisted !== true) listTabs(others());
  });
  window.addEventListener("pageshow", () => listTabs([...others(), tabId]));
}

/** This page's id (one per page load), as listed by the single-tab guard
 *  and as the owner of an in-flight Ethereum broadcast record. */
export const thisTabId = tabId;

/** Whether this browser has Web Locks (navigator.locks.request). */
export const hasWebLocks = (): boolean => lockManager() !== null;

/** Without Web Locks: whether tab `id` is (or may be) still open — listed
 *  by the single-tab guard, or the list is unreadable (fail closed). */
export function walletTabMayBeOpen(id: string): boolean {
  const tabs = listedTabs();
  return tabs === null || tabs.includes(id);
}

/** Without Web Locks: another wallet tab is (or may be) open. */
export function otherWalletTabOpen(): boolean {
  if (lockManager()) return false;
  const tabs = listedTabs();
  return tabs === null || tabs.some((t) => t !== tabId);
}

/** The user states that no other wallet tab is open. */
export const claimOnlyTab = (): void => listTabs([tabId]);

async function withTabGuard<T>(fn: () => Promise<T>, opts: { waitMs?: number; ifAvailable?: boolean }): Promise<T> {
  const prev = tabQueue;
  let done!: () => void;
  tabQueue = prev.then(() => new Promise<void>((r) => (done = r)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wait = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), opts.ifAvailable ? 0 : (opts.waitMs ?? LOCK_WAIT_MS))));
    if (!(await Promise.race([prev.then(() => true), wait]))) throw busy();
    if (otherWalletTabOpen()) throw new BroadcastRefusedError("second-tab", "E_SECOND_TAB: another wallet tab is open");
    return await fn();
  } finally {
    clearTimeout(timer);
    // The next caller waits for the previous holder AND this one. (`done`
    // exists once `prev` has settled; a caller that gave up doesn't wait.)
    void prev.then(() => done());
  }
}
