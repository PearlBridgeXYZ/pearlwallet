// Outpoints spent by transactions this wallet broadcast recently.
//
// Why: the UTXO walk may not reflect the mempool, and the dashboard's
// cached spendable set can be up to 30 s old. Without this list a send or
// a consolidation batch composed right after another broadcast could pick
// coins that are already being spent — the node rejects the conflict at
// best, and a re-run consolidation would try to spend the same coins
// twice. Every successful (or status-unknown) Pearl broadcast records its
// inputs here; coin selection and consolidation planning exclude them.
//
// Entries expire after PENDING_SPEND_TTL_MS. By then the spending tx has
// either confirmed (the coins are gone from every walk) or was dropped
// (the coins are spendable again). Send, the dashboard and Consolidate can
// release ONE transaction's coins by hand, after status checks showed the
// node does not have it (two negative checks PENDING_RELEASE_RECHECK_MS
// apart, or one plus the user's explicit explorer acknowledgement).
//
// Storage: an in-process list that every read merges with localStorage
// (survives reloads, so a re-run after a refresh is still protected).
// Persisting is best-effort; a failed write never loses the record for
// this session. Contents are public chain data (outpoints + txids), no
// key material.
//
// Releases are recorded as tombstones {outpoint, spentBy, releasedAt}
// (own storage key, also kept in memory). A tombstone beats any record of
// the same outpoint + spending tx recorded at or before the release, so a
// second tab still holding the old record in memory — or a storage write
// that failed — can no longer resurrect a released reservation. Other tabs
// learn of a release through the storage event and a BroadcastChannel
// message (the latter also works when the storage write failed).
//
// Reservation: every broadcast path (Send, consolidation, offline
// broadcast, vault broadcast) goes through reservePendingSpends right
// before submitting: it refuses when another transaction already spends
// one of the inputs and records the inputs in the same synchronous step
// (cross-tab: inside the Web Locks API lock "pearl-pending-spends" when
// the browser has it). A definite node rejection releases the reservation
// — unless another submission of the same tx is still in flight or
// already succeeded / ended "status unknown"; success and "status unknown"
// keep it.
//
// Payment intents: the same locked step that reserves the inputs also
// records an intent {txid, destination, amountGrains, at} and a submission
// attempt {id, txid, added, lease, state} — BEFORE anything is sent. So a
// reload or a closed tab during an in-flight broadcast still leaves a
// visible, checkable entry, and Send can ask for an explicit "may pay
// twice" acknowledgement before paying the same destination again. The
// intent is resolved when the node accepts the tx, when a status check
// finds it, or when its coins are released; a status-unknown outcome
// leaves it open. A reservation with no intent record at all (a failed
// write, or one made by an older version) is shown as well, with its
// destination unknown.
//
// Submission attempts live in storage too (own key), so the "is a
// submission of this tx still in flight?" question has the same answer in
// every tab: an attempt holds a lease that its tab renews while it waits
// for the node; an attempt whose lease ran out (tab closed / reloaded) is
// treated as "status unknown". A rejected attempt releases coins only in
// the same locked step that re-reads every attempt of that tx: never while
// another attempt is in flight, and never once one was accepted or ended
// "status unknown".

export const PENDING_SPEND_TTL_MS = 6 * 60 * 60 * 1000;
export const PENDING_SPENDS_STORAGE_KEY = "pearl-wallet-pending-spends-v1";
export const PENDING_RELEASES_STORAGE_KEY = "pearl-wallet-pending-releases-v1";
export const PENDING_INTENTS_STORAGE_KEY = "pearl-wallet-pending-intents-v1";
export const PENDING_ATTEMPTS_STORAGE_KEY = "pearl-wallet-pending-attempts-v1";
/** An in-flight submission's lease; its tab renews it every
 *  SUBMISSION_LEASE_RENEW_MS while waiting for the node. */
export const SUBMISSION_LEASE_MS = 45_000;
export const SUBMISSION_LEASE_RENEW_MS = 15_000;
/** Two "node doesn't have it" checks this far apart unlock a manual
 *  release without an explorer acknowledgement. */
export const PENDING_RELEASE_RECHECK_MS = 30_000;
/** Bound on stored entries so a corrupted or hostile value can't grow
 *  without limit. Several full consolidation batches fit comfortably. */
const MAX_ENTRIES = 20_000;
const MAX_INTENTS = 500;
const MAX_ATTEMPTS = 500;
const LOCK_NAME = "pearl-pending-spends";
const CHANNEL_NAME = "pearl-pending-spends";

export interface PendingSpend {
  /** "txid:vout" of the spent coin (txid lower-case). */
  outpoint: string;
  /** Txid of the spending transaction, when known. */
  spentBy: string | null;
  recordedAt: number;
}

/** A released reservation. Wins over records of the same outpoint and
 *  spending tx recorded at or before `releasedAt`. */
export interface PendingRelease {
  outpoint: string;
  spentBy: string | null;
  releasedAt: number;
}

/** What a broadcast was meant to do (recorded before submission). */
export interface PendingIntent {
  txid: string;
  /** Address paid (outputs[0]), canonical lower-case; null when not known
   *  (offline / vault / consolidation). */
  destination: string | null;
  amountGrains: string | null;
  at: number;
  /** Set once the status was resolved (node holds it, or released). */
  resolvedAt: number | null;
}

export type SubmissionState = "in-flight" | "accepted" | "unknown" | "rejected";

/** One submission attempt of a transaction (any tab). */
export interface PendingAttempt {
  /** Unique per attempt. */
  id: string;
  /** Txid being submitted (lower-case); null when it can't be computed. */
  txid: string | null;
  /** Outpoints this attempt's reservation added. */
  added: string[];
  startedAt: number;
  /** While "in-flight": the lease end. Past it the attempt is treated as
   *  abandoned with an unknown outcome. */
  until: number;
  state: SubmissionState;
}

// Canonical in-process copies. Every read merges them with whatever storage
// holds, so a record whose storage write failed (quota, partitioned or
// read-only storage) still counts for the rest of the session.
let memory: PendingSpend[] = [];
let memoryReleases: PendingRelease[] = [];
let memoryIntents: PendingIntent[] = [];
let memoryAttempts: PendingAttempt[] = [];

// ─── Change notification (UI re-render, other tabs) ──────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

function notify(): void {
  version++;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a listener's failure must not break a release */
    }
  }
}

/** Subscribe to any change of the pending list (this tab or another). */
export function subscribePendingSpends(l: Listener): () => void {
  listeners.add(l);
  ensureCrossTabWiring();
  return () => void listeners.delete(l);
}

/** Monotonic change counter (snapshot for useSyncExternalStore). */
export function pendingSpendsVersion(): number {
  return version;
}

let channel: BroadcastChannel | null = null;
let wired = false;
function ensureCrossTabWiring(): void {
  if (wired) return;
  wired = true;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL_NAME);
      // Never keep a non-browser runtime (tests, tooling) alive.
      (channel as unknown as { unref?: () => void }).unref?.();
      channel.onmessage = (ev: MessageEvent) => {
        const data = ev.data as { releases?: unknown; intents?: unknown; attempts?: unknown } | null;
        const now = Date.now();
        if (data && Array.isArray(data.releases)) {
          memoryReleases = pruneReleases(mergeReleases(memoryReleases, data.releases.filter(isRelease)), now);
        }
        if (data && Array.isArray(data.intents)) {
          memoryIntents = pruneIntents(mergeIntents(memoryIntents, data.intents.filter(isIntent).map(normalizeIntent)), now);
        }
        if (data && Array.isArray(data.attempts)) {
          memoryAttempts = pruneAttempts(mergeAttempts(memoryAttempts, data.attempts.filter(isAttempt)), now);
        }
        notify();
      };
    }
  } catch {
    channel = null;
  }
  try {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("storage", (ev: StorageEvent) => {
        if (
          ev.key === null ||
          ev.key === PENDING_SPENDS_STORAGE_KEY ||
          ev.key === PENDING_RELEASES_STORAGE_KEY ||
          ev.key === PENDING_INTENTS_STORAGE_KEY ||
          ev.key === PENDING_ATTEMPTS_STORAGE_KEY
        ) {
          notify();
        }
      });
    }
  } catch {
    /* no window (worker / tests) */
  }
}

function postToOtherTabs(msg: {
  releases?: PendingRelease[];
  intents?: PendingIntent[];
  attempts?: PendingAttempt[];
}): void {
  ensureCrossTabWiring();
  try {
    channel?.postMessage(msg);
  } catch {
    /* closed channel: storage remains the fallback */
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function outpointKey(u: { txid: string; vout: number }): string {
  return `${u.txid.toLowerCase()}:${u.vout}`;
}

const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/;
const TXID_RE = /^[0-9a-f]{64}$/;

/** Canonical form of a destination for "same address?" comparisons.
 *  Bech32m addresses are valid all-lower-case or all-upper-case (never
 *  mixed); both spell the same address, so compare lower-cased. */
export function canonicalDestination(d: string): string {
  return d.trim().toLowerCase();
}

function isEntry(e: unknown): e is PendingSpend {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.outpoint === "string" &&
    OUTPOINT_RE.test(x.outpoint) &&
    (x.spentBy === null || typeof x.spentBy === "string") &&
    typeof x.recordedAt === "number" &&
    Number.isFinite(x.recordedAt)
  );
}

function isRelease(e: unknown): e is PendingRelease {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.outpoint === "string" &&
    OUTPOINT_RE.test(x.outpoint) &&
    (x.spentBy === null || typeof x.spentBy === "string") &&
    typeof x.releasedAt === "number" &&
    Number.isFinite(x.releasedAt)
  );
}

function isIntent(e: unknown): e is PendingIntent {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.txid === "string" &&
    TXID_RE.test(x.txid) &&
    (x.destination === null || typeof x.destination === "string") &&
    (x.amountGrains === null || (typeof x.amountGrains === "string" && /^\d+$/.test(x.amountGrains))) &&
    typeof x.at === "number" &&
    Number.isFinite(x.at) &&
    (x.resolvedAt === null || (typeof x.resolvedAt === "number" && Number.isFinite(x.resolvedAt)))
  );
}

const SUBMISSION_STATES: readonly string[] = ["in-flight", "accepted", "unknown", "rejected"];

function isAttempt(e: unknown): e is PendingAttempt {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    x.id.length > 0 &&
    x.id.length <= 100 &&
    (x.txid === null || (typeof x.txid === "string" && TXID_RE.test(x.txid))) &&
    Array.isArray(x.added) &&
    x.added.every((o) => typeof o === "string" && OUTPOINT_RE.test(o)) &&
    typeof x.startedAt === "number" &&
    Number.isFinite(x.startedAt) &&
    typeof x.until === "number" &&
    Number.isFinite(x.until) &&
    typeof x.state === "string" &&
    SUBMISSION_STATES.includes(x.state)
  );
}

function normalizeIntent(i: PendingIntent): PendingIntent {
  return i.destination === null ? i : { ...i, destination: canonicalDestination(i.destination) };
}

function readList<T>(key: string, guard: (e: unknown) => e is T, max: number): T[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard).slice(-max) : [];
  } catch {
    return [];
  }
}

// Keys whose latest write failed. Every write stores the whole merged list
// (storage + this tab's memory), so the next successful write of a key
// makes everything this tab holds for it durable again.
const failedKeys = new Set<string>();

/** Writes `value` under `key`. True when it reached storage (or there is
 *  no storage at all, so nothing stale can come back from it). */
function writeList(key: string, value: unknown[]): boolean {
  const s = storage();
  if (!s) return true;
  try {
    s.setItem(key, JSON.stringify(value));
    failedKeys.delete(key);
    return true;
  } catch {
    failedKeys.add(key);
    return false;
  }
}

export interface PendingPersistenceIssue {
  /** A reservation, payment intent or submission record exists only in
   *  this tab: after a reload it may not be shown or protected. */
  records: boolean;
  /** A release exists only in this tab: after a reload (or in another
   *  tab) those coins may show as reserved again. */
  releases: boolean;
}

/** Whether this tab holds pending-spend state the browser couldn't save. */
export function pendingPersistenceIssue(): PendingPersistenceIssue | null {
  const records =
    failedKeys.has(PENDING_SPENDS_STORAGE_KEY) ||
    failedKeys.has(PENDING_INTENTS_STORAGE_KEY) ||
    failedKeys.has(PENDING_ATTEMPTS_STORAGE_KEY);
  const releases = failedKeys.has(PENDING_RELEASES_STORAGE_KEY);
  return records || releases ? { records, releases } : null;
}

/** Union by outpoint. On a conflict the later record wins (longer
 *  protection); a known spending txid is never replaced by null. */
function merge(a: readonly PendingSpend[], b: readonly PendingSpend[]): PendingSpend[] {
  const byKey = new Map<string, PendingSpend>();
  for (const e of [...a, ...b]) {
    const prev = byKey.get(e.outpoint);
    if (!prev) {
      byKey.set(e.outpoint, e);
      continue;
    }
    const later = e.recordedAt >= prev.recordedAt ? e : prev;
    const other = later === e ? prev : e;
    byKey.set(e.outpoint, later.spentBy === null && other.spentBy !== null ? { ...later, spentBy: other.spentBy } : later);
  }
  return [...byKey.values()];
}

const releaseKey = (r: { outpoint: string; spentBy: string | null }) => `${r.outpoint}|${r.spentBy ?? ""}`;

/** Union of tombstones; the latest release of an outpoint + tx wins. */
function mergeReleases(a: readonly PendingRelease[], b: readonly PendingRelease[]): PendingRelease[] {
  const byKey = new Map<string, PendingRelease>();
  for (const r of [...a, ...b]) {
    const k = releaseKey(r);
    const prev = byKey.get(k);
    if (!prev || r.releasedAt > prev.releasedAt) byKey.set(k, r);
  }
  return [...byKey.values()];
}

/** Tombstones outlive every record they can cover (records expire
 *  PENDING_SPEND_TTL_MS after recordedAt <= releasedAt); older ones are
 *  dropped, and the list is bounded. */
function pruneReleases(releases: readonly PendingRelease[], now: number): PendingRelease[] {
  return releases.filter((r) => now - r.releasedAt < PENDING_SPEND_TTL_MS).slice(-MAX_ENTRIES);
}

/** Drops every record a tombstone covers (same outpoint and spending tx,
 *  recorded at or before the release). */
function applyReleases(entries: readonly PendingSpend[], releases: readonly PendingRelease[]): PendingSpend[] {
  if (releases.length === 0) return [...entries];
  const at = new Map<string, number>();
  for (const r of releases) at.set(releaseKey(r), r.releasedAt);
  return entries.filter((e) => {
    const releasedAt = at.get(releaseKey(e));
    return releasedAt === undefined || e.recordedAt > releasedAt;
  });
}

const intentClock = (i: PendingIntent) => Math.max(i.at, i.resolvedAt ?? -Infinity);

/** Union by txid; the most recent event (record or resolution) wins, a
 *  resolution winning a tie. */
function mergeIntents(a: readonly PendingIntent[], b: readonly PendingIntent[]): PendingIntent[] {
  const byKey = new Map<string, PendingIntent>();
  for (const i of [...a, ...b]) {
    const prev = byKey.get(i.txid);
    if (!prev) {
      byKey.set(i.txid, i);
      continue;
    }
    const ci = intentClock(i);
    const cp = intentClock(prev);
    if (ci > cp || (ci === cp && i.resolvedAt !== null && prev.resolvedAt === null)) byKey.set(i.txid, i);
  }
  return [...byKey.values()];
}

function pruneIntents(intents: readonly PendingIntent[], now: number): PendingIntent[] {
  return intents.filter((i) => now - intentClock(i) < PENDING_SPEND_TTL_MS).slice(-MAX_INTENTS);
}

const attemptRank = (a: PendingAttempt) => (a.state === "in-flight" ? 0 : 1);

/** Union by attempt id. An attempt only moves forward (in flight → final);
 *  a final state beats "in-flight", a later lease beats an earlier one. */
function mergeAttempts(a: readonly PendingAttempt[], b: readonly PendingAttempt[]): PendingAttempt[] {
  const byKey = new Map<string, PendingAttempt>();
  for (const x of [...a, ...b]) {
    const prev = byKey.get(x.id);
    if (!prev) {
      byKey.set(x.id, x);
      continue;
    }
    const rx = attemptRank(x);
    const rp = attemptRank(prev);
    if (rx > rp || (rx === rp && rx === 0 && x.until > prev.until)) byKey.set(x.id, x);
  }
  return [...byKey.values()];
}

function pruneAttempts(attempts: readonly PendingAttempt[], now: number): PendingAttempt[] {
  return attempts.filter((a) => now - Math.max(a.startedAt, a.until) < PENDING_SPEND_TTL_MS).slice(-MAX_ATTEMPTS);
}

function loadReleases(now: number = Date.now()): PendingRelease[] {
  // Also prunes this tab's copy (a passive tab that only receives
  // tombstones never saves any).
  memoryReleases = pruneReleases(memoryReleases, now);
  return pruneReleases(mergeReleases(readList(PENDING_RELEASES_STORAGE_KEY, isRelease, MAX_ENTRIES), memoryReleases), now);
}

/** Storage and memory, each filtered by the tombstones FIRST: a released
 *  record must never shadow a live record of the same outpoint (another
 *  tx's reservation) whatever their timestamps. */
function load(now: number = Date.now()): PendingSpend[] {
  const releases = loadReleases(now);
  return merge(
    applyReleases(readList(PENDING_SPENDS_STORAGE_KEY, isEntry, MAX_ENTRIES), releases),
    applyReleases(memory, releases),
  ).slice(-MAX_ENTRIES);
}

function loadIntents(): PendingIntent[] {
  return mergeIntents(
    readList(PENDING_INTENTS_STORAGE_KEY, isIntent, MAX_INTENTS).map(normalizeIntent),
    memoryIntents.map(normalizeIntent),
  );
}

function loadAttempts(): PendingAttempt[] {
  return mergeAttempts(readList(PENDING_ATTEMPTS_STORAGE_KEY, isAttempt, MAX_ATTEMPTS), memoryAttempts);
}

/** Persists the list (and, when given, the tombstones). Memory first: it
 *  is the copy every later read in this tab is guaranteed to see. Returns
 *  whether everything reached storage. */
function save(entries: PendingSpend[], releases?: PendingRelease[], now: number = Date.now()): boolean {
  const bounded = entries.slice(-MAX_ENTRIES);
  memory = bounded;
  let durable = writeList(PENDING_SPENDS_STORAGE_KEY, bounded);
  if (releases) {
    const kept = pruneReleases(releases, now);
    memoryReleases = kept;
    durable = writeList(PENDING_RELEASES_STORAGE_KEY, kept) && durable;
  }
  notify();
  return durable;
}

function saveIntents(intents: PendingIntent[], now: number): boolean {
  const kept = pruneIntents(intents, now);
  memoryIntents = kept;
  const durable = writeList(PENDING_INTENTS_STORAGE_KEY, kept);
  notify();
  return durable;
}

function saveAttempts(attempts: PendingAttempt[], now: number): boolean {
  const kept = pruneAttempts(attempts, now);
  memoryAttempts = kept;
  const durable = writeList(PENDING_ATTEMPTS_STORAGE_KEY, kept);
  notify();
  return durable;
}

function live(entries: PendingSpend[], now: number): PendingSpend[] {
  // A recordedAt in the future (clock moved back) is treated as fresh, not
  // dropped — failing safe means keeping the exclusion.
  return entries.filter((e) => now - e.recordedAt < PENDING_SPEND_TTL_MS);
}

// ─── Cross-tab lock ──────────────────────────────────────────────────────

interface LockManagerLike {
  request<T>(name: string, opts: { mode: "exclusive" }, cb: () => Promise<T> | T): Promise<T>;
}

/**
 * Runs `fn` (a synchronous read-modify-write of the pending list) inside
 * the cross-tab Web Locks lock when the browser has one, so two tabs can't
 * interleave a reservation. Without the API (or if it refuses to grant
 * the lock) `fn` runs directly — still atomic within this tab.
 */
export async function withPendingSpendsLock<T>(fn: () => T): Promise<T> {
  let locks: LockManagerLike | undefined;
  try {
    locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  } catch {
    locks = undefined;
  }
  if (!locks || typeof locks.request !== "function") return fn();
  let ran = false;
  try {
    return await locks.request(LOCK_NAME, { mode: "exclusive" }, () => {
      ran = true;
      return fn();
    });
  } catch (err) {
    if (ran) throw err;
    return fn();
  }
}

// ─── Records ─────────────────────────────────────────────────────────────

/** Records that `spentBy` (null when the txid is unknown) spends `inputs`. */
export function recordPendingSpends(
  spentBy: string | null,
  inputs: readonly { txid: string; vout: number }[],
  now: number = Date.now(),
): void {
  const entries = live(load(now), now);
  const have = new Set(entries.map((e) => e.outpoint));
  const self = spentBy ? spentBy.toLowerCase() : null;
  const released = releaseTimes(loadReleases(now));
  for (const u of inputs) {
    const k = outpointKey(u);
    if (have.has(k)) continue;
    have.add(k);
    entries.push({ outpoint: k, spentBy: self, recordedAt: freshRecordTime(released, k, self, now) });
  }
  save(entries, undefined, now);
}

function releaseTimes(releases: readonly PendingRelease[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of releases) m.set(releaseKey(r), r.releasedAt);
  return m;
}

/** A new record must post-date any earlier release of the same outpoint +
 *  tx, or that tombstone would hide it. */
function freshRecordTime(released: Map<string, number>, outpoint: string, spentBy: string | null, now: number): number {
  const r = released.get(releaseKey({ outpoint, spentBy }));
  return r !== undefined && r >= now ? r + 1 : now;
}

/** Outpoints spent by a recent broadcast that may not be visible yet. */
export function pendingOutpoints(now: number = Date.now()): Set<string> {
  return new Set(live(load(now), now).map((e) => e.outpoint));
}

export function pendingSpendList(now: number = Date.now()): PendingSpend[] {
  return live(load(now), now);
}

/** Splits `utxos` into spendable and already-being-spent coins. */
export function excludePendingSpends<T extends { txid: string; vout: number }>(
  utxos: readonly T[],
  now: number = Date.now(),
): { spendable: T[]; pending: T[] } {
  const p = pendingOutpoints(now);
  const spendable: T[] = [];
  const pending: T[] = [];
  for (const u of utxos) (p.has(outpointKey(u)) ? pending : spendable).push(u);
  return { spendable, pending };
}

/** Forgets everything — memory AND storage (wallet wipe; tests). Not for
 *  lock: reservations must survive a lock. */
export function clearPendingSpends(): void {
  memory = [];
  memoryReleases = [];
  memoryIntents = [];
  memoryAttempts = [];
  failedKeys.clear();
  probeLog.clear();
  const s = storage();
  if (s) {
    for (const k of [
      PENDING_SPENDS_STORAGE_KEY,
      PENDING_RELEASES_STORAGE_KEY,
      PENDING_INTENTS_STORAGE_KEY,
      PENDING_ATTEMPTS_STORAGE_KEY,
    ]) {
      try {
        s.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  }
  notify();
}

/** A coin is already being spent by a different recent broadcast. */
export class PendingSpendConflictError extends Error {
  readonly code = "E_INPUT_PENDING" as const;
  constructor(
    readonly outpoint: string,
    readonly spentBy: string | null,
  ) {
    super(`E_INPUT_PENDING: ${outpoint} is already being spent by ${spentBy ?? "a recent transaction"}`);
    this.name = "PendingSpendConflictError";
  }
}

/** Throws PendingSpendConflictError if any input is already pending,
 *  unless it is pending for this very transaction (`spentBy`, e.g. a
 *  re-broadcast of the same signed tx). */
export function assertNotPending(
  inputs: readonly { txid: string; vout: number }[],
  spentBy: string | null = null,
  now: number = Date.now(),
): void {
  const self = spentBy ? spentBy.toLowerCase() : null;
  const byKey = new Map(live(load(now), now).map((e) => [e.outpoint, e] as const));
  for (const u of inputs) {
    const e = byKey.get(outpointKey(u));
    if (e && (self === null || e.spentBy !== self)) throw new PendingSpendConflictError(e.outpoint, e.spentBy);
  }
}

/**
 * Check-and-record in one synchronous step, immediately before a
 * broadcast: refuses (PendingSpendConflictError) when any input is pending
 * for another transaction, else records every input as spent by
 * `spentBy`. Returns the outpoints this call added, for
 * releasePendingSpends after a definite rejection. Callers in a browser
 * wrap it in withPendingSpendsLock.
 */
export function reservePendingSpends(
  spentBy: string | null,
  inputs: readonly { txid: string; vout: number }[],
  now: number = Date.now(),
): string[] {
  return reserveInternal(spentBy, inputs, now).added;
}

function reserveInternal(
  spentBy: string | null,
  inputs: readonly { txid: string; vout: number }[],
  now: number,
): { added: string[]; durable: boolean } {
  const self = spentBy ? spentBy.toLowerCase() : null;
  const entries = live(load(now), now);
  const byKey = new Map(entries.map((e) => [e.outpoint, e] as const));
  for (const u of inputs) {
    const e = byKey.get(outpointKey(u));
    if (e && (self === null || e.spentBy !== self)) throw new PendingSpendConflictError(e.outpoint, e.spentBy);
  }
  const released = releaseTimes(loadReleases(now));
  const added: string[] = [];
  for (const u of inputs) {
    const k = outpointKey(u);
    if (byKey.has(k)) continue;
    const entry: PendingSpend = { outpoint: k, spentBy: self, recordedAt: freshRecordTime(released, k, self, now) };
    byKey.set(k, entry);
    entries.push(entry);
    added.push(k);
  }
  const durable = save(entries, undefined, now);
  return { added, durable };
}

/**
 * Tombstones `drop` (records of `self`). Each tombstone is stamped no
 * earlier than the record it removes — a re-reservation may carry a
 * recordedAt past the wall clock (freshRecordTime, or a clock that moved
 * back) and must still be covered. True only when the write reached
 * storage AND the targeted records are gone.
 */
function releaseInternal(drop: ReadonlySet<string>, self: string | null, now: number): boolean {
  const current = load(now);
  const stamp = new Map<string, number>();
  for (const e of current) {
    if (drop.has(e.outpoint) && e.spentBy === self) {
      stamp.set(e.outpoint, Math.max(now, e.recordedAt, stamp.get(e.outpoint) ?? -Infinity));
    }
  }
  const fresh: PendingRelease[] = [...drop].map((outpoint) => ({
    outpoint,
    spentBy: self,
    releasedAt: stamp.get(outpoint) ?? now,
  }));
  const allReleases = mergeReleases(loadReleases(now), fresh);
  const kept = applyReleases(current, fresh);
  const durable = save(kept, allReleases, now);
  postToOtherTabs({ releases: fresh });
  const gone = !load(now).some((e) => drop.has(e.outpoint) && e.spentBy === self);
  return durable && gone;
}

/** Undoes a reservation after the node definitely rejected the tx. Only
 *  the outpoints that reservation added, and only while they still name
 *  the same spending tx, are removed. Returns whether the release reached
 *  storage (false: this tab honours it, but a reload may not). */
export function releasePendingSpends(
  outpoints: readonly string[],
  spentBy: string | null,
  now: number = Date.now(),
): boolean {
  if (outpoints.length === 0) return true;
  const self = spentBy ? spentBy.toLowerCase() : null;
  return releaseInternal(new Set(outpoints), self, now);
}

/** Pending broadcasts grouped by spending txid (null = unknown txid). */
export function pendingTransactions(now: number = Date.now()): { spentBy: string | null; coins: number; recordedAt: number }[] {
  const groups = new Map<string | null, { spentBy: string | null; coins: number; recordedAt: number }>();
  for (const e of live(load(now), now)) {
    const g = groups.get(e.spentBy);
    if (g) {
      g.coins++;
      if (e.recordedAt > g.recordedAt) g.recordedAt = e.recordedAt;
    } else {
      groups.set(e.spentBy, { spentBy: e.spentBy, coins: 1, recordedAt: e.recordedAt });
    }
  }
  return [...groups.values()].sort((a, b) => b.recordedAt - a.recordedAt);
}

/** A submission of this transaction is still waiting for the node. */
export class SubmissionInFlightError extends Error {
  readonly code = "E_SUBMISSION_IN_FLIGHT" as const;
  constructor(readonly txid: string) {
    super(`E_SUBMISSION_IN_FLIGHT: ${txid} is being broadcast right now`);
    this.name = "SubmissionInFlightError";
  }
}

/** Forgets the coins of ONE pending transaction (after status checks
 *  showed the node does not have it). Refused while a submission of that
 *  transaction is in flight in ANY tab (stored lease). Returns true only
 *  when its coins are gone and the release reached storage; its intent is
 *  resolved only once the coins are actually gone. */
export function forgetPendingTransaction(spentBy: string | null, now: number = Date.now()): boolean {
  const self = spentBy ? spentBy.toLowerCase() : null;
  if (isSubmissionInFlight(self, now)) throw new SubmissionInFlightError(self ?? "unknown");
  const drop = new Set(load(now).filter((e) => e.spentBy === self).map((e) => e.outpoint));
  let durable = drop.size > 0 ? releaseInternal(drop, self, now) : true;
  const gone = !load(now).some((e) => e.spentBy === self);
  if (self && gone) durable = resolvePendingIntent(self, now) && durable;
  probeLog.delete(self ?? "");
  return durable && gone;
}

// ─── Payment intents ─────────────────────────────────────────────────────

/** Records what a broadcast is paying (before submission). An intent that
 *  is already open for this tx is kept as it is; a resolved one is
 *  reopened. Returns whether it reached storage. */
export function recordPendingIntent(
  intent: { txid: string; destination: string | null; amountGrains: bigint | string | null },
  now: number = Date.now(),
): boolean {
  const txid = intent.txid.toLowerCase();
  if (!TXID_RE.test(txid)) return false;
  const cur = loadIntents();
  const prev = cur.find((i) => i.txid === txid);
  if (prev && prev.resolvedAt === null) return !failedKeys.has(PENDING_INTENTS_STORAGE_KEY);
  const destination = intent.destination ? canonicalDestination(intent.destination) : null;
  const rec: PendingIntent = {
    txid,
    destination: destination || null,
    amountGrains: intent.amountGrains === null ? null : intent.amountGrains.toString(),
    // A reopened intent must post-date its resolution or the merge would
    // keep the resolved copy.
    at: prev ? Math.max(now, intentClock(prev) + 1) : now,
    resolvedAt: null,
  };
  const durable = saveIntents(mergeIntents(cur, [rec]), now);
  postToOtherTabs({ intents: [rec] });
  return durable;
}

/** Marks a broadcast's intent as resolved (the node holds it, or its
 *  coins were released). */
export function resolvePendingIntent(txid: string, now: number = Date.now()): boolean {
  const id = txid.toLowerCase();
  const cur = loadIntents();
  const prev = cur.find((i) => i.txid === id);
  if (!prev || prev.resolvedAt !== null) return true;
  const rec: PendingIntent = { ...prev, resolvedAt: Math.max(now, prev.at) };
  const durable = saveIntents(mergeIntents(cur, [rec]), now);
  postToOtherTabs({ intents: [rec] });
  return durable;
}

export interface UnresolvedPendingTx {
  spentBy: string | null;
  coins: number;
  recordedAt: number;
  intent: PendingIntent | null;
  /** A submission of it is waiting for the node right now (any tab). */
  inFlight: boolean;
  /** Its coins are reserved but no intent was recorded (failed write, an
   *  older version, or no txid): the destination is unknown. */
  metadataMissing: boolean;
}

/**
 * Reserved broadcasts whose outcome is still open: every one with an
 * unresolved intent (in flight, or ended "status unknown"), plus every
 * reservation without an intent record. Their coins are still reserved.
 */
export function unresolvedPendingTransactions(now: number = Date.now()): UnresolvedPendingTx[] {
  const intents = new Map(loadIntents().map((i) => [i.txid, i] as const));
  const attempts = loadAttempts();
  const inFlight = (txid: string | null) =>
    attempts.some((a) => a.txid === txid && a.state === "in-flight" && a.until > now);
  const out: UnresolvedPendingTx[] = [];
  for (const g of pendingTransactions(now)) {
    const intent = g.spentBy === null ? undefined : intents.get(g.spentBy);
    if (!intent) out.push({ ...g, intent: null, inFlight: inFlight(g.spentBy), metadataMissing: true });
    else if (intent.resolvedAt === null) out.push({ ...g, intent, inFlight: inFlight(g.spentBy), metadataMissing: false });
  }
  return out;
}

/** Unresolved payments to `destination` (any letter case). */
export function unresolvedIntentsTo(destination: string, now: number = Date.now()): PendingIntent[] {
  return payTwiceRisk(destination, now).sameDestination;
}

/**
 * What paying `destination` now could duplicate: unresolved payments to
 * the same address, and unresolved reservations whose destination was
 * never recorded (they could be paying it too).
 */
export function payTwiceRisk(
  destination: string,
  now: number = Date.now(),
): { sameDestination: PendingIntent[]; unknownDestination: number } {
  const d = canonicalDestination(destination);
  if (!d) return { sameDestination: [], unknownDestination: 0 };
  const open = unresolvedPendingTransactions(now);
  return {
    sameDestination: open.map((t) => t.intent).filter((i): i is PendingIntent => !!i && i.destination === d),
    unknownDestination: open.filter((t) => t.metadataMissing).length,
  };
}

/** Send must have the user's explicit "may pay twice" acknowledgement. */
export function needsPayTwiceAck(destination: string, now: number = Date.now()): boolean {
  const r = payTwiceRisk(destination, now);
  return r.sameDestination.length > 0 || r.unknownDestination > 0;
}

// ─── Submission attempts (shared by every tab) ───────────────────────────

let attemptSeq = 0;
function newAttemptId(now: number): string {
  let rnd = "";
  try {
    const b = new Uint8Array(8);
    globalThis.crypto.getRandomValues(b);
    rnd = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    rnd = Math.random().toString(36).slice(2);
  }
  return `${now.toString(36)}-${(++attemptSeq).toString(36)}-${rnd}`;
}

function startAttempt(
  txid: string | null,
  added: readonly string[],
  now: number,
  leaseMs: number,
): { attemptId: string; durable: boolean } {
  const rec: PendingAttempt = {
    id: newAttemptId(now),
    txid: txid ? txid.toLowerCase() : null,
    added: [...added],
    startedAt: now,
    until: now + leaseMs,
    state: "in-flight",
  };
  const durable = saveAttempts(mergeAttempts(loadAttempts(), [rec]), now);
  postToOtherTabs({ attempts: [rec] });
  return { attemptId: rec.id, durable };
}

/** Records the start of one submission attempt of `txid`, which reserved
 *  `added`. Returns the attempt id. Callers in a browser hold the lock. */
export function beginSubmission(
  txid: string | null,
  added: readonly string[],
  now: number = Date.now(),
  leaseMs: number = SUBMISSION_LEASE_MS,
): string {
  return startAttempt(txid, added, now, leaseMs).attemptId;
}

/**
 * The one pre-submission step (run inside withPendingSpendsLock): refuses
 * when another tx already spends an input (PendingSpendConflictError,
 * nothing written), else reserves the inputs, records the intent and the
 * in-flight attempt. `durable` is false when any of it only reached
 * memory (pendingPersistenceIssue() reports it to the UI).
 */
export function beginBroadcast(
  spentBy: string | null,
  inputs: readonly { txid: string; vout: number }[],
  intent: { destination: string | null; amountGrains: bigint | null } | null,
  now: number = Date.now(),
  leaseMs: number = SUBMISSION_LEASE_MS,
): { attemptId: string; added: string[]; durable: boolean } {
  const self = spentBy ? spentBy.toLowerCase() : null;
  const r = reserveInternal(self, inputs, now);
  let durable = r.durable;
  if (self) {
    durable =
      recordPendingIntent(
        { txid: self, destination: intent?.destination ?? null, amountGrains: intent?.amountGrains ?? null },
        now,
      ) && durable;
  }
  const a = startAttempt(self, r.added, now, leaseMs);
  return { attemptId: a.attemptId, added: r.added, durable: a.durable && durable };
}

/** Extends an in-flight attempt's lease (its tab is still waiting). */
export function renewSubmissionLease(
  attemptId: string,
  now: number = Date.now(),
  leaseMs: number = SUBMISSION_LEASE_MS,
): boolean {
  const all = loadAttempts();
  const me = all.find((a) => a.id === attemptId);
  if (!me || me.state !== "in-flight") return false;
  const rec: PendingAttempt = { ...me, until: Math.max(me.until, now + leaseMs) };
  saveAttempts(mergeAttempts(all, [rec]), now);
  postToOtherTabs({ attempts: [rec] });
  return true;
}

/**
 * Ends one submission attempt and — in the same step, re-reading every
 * attempt of that tx from storage — decides what happens to the
 * reservation (callers in a browser hold the lock):
 *   accepted  → the intent is resolved; coins stay reserved;
 *   unknown   → everything stays (intent open);
 *   rejected  → released only when EVERY attempt of this tx (any tab) was
 *               rejected — none in flight, none accepted or unknown, no
 *               abandoned lease — and then all their reserved outpoints
 *               are released and the intent resolved.
 * An attempt that no longer exists (wiped meanwhile) changes nothing.
 */
export function finishSubmission(
  attemptId: string,
  outcome: "accepted" | "unknown" | "rejected",
  now: number = Date.now(),
): { released: string[]; durable: boolean } {
  const all = loadAttempts();
  const me = all.find((a) => a.id === attemptId);
  if (!me || me.state !== "in-flight") return { released: [], durable: true };
  const rec: PendingAttempt = { ...me, state: outcome };
  const attempts = mergeAttempts(all, [rec]);
  let durable = saveAttempts(attempts, now);
  postToOtherTabs({ attempts: [rec] });
  let released: string[] = [];
  if (outcome === "accepted" && me.txid) {
    durable = resolvePendingIntent(me.txid, now) && durable;
  } else if (outcome === "rejected") {
    const group = me.txid === null ? [rec] : attempts.filter((a) => a.txid === me.txid);
    if (group.every((a) => a.state === "rejected")) {
      const drop = new Set(group.flatMap((a) => a.added));
      if (drop.size > 0) {
        durable = releaseInternal(drop, me.txid, now) && durable;
        released = [...drop];
      }
      if (me.txid && !load(now).some((e) => e.spentBy === me.txid)) {
        durable = resolvePendingIntent(me.txid, now) && durable;
      }
    }
  }
  return { released, durable };
}

/** A submission of `txid` is waiting for the node (any tab, live lease). */
export function isSubmissionInFlight(txid: string | null, now: number = Date.now()): boolean {
  const id = txid ? txid.toLowerCase() : null;
  return loadAttempts().some((a) => a.txid === id && a.state === "in-flight" && a.until > now);
}

// ─── Manual release readiness ────────────────────────────────────────────

/** Times of consecutive "node doesn't have it" checks, per txid. */
const probeLog = new Map<string, number[]>();

/** Records a status check of `txid`. "found" resolves its intent and
 *  clears earlier negatives; "unknown" changes nothing. */
export function notePendingTxProbe(txid: string, result: "found" | "absent" | "unknown", now: number = Date.now()): void {
  const id = txid.toLowerCase();
  if (result === "found") {
    probeLog.delete(id);
    resolvePendingIntent(id, now);
  } else if (result === "absent") {
    const log = probeLog.get(id) ?? [];
    log.push(now);
    probeLog.set(id, log);
  }
  notify();
}

export type ManualReleaseState =
  | { state: "in-flight" }
  | { state: "check" }
  | { state: "recheck"; waitMs: number }
  | { state: "ready" };

/**
 * Whether the user may release `txid`'s coins by hand: never while a
 * submission of it is in flight in any tab; otherwise after two negative
 * checks at least PENDING_RELEASE_RECHECK_MS apart, or after one negative
 * check plus the user's explicit "the explorer doesn't show it either".
 */
export function manualReleaseState(txid: string, explorerAck: boolean, now: number = Date.now()): ManualReleaseState {
  const id = txid.toLowerCase();
  if (isSubmissionInFlight(id, now)) return { state: "in-flight" };
  const log = probeLog.get(id) ?? [];
  if (log.length === 0) return { state: "check" };
  if (explorerAck) return { state: "ready" };
  const span = log[log.length - 1]! - log[0]!;
  if (log.length >= 2 && span >= PENDING_RELEASE_RECHECK_MS) return { state: "ready" };
  return { state: "recheck", waitMs: Math.max(0, log[0]! + PENDING_RELEASE_RECHECK_MS - now) };
}

/** Forgets this tab's in-memory copies only (another tab wiped the
 *  wallet and already removed the storage keys). */
export function clearPendingSpendsMemory(): void {
  memory = [];
  memoryReleases = [];
  memoryIntents = [];
  memoryAttempts = [];
  failedKeys.clear();
  probeLog.clear();
  notify();
}

/** Test hook: forget in-process state without touching storage (a second
 *  tab / a reload). */
export function _resetPendingMemoryForTests(): void {
  clearPendingSpendsMemory();
}

interface PendingMemorySnapshot {
  memory: PendingSpend[];
  releases: PendingRelease[];
  intents: PendingIntent[];
  attempts?: PendingAttempt[];
}

/** Test hook: snapshot / restore in-process state (simulate two tabs). */
export function _pendingMemorySnapshotForTests(): Required<PendingMemorySnapshot> {
  return { memory: [...memory], releases: [...memoryReleases], intents: [...memoryIntents], attempts: [...memoryAttempts] };
}
export function _restorePendingMemoryForTests(s: PendingMemorySnapshot): void {
  memory = [...s.memory];
  memoryReleases = [...s.releases];
  memoryIntents = [...s.intents];
  memoryAttempts = [...(s.attempts ?? [])];
}
