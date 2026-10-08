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
// (the coins are spendable again). Send (after a status-unknown broadcast)
// and Consolidate can release ONE transaction's coins by hand, after a
// status check showed the node does not have it.
//
// Storage: an in-process list that every read merges with localStorage
// (survives reloads, so a re-run after a refresh is still protected).
// Persisting is best-effort; a failed write never loses the record for
// this session. Contents are public chain data (outpoints + txids), no
// key material.
//
// Reservation: every broadcast path (Send, consolidation, offline
// broadcast) goes through reservePendingSpends right before submitting:
// it refuses when another transaction already spends one of the inputs
// and records the inputs in the same synchronous step. A definite node
// rejection releases the reservation; success and "status unknown" keep
// it.

export const PENDING_SPEND_TTL_MS = 6 * 60 * 60 * 1000;
export const PENDING_SPENDS_STORAGE_KEY = "pearl-wallet-pending-spends-v1";
/** Bound on stored entries so a corrupted or hostile value can't grow
 *  without limit. Several full consolidation batches fit comfortably. */
const MAX_ENTRIES = 20_000;

export interface PendingSpend {
  /** "txid:vout" of the spent coin (txid lower-case). */
  outpoint: string;
  /** Txid of the spending transaction, when known. */
  spentBy: string | null;
  recordedAt: number;
}

// Canonical in-process copy. Every read merges it with whatever storage
// holds, so a record whose storage write failed (quota, partitioned or
// read-only storage) still protects its coins for the rest of the session.
let memory: PendingSpend[] = [];

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

function isEntry(e: unknown): e is PendingSpend {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.outpoint === "string" &&
    /^[0-9a-f]{64}:\d+$/.test(x.outpoint) &&
    (x.spentBy === null || typeof x.spentBy === "string") &&
    typeof x.recordedAt === "number" &&
    Number.isFinite(x.recordedAt)
  );
}

function readStorage(): PendingSpend[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(PENDING_SPENDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
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

function load(): PendingSpend[] {
  return merge(readStorage(), memory).slice(-MAX_ENTRIES);
}

function save(entries: PendingSpend[]): void {
  const bounded = entries.slice(-MAX_ENTRIES);
  // Memory first: it is the copy every later read is guaranteed to see.
  memory = bounded;
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PENDING_SPENDS_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Quota / partitioned storage: memory keeps the protection for this
    // session.
  }
}

function live(entries: PendingSpend[], now: number): PendingSpend[] {
  // A recordedAt in the future (clock moved back) is treated as fresh, not
  // dropped — failing safe means keeping the exclusion.
  return entries.filter((e) => now - e.recordedAt < PENDING_SPEND_TTL_MS);
}

/** Records that `spentBy` (null when the txid is unknown) spends `inputs`. */
export function recordPendingSpends(
  spentBy: string | null,
  inputs: readonly { txid: string; vout: number }[],
  now: number = Date.now(),
): void {
  const entries = live(load(), now);
  const have = new Set(entries.map((e) => e.outpoint));
  for (const u of inputs) {
    const k = outpointKey(u);
    if (have.has(k)) continue;
    have.add(k);
    entries.push({ outpoint: k, spentBy: spentBy ? spentBy.toLowerCase() : null, recordedAt: now });
  }
  save(entries);
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
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(PENDING_SPENDS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
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
 * releasePendingSpends after a definite rejection.
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
  const added: string[] = [];
  for (const u of inputs) {
    const k = outpointKey(u);
    if (byKey.has(k)) continue;
    const entry: PendingSpend = { outpoint: k, spentBy: self, recordedAt: now };
    byKey.set(k, entry);
    entries.push(entry);
    added.push(k);
  }
  save(entries);
  return added;
}

/** Undoes a reservation after the node definitely rejected the tx. Only
 *  the outpoints that reservation added, and only while they still name
 *  the same spending tx, are removed. */
export function releasePendingSpends(outpoints: readonly string[], spentBy: string | null): void {
  if (outpoints.length === 0) return;
  const self = spentBy ? spentBy.toLowerCase() : null;
  const drop = new Set(outpoints);
  // Removal must reach memory and storage alike (load() merges both).
  const kept = load().filter((e) => !(drop.has(e.outpoint) && e.spentBy === self));
  save(kept);
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

/** Forgets the coins of ONE pending transaction (after a status check
 *  showed the node does not have it). */
export function forgetPendingTransaction(spentBy: string | null): void {
  const self = spentBy ? spentBy.toLowerCase() : null;
  save(load().filter((e) => e.spentBy !== self));
}
