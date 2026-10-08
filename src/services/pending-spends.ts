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
// Status-unknown broadcasts also keep a payment intent {txid, destination,
// amountGrains, at} so the Send screen and the dashboard can surface the
// unresolved transaction after the user navigated away, and Send can ask
// for an explicit "may pay twice" acknowledgement before paying the same
// destination again.

export const PENDING_SPEND_TTL_MS = 6 * 60 * 60 * 1000;
export const PENDING_SPENDS_STORAGE_KEY = "pearl-wallet-pending-spends-v1";
export const PENDING_RELEASES_STORAGE_KEY = "pearl-wallet-pending-releases-v1";
export const PENDING_INTENTS_STORAGE_KEY = "pearl-wallet-pending-intents-v1";
/** Two "node doesn't have it" checks this far apart unlock a manual
 *  release without an explorer acknowledgement. */
export const PENDING_RELEASE_RECHECK_MS = 30_000;
/** Bound on stored entries so a corrupted or hostile value can't grow
 *  without limit. Several full consolidation batches fit comfortably. */
const MAX_ENTRIES = 20_000;
const MAX_INTENTS = 500;
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

/** What a status-unknown broadcast was meant to do. */
export interface PendingIntent {
  txid: string;
  /** Address paid (outputs[0]); null when not known (offline / vault). */
  destination: string | null;
  amountGrains: string | null;
  at: number;
  /** Set once the status was resolved (node holds it, or released). */
  resolvedAt: number | null;
}

// Canonical in-process copies. Every read merges them with whatever storage
// holds, so a record whose storage write failed (quota, partitioned or
// read-only storage) still counts for the rest of the session.
let memory: PendingSpend[] = [];
let memoryReleases: PendingRelease[] = [];
let memoryIntents: PendingIntent[] = [];

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
        const data = ev.data as { releases?: unknown; intents?: unknown } | null;
        if (data && Array.isArray(data.releases)) {
          memoryReleases = mergeReleases(memoryReleases, data.releases.filter(isRelease));
        }
        if (data && Array.isArray(data.intents)) {
          memoryIntents = mergeIntents(memoryIntents, data.intents.filter(isIntent));
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
          ev.key === PENDING_INTENTS_STORAGE_KEY
        ) {
          notify();
        }
      });
    }
  } catch {
    /* no window (worker / tests) */
  }
}

function postToOtherTabs(msg: { releases?: PendingRelease[]; intents?: PendingIntent[] }): void {
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

/** Writes `value` under `key`. True when it reached storage (or there is
 *  no storage at all, so nothing stale can come back from it). */
function writeList(key: string, value: unknown[]): boolean {
  const s = storage();
  if (!s) return true;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
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

function loadReleases(): PendingRelease[] {
  return mergeReleases(readList(PENDING_RELEASES_STORAGE_KEY, isRelease, MAX_ENTRIES), memoryReleases);
}

function load(): PendingSpend[] {
  return applyReleases(merge(readList(PENDING_SPENDS_STORAGE_KEY, isEntry, MAX_ENTRIES), memory), loadReleases()).slice(
    -MAX_ENTRIES,
  );
}

function loadIntents(): PendingIntent[] {
  return mergeIntents(readList(PENDING_INTENTS_STORAGE_KEY, isIntent, MAX_INTENTS), memoryIntents);
}

/** Persists the list (and, when given, the tombstones). Memory first: it
 *  is the copy every later read in this tab is guaranteed to see. Returns
 *  whether everything reached storage. */
function save(entries: PendingSpend[], releases?: PendingRelease[], now: number = Date.now()): boolean {
  const bounded = entries.slice(-MAX_ENTRIES);
  memory = bounded;
  let durable = writeList(PENDING_SPENDS_STORAGE_KEY, bounded);
  if (releases) {
    // Tombstones outlive every record they can cover (records expire
    // PENDING_SPEND_TTL_MS after recordedAt <= releasedAt).
    const kept = releases.filter((r) => now - r.releasedAt < PENDING_SPEND_TTL_MS).slice(-MAX_ENTRIES);
    memoryReleases = kept;
    durable = writeList(PENDING_RELEASES_STORAGE_KEY, kept) && durable;
  }
  notify();
  return durable;
}

function saveIntents(intents: PendingIntent[], now: number): boolean {
  const kept = intents.filter((i) => now - intentClock(i) < PENDING_SPEND_TTL_MS).slice(-MAX_INTENTS);
  memoryIntents = kept;
  const durable = writeList(PENDING_INTENTS_STORAGE_KEY, kept);
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
  const entries = live(load(), now);
  const have = new Set(entries.map((e) => e.outpoint));
  const self = spentBy ? spentBy.toLowerCase() : null;
  const released = releaseTimes(loadReleases());
  for (const u of inputs) {
    const k = outpointKey(u);
    if (have.has(k)) continue;
    have.add(k);
    entries.push({ outpoint: k, spentBy: self, recordedAt: freshRecordTime(released, k, self, now) });
  }
  save(entries);
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
  return new Set(live(load(), now).map((e) => e.outpoint));
}

export function pendingSpendList(now: number = Date.now()): PendingSpend[] {
  return live(load(), now);
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

export function clearPendingSpends(): void {
  memory = [];
  memoryReleases = [];
  memoryIntents = [];
  submissions.clear();
  probeLog.clear();
  const s = storage();
  if (s) {
    for (const k of [PENDING_SPENDS_STORAGE_KEY, PENDING_RELEASES_STORAGE_KEY, PENDING_INTENTS_STORAGE_KEY]) {
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
  const byKey = new Map(live(load(), now).map((e) => [e.outpoint, e] as const));
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
  const self = spentBy ? spentBy.toLowerCase() : null;
  const entries = live(load(), now);
  const byKey = new Map(entries.map((e) => [e.outpoint, e] as const));
  for (const u of inputs) {
    const e = byKey.get(outpointKey(u));
    if (e && (self === null || e.spentBy !== self)) throw new PendingSpendConflictError(e.outpoint, e.spentBy);
  }
  const released = releaseTimes(loadReleases());
  const added: string[] = [];
  for (const u of inputs) {
    const k = outpointKey(u);
    if (byKey.has(k)) continue;
    const entry: PendingSpend = { outpoint: k, spentBy: self, recordedAt: freshRecordTime(released, k, self, now) };
    byKey.set(k, entry);
    entries.push(entry);
    added.push(k);
  }
  save(entries);
  return added;
}

function releaseInternal(drop: ReadonlySet<string>, self: string | null, now: number): boolean {
  const releases = loadReleases();
  const fresh: PendingRelease[] = [...drop].map((outpoint) => ({ outpoint, spentBy: self, releasedAt: now }));
  const allReleases = mergeReleases(releases, fresh);
  const kept = applyReleases(load(), fresh);
  const durable = save(kept, allReleases, now);
  postToOtherTabs({ releases: fresh });
  return durable;
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
  for (const e of live(load(), now)) {
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
 *  transaction is in flight in this tab. Returns whether the release
 *  reached storage. */
export function forgetPendingTransaction(spentBy: string | null, now: number = Date.now()): boolean {
  const self = spentBy ? spentBy.toLowerCase() : null;
  if (self && isSubmissionInFlight(self)) throw new SubmissionInFlightError(self);
  const drop = new Set(load().filter((e) => e.spentBy === self).map((e) => e.outpoint));
  let durable = drop.size > 0 ? releaseInternal(drop, self, now) : true;
  if (self) durable = resolvePendingIntent(self, now) && durable;
  probeLog.delete(self ?? "");
  return durable;
}

// ─── Payment intents of status-unknown broadcasts ────────────────────────

/** Records what a status-unknown broadcast was paying. */
export function recordPendingIntent(
  intent: { txid: string; destination: string | null; amountGrains: bigint | string | null },
  now: number = Date.now(),
): boolean {
  const txid = intent.txid.toLowerCase();
  if (!TXID_RE.test(txid)) return false;
  const rec: PendingIntent = {
    txid,
    destination: intent.destination ? intent.destination.trim() : null,
    amountGrains: intent.amountGrains === null ? null : intent.amountGrains.toString(),
    at: now,
    resolvedAt: null,
  };
  const all = mergeIntents(loadIntents(), [rec]);
  const durable = saveIntents(all, now);
  postToOtherTabs({ intents: [rec] });
  return durable;
}

/** Marks a status-unknown broadcast as resolved (the node holds it, or
 *  its coins were released). */
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
}

/**
 * Pending broadcasts whose outcome is still open: every status-unknown
 * broadcast not yet resolved, plus coins recorded without a txid. Their
 * coins are still reserved.
 */
export function unresolvedPendingTransactions(now: number = Date.now()): UnresolvedPendingTx[] {
  const open = new Map<string, PendingIntent>();
  for (const i of loadIntents()) {
    if (i.resolvedAt === null && now - i.at < PENDING_SPEND_TTL_MS) open.set(i.txid, i);
  }
  const out: UnresolvedPendingTx[] = [];
  for (const g of pendingTransactions(now)) {
    if (g.spentBy === null) out.push({ ...g, intent: null });
    else if (open.has(g.spentBy)) out.push({ ...g, intent: open.get(g.spentBy)! });
  }
  return out;
}

/** Unresolved status-unknown payments to `destination`. */
export function unresolvedIntentsTo(destination: string, now: number = Date.now()): PendingIntent[] {
  const d = destination.trim();
  if (!d) return [];
  return unresolvedPendingTransactions(now)
    .map((t) => t.intent)
    .filter((i): i is PendingIntent => !!i && i.destination === d);
}

// ─── In-flight submissions (this tab) ────────────────────────────────────

interface Submission {
  count: number;
  /** Outpoints reserved by any attempt of this tx in this tab. */
  added: Set<string>;
  /** An attempt succeeded or ended "status unknown". */
  settled: boolean;
}
const submissions = new Map<string, Submission>();

/** Marks the start of one submission attempt of `key` (the txid). */
export function beginSubmission(key: string, added: readonly string[]): void {
  const k = key.toLowerCase();
  const s = submissions.get(k) ?? { count: 0, added: new Set<string>(), settled: false };
  s.count++;
  for (const o of added) s.added.add(o);
  submissions.set(k, s);
  notify();
}

/**
 * Ends one submission attempt. Returns the outpoints to release: non-empty
 * only for a rejected attempt that was the last one in flight while no
 * attempt of the same tx succeeded or ended "status unknown".
 */
export function finishSubmission(key: string, outcome: "accepted" | "unknown" | "rejected"): string[] {
  const k = key.toLowerCase();
  const s = submissions.get(k);
  if (!s) return [];
  s.count--;
  if (outcome !== "rejected") s.settled = true;
  let release: string[] = [];
  if (s.count <= 0) {
    if (!s.settled) release = [...s.added];
    submissions.delete(k);
  }
  notify();
  return release;
}

/** A submission of `txid` is waiting for the node in this tab. */
export function isSubmissionInFlight(txid: string | null): boolean {
  if (!txid) return false;
  return (submissions.get(txid.toLowerCase())?.count ?? 0) > 0;
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
 * submission of it is in flight; otherwise after two negative checks at
 * least PENDING_RELEASE_RECHECK_MS apart, or after one negative check plus
 * the user's explicit "the explorer doesn't show it either".
 */
export function manualReleaseState(txid: string, explorerAck: boolean, now: number = Date.now()): ManualReleaseState {
  const id = txid.toLowerCase();
  if (isSubmissionInFlight(id)) return { state: "in-flight" };
  const log = probeLog.get(id) ?? [];
  if (log.length === 0) return { state: "check" };
  if (explorerAck) return { state: "ready" };
  const span = log[log.length - 1]! - log[0]!;
  if (log.length >= 2 && span >= PENDING_RELEASE_RECHECK_MS) return { state: "ready" };
  return { state: "recheck", waitMs: Math.max(0, log[0]! + PENDING_RELEASE_RECHECK_MS - now) };
}

/** Test hook: forget in-process state without touching storage (a second
 *  tab / a reload). */
export function _resetPendingMemoryForTests(): void {
  memory = [];
  memoryReleases = [];
  memoryIntents = [];
  submissions.clear();
  probeLog.clear();
}

/** Test hook: snapshot / restore in-process state (simulate two tabs). */
export function _pendingMemorySnapshotForTests(): {
  memory: PendingSpend[];
  releases: PendingRelease[];
  intents: PendingIntent[];
} {
  return { memory: [...memory], releases: [...memoryReleases], intents: [...memoryIntents] };
}
export function _restorePendingMemoryForTests(s: {
  memory: PendingSpend[];
  releases: PendingRelease[];
  intents: PendingIntent[];
}): void {
  memory = [...s.memory];
  memoryReleases = [...s.releases];
  memoryIntents = [...s.intents];
}
