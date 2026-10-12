// Broadcast records: Pearl transactions this wallet submitted whose coins
// must not be spent again and whose fate may still be unknown.
//
//  1. Every broadcast (Send, consolidation, offline, vault) is recorded as
//     "unknown" BEFORE submission; if that write fails nothing is sent.
//  2. Recorded coins are excluded from coin selection; reusing one refuses.
//  3. While any record is "unknown" every new broadcast is refused unless
//     the user acknowledged exactly those records (Send's "may pay twice"
//     box); consolidation, vault and offline broadcasts wait.
//  4. Nothing is released on a timer. "unknown" ends when the node holds the
//     tx (→ "accepted"), when another tx is seen spending an input, or by
//     the user's explicit release after a check found the tx absent AND
//     every input unspent (re-confirmed under the lock). "accepted" ends
//     when a complete scan no longer lists its inputs and shows one spent,
//     or after 24 h; after 30 min it is listed
//     with the same Check status / Release (the node may have dropped it).
//  5. Every write holds one exclusive Web Locks lock, kept across sign →
//     record → submit → outcome: a suspended sender still holds it, so no
//     tab can release its coins or broadcast meanwhile. Without Web Locks a
//     tab broadcasts only while no other wallet tab is listed as open.
// One localStorage key holds a versioned list (public chain data only); a
// value this version can't validate refuses every broadcast until reset.
// The lock and its single-tab fallback: broadcast-lock.ts. Checks against
// the node: broadcast-status.ts.
//
// Mempool visibility, verified read-only against rpc.pearlbridge.xyz on
// 2026-10-08 (height 124821): mempool tx 55f4738e…2aea (from getrawmempool;
// no confirmations, no blockhash) was the last entry of searchrawtransactions
// for an address it spends from, its vin naming outpoint 6a8ade37…2377:1 —
// a complete address walk drops coins spent in the mempool. gettxout(…, 1,
// includemempool=true) still showed that outpoint unspent, so gettxout is
// never used to prove a coin unspent.

import { BroadcastRefusedError, claimOnlyTab, WALLET_TABS_STORAGE_KEY, withBroadcastLock } from "./broadcast-lock";

export const BROADCASTS_STORAGE_KEY = "pearl-wallet-broadcasts-v1";
export const ACCEPTED_KEEP_MS = 24 * 60 * 60 * 1000;
/** An "accepted" record still unsettled after this long is listed in the
 *  banner with Check status / Release: the node may have dropped it. */
export const ACCEPTED_STALL_MS = 30 * 60 * 1000;
const FORMAT_VERSION = 1;
const MAX_RECORDS = 500;

export type BroadcastKind = "payment" | "consolidation" | "vault" | "offline";

export interface BroadcastRecord {
  txid: string;
  /** Spent outpoints, "txid:vout" lower-case. */
  inputs: string[];
  /** Addresses holding every input; empty when not known. */
  addresses: string[];
  /** Address paid (outputs[0]); null when not known. */
  destination: string | null;
  amountGrains: string | null;
  kind: BroadcastKind;
  createdAt: number;
  state: "unknown" | "accepted";
  /** Opaque per-record id (32 hex), set when the record is created; absent
   *  on records saved by earlier builds. Wipe / replace cleanup identifies
   *  records by it (with their whole content), never by createdAt. */
  id?: string;
}

export interface BroadcastPlan {
  kind: BroadcastKind;
  inputs: readonly { txid: string; vout: number }[];
  addresses?: readonly string[];
  destination: string | null;
  amountGrains: bigint | null;
  /** "unknown" txids the user explicitly accepted may pay twice (Send). */
  acknowledged?: readonly string[];
}

export { BroadcastRefusedError, LOCK_WAIT_MS, otherWalletTabOpen, withBroadcastLock, WALLET_TABS_STORAGE_KEY } from "./broadcast-lock";
export type { RefusalReason } from "./broadcast-lock";

/** A coin is already spent by another recorded broadcast. */
export class PendingSpendConflictError extends BroadcastRefusedError {
  constructor(readonly outpoint: string, readonly spentBy: string) {
    super("conflict", `E_INPUT_PENDING: ${outpoint} is already being spent by ${spentBy}`, [spentBy]);
    this.name = "PendingSpendConflictError";
  }
}

const storageError = (what: string) => new BroadcastRefusedError("storage", `E_BROADCAST_RECORD: ${what}`);

// ─── Change notification ─────────────────────────────────────────────────

const listeners = new Set<() => void>();
let version = 0;
let wired = false;

function notify(): void {
  version++;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a listener's failure must not break a write */
    }
  }
}

/** Subscribe to changes of the records (this tab or another one). */
export function subscribePendingSpends(l: () => void): () => void {
  listeners.add(l);
  if (!wired && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    wired = true;
    window.addEventListener("storage", (ev: StorageEvent) => {
      if (ev.key === null || ev.key === BROADCASTS_STORAGE_KEY || ev.key === WALLET_TABS_STORAGE_KEY) notify();
    });
  }
  return () => void listeners.delete(l);
}

export const pendingSpendsVersion = (): number => version;

// ─── Storage ─────────────────────────────────────────────────────────────

export const outpointKey = (u: { txid: string; vout: number }): string => `${u.txid.toLowerCase()}:${u.vout}`;

const isStr = (x: unknown): x is string => typeof x === "string";
const KINDS: readonly unknown[] = ["payment", "consolidation", "vault", "offline"];

function isRecord(e: unknown): e is BroadcastRecord {
  const x = (e ?? {}) as Record<string, unknown>;
  return (
    isStr(x.txid) && /^[0-9a-f]{64}$/.test(x.txid) &&
    Array.isArray(x.inputs) && x.inputs.length > 0 && x.inputs.every((o) => isStr(o) && /^[0-9a-f]{64}:\d+$/.test(o)) &&
    Array.isArray(x.addresses) && x.addresses.every(isStr) &&
    (x.destination === null || isStr(x.destination)) &&
    (x.amountGrains === null || (isStr(x.amountGrains) && /^\d+$/.test(x.amountGrains))) &&
    KINDS.includes(x.kind) &&
    typeof x.createdAt === "number" && Number.isFinite(x.createdAt) &&
    (x.state === "unknown" || x.state === "accepted") &&
    (x.id === undefined || (isStr(x.id) && /^[0-9a-f]{32}$/.test(x.id)))
  );
}

/** Live records. Throws a "storage" refusal when storage is missing or
 *  blocked (every access sits in a try), unreadable, or holds anything this
 *  version can't validate — never "no records". */
function readRecords(now: number = Date.now()): BroadcastRecord[] {
  let p: { v?: unknown; records?: unknown } | null;
  try {
    const raw = localStorage.getItem(BROADCASTS_STORAGE_KEY);
    p = raw === null ? { v: FORMAT_VERSION, records: [] } : (JSON.parse(raw) as typeof p);
  } catch {
    throw storageError("the broadcast record can't be read");
  }
  if (!p || p.v !== FORMAT_VERSION || !Array.isArray(p.records) || !p.records.every(isRecord)) {
    throw storageError("the broadcast record can't be read");
  }
  // "accepted" stops mattering after a day; "unknown" never expires. A
  // createdAt in the future (clock moved back) is kept.
  return p.records.filter((r) => r.state === "unknown" || now - r.createdAt < ACCEPTED_KEEP_MS);
}

function tryRead(now: number = Date.now()): BroadcastRecord[] | null {
  try {
    return readRecords(now);
  } catch {
    return null;
  }
}

function writeRecords(records: readonly BroadcastRecord[]): void {
  try {
    localStorage.setItem(BROADCASTS_STORAGE_KEY, JSON.stringify({ v: FORMAT_VERSION, records }));
    updateFailed = false;
  } catch {
    throw storageError("the browser couldn't save the broadcast record");
  } finally {
    notify();
  }
}

/** A post-submission outcome couldn't be saved (the record stays
 *  "unknown": more caution, never less). */
let updateFailed = false;

/** An outcome or a status check's certain result couldn't be saved: the
 *  record stays as it was, and the banner says so. */
export function noteBroadcastUpdateFailed(): void {
  updateFailed = true;
  notify();
}

/** What the banner must say about the store itself. */
export function broadcastRecordIssue(): "unreadable" | "update-failed" | null {
  return tryRead() === null ? "unreadable" : updateFailed ? "update-failed" : null;
}

/** Explicit user action: replace an unreadable store with an empty one. */
export async function resetUnreadableBroadcastRecord(): Promise<void> {
  await withBroadcastLock(async () => (tryRead() === null ? writeRecords([]) : undefined));
}

/** Unconditional reset of the whole store: TESTS ONLY. App code (wipe,
 *  wallet replacement) uses snapshotBroadcastRecords +
 *  forgetSnapshotBroadcastRecords, which never remove a record saved or
 *  rewritten after the wipe / replace started (another tab's new wallet's
 *  send) nor one an active send may still own. */
export function clearPendingSpends(): void {
  try {
    localStorage.removeItem(BROADCASTS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  updateFailed = false;
  notify();
}

/** The exact records stored when a wipe / replace started (see
 *  snapshotBroadcastRecords). Opaque to callers. */
export interface BroadcastSnapshot {
  /** Each record's identity + content: its id (or, on a record saved by an
   *  earlier build, txid and createdAt) and every field, serialized. */
  readonly records: ReadonlySet<string>;
  /** The raw stored value when it was unreadable then, else null. */
  readonly unreadableRaw: string | null;
}

/** A record's identity and content. Two records match only when every
 *  field is the same, the per-record id (when present) included: a record
 *  created later, or an earlier one rewritten (e.g. "unknown" → "accepted"),
 *  never matches a snapshot entry, whatever its timestamps say. */
const recordFingerprint = (r: BroadcastRecord): string => JSON.stringify(r);

/**
 * Wipe / replacement, BEFORE its keystore transaction: the exact records
 * stored now. forgetSnapshotBroadcastRecords later removes only these.
 * A store that can't be read at all gives an empty snapshot (nothing will
 * be removed: fail closed). Never throws.
 */
export function snapshotBroadcastRecords(): BroadcastSnapshot {
  let raw: string | null;
  try {
    raw = localStorage.getItem(BROADCASTS_STORAGE_KEY);
  } catch {
    return { records: new Set(), unreadableRaw: null };
  }
  const records = tryRead();
  if (records === null) return { records: new Set(), unreadableRaw: raw };
  return { records: new Set(records.map(recordFingerprint)), unreadableRaw: null };
}

/** What forgetSnapshotBroadcastRecords did: "cleared" every snapshot
 *  record still unchanged (and an unreadable store unchanged since the
 *  snapshot); "kept-unknown" the same but kept every "unknown" record (a
 *  broadcast was running when the clear began); "kept" nothing removed
 *  (the lock wasn't granted, or the write failed). */
export type ForgetBroadcastsResult = "cleared" | "kept-unknown" | "kept";

/**
 * Wallet wipe / replacement, after its keystore transaction committed:
 * forgets the broadcast records `snapshot` (snapshotBroadcastRecords, taken
 * before that transaction) saw, each only while it is still exactly as seen
 * (same id and content), and keeps every other one. Between that commit and
 * this clear another tab can restore (or unlock) a wallet and broadcast from
 * it; that record (often "unknown") is the new wallet's only block against
 * paying twice with different coins, so it is never removed — whatever its
 * createdAt (a clock moved back, or the same millisecond, does not matter:
 * ownership is the snapshot, not the wall clock).
 *
 * Read, compare and write run under the broadcast lock (every broadcast
 * holds it from signing until its outcome is saved), so no record is
 * rewritten away under a running send:
 *  - lock free at once: no broadcast is running anywhere; the snapshot's
 *    unchanged records go (a store unreadable at the snapshot and still
 *    holding the very same value goes too: no valid record can be saved
 *    into one);
 *  - lock held (a broadcast is running, possibly one that recorded before
 *    the snapshot and will end status-unknown): wait for it (bounded), then
 *    forget only the snapshot's unchanged "accepted" records and keep every
 *    "unknown" one — the banner lists them (Check status / Release);
 *  - not granted (busy, a second tab without Web Locks) or a write that
 *    fails: nothing is removed (fail closed).
 * Never throws.
 */
export async function forgetSnapshotBroadcastRecords(snapshot: BroadcastSnapshot): Promise<ForgetBroadcastsResult> {
  const prune = (keepUnknown: boolean) => async (): Promise<ForgetBroadcastsResult> => {
    const records = tryRead();
    if (records === null) {
      // Unreadable now: removed only if it is the very value the snapshot
      // found unreadable (anything else may be newer: kept, fail closed).
      let raw: string | null;
      try {
        raw = localStorage.getItem(BROADCASTS_STORAGE_KEY);
      } catch {
        throw storageError("the broadcast record can't be read");
      }
      if (snapshot.unreadableRaw === null || raw !== snapshot.unreadableRaw) throw storageError("the broadcast record changed");
      try {
        localStorage.removeItem(BROADCASTS_STORAGE_KEY);
      } catch {
        throw storageError("the broadcast record can't be removed");
      }
      updateFailed = false;
      notify();
      return keepUnknown ? "kept-unknown" : "cleared";
    }
    const keep = records.filter((r) => !snapshot.records.has(recordFingerprint(r)) || (keepUnknown && r.state === "unknown"));
    if (keep.length === records.length) {
      // Nothing to forget (the read also dropped expired "accepted" ones;
      // leaving them stored is harmless).
      notify();
      return keepUnknown ? "kept-unknown" : "cleared";
    }
    if (keep.length > 0) writeRecords(keep);
    else {
      try {
        localStorage.removeItem(BROADCASTS_STORAGE_KEY);
      } catch {
        throw storageError("the broadcast record can't be removed");
      }
      updateFailed = false;
      notify();
    }
    return keepUnknown ? "kept-unknown" : "cleared";
  };
  try {
    return await withBroadcastLock(prune(false), { ifAvailable: true });
  } catch (e) {
    if (!(e instanceof BroadcastRefusedError) || e.reason !== "busy") return "kept";
  }
  try {
    return await withBroadcastLock(prune(true));
  } catch {
    return "kept";
  }
}

/** The user states that no other wallet tab is open (no-Web-Locks
 *  browsers; see broadcast-lock.ts). */
export function claimOnlyWalletTab(): void {
  claimOnlyTab();
  notify();
}

// ─── Reads ───────────────────────────────────────────────────────────────

/** Outpoints spent by recorded broadcasts. */
export function pendingOutpoints(now: number = Date.now()): Set<string> {
  return new Set(broadcastRecords(now).flatMap((r) => r.inputs));
}

/** Splits `utxos` into spendable and already-being-spent coins. */
export function excludePendingSpends<T extends { txid: string; vout: number }>(
  utxos: readonly T[],
  now: number = Date.now(),
): { spendable: T[]; pending: T[] } {
  const p = pendingOutpoints(now);
  return { spendable: utxos.filter((u) => !p.has(outpointKey(u))), pending: utxos.filter((u) => p.has(outpointKey(u))) };
}

/** Every live record; [] when unreadable (display and coin selection only —
 *  the broadcast gate itself fails closed; see broadcastRecordIssue). */
export const broadcastRecords = (now: number = Date.now()): BroadcastRecord[] => tryRead(now) ?? [];

/** Broadcasts whose fate is unknown, newest first. */
export function unresolvedBroadcasts(now: number = Date.now()): BroadcastRecord[] {
  return broadcastRecords(now).filter((r) => r.state === "unknown").sort((a, b) => b.createdAt - a.createdAt);
}

/** True for an "accepted" record no scan has settled after
 *  ACCEPTED_STALL_MS (the node may have evicted it). */
export const isStalledAccepted = (r: BroadcastRecord, now: number = Date.now()): boolean =>
  r.state === "accepted" && now - r.createdAt >= ACCEPTED_STALL_MS;

/** Accepted broadcasts still holding their coins after ACCEPTED_STALL_MS,
 *  newest first. They hold no other broadcast; they are listed so the user
 *  can check them and, if the network dropped them, release their coins. */
export function stalledBroadcasts(now: number = Date.now()): BroadcastRecord[] {
  return broadcastRecords(now).filter((r) => isStalledAccepted(r, now)).sort((a, b) => b.createdAt - a.createdAt);
}

// ─── Broadcast lifecycle (callers hold the lock) ─────────────────────────

/** The gate: refuses on an unacknowledged "unknown" broadcast or a coin
 *  another record spends. `txid` = this tx when known (re-broadcasting the
 *  same bytes is never a second payment). */
export function assertBroadcastAllowed(plan: BroadcastPlan, txid: string | null, now = Date.now()): BroadcastRecord[] {
  const self = txid?.toLowerCase() ?? null;
  const records = readRecords(now);
  const ack = new Set((plan.acknowledged ?? []).map((t) => t.toLowerCase()));
  const open = records.filter((r) => r.state === "unknown" && r.txid !== self && !ack.has(r.txid)).map((r) => r.txid);
  if (open.length > 0) {
    throw new BroadcastRefusedError("unresolved", `E_BROADCAST_UNRESOLVED: ${open.length} earlier broadcast(s) have an unknown status`, open);
  }
  const taken = new Map(records.filter((r) => r.txid !== self).flatMap((r) => r.inputs.map((o) => [o, r.txid] as const)));
  for (const u of plan.inputs) {
    const by = taken.get(outpointKey(u));
    if (by) throw new PendingSpendConflictError(outpointKey(u), by);
  }
  return records;
}

/** 128 random bits, hex: a record's identity (BroadcastRecord.id). */
function newRecordId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Records `txid` as "unknown" BEFORE submission; true when this call made
 *  the record (false: the same bytes were recorded before). Throws a
 *  refusal when it can't be stored — then nothing may be sent. */
export function recordBroadcast(txid: string, plan: BroadcastPlan, now: number = Date.now()): boolean {
  const id = txid.toLowerCase();
  const records = assertBroadcastAllowed(plan, id, now);
  if (records.some((r) => r.txid === id)) return false;
  if (records.length >= MAX_RECORDS) throw storageError("too many recorded broadcasts");
  writeRecords([
    ...records,
    {
      txid: id,
      inputs: [...new Set(plan.inputs.map(outpointKey))],
      addresses: [...new Set(plan.addresses ?? [])],
      destination: plan.destination ? plan.destination.trim().toLowerCase() : null,
      amountGrains: plan.amountGrains == null ? null : plan.amountGrains.toString(),
      kind: plan.kind,
      createdAt: now,
      state: "unknown",
      id: newRecordId(),
    },
  ]);
  return true;
}

/** Saves the outcome: "unknown" keeps the record; "rejected" removes it
 *  only if this attempt created it (an earlier attempt of the same bytes
 *  may have reached the node). Never throws: an unsaved outcome leaves the
 *  record "unknown" and shows in broadcastRecordIssue(). */
export function settleBroadcast(txid: string, outcome: "accepted" | "unknown" | "rejected", created: boolean): void {
  if (outcome === "unknown" || (outcome === "rejected" && !created)) return;
  try {
    resolveBroadcasts([txid], outcome === "accepted" ? "accepted" : "forget");
  } catch {
    noteBroadcastUpdateFailed();
  }
}

/** Marks records accepted (the node holds them) or forgets them (their
 *  fate is known otherwise, or the user released them). Caller holds the
 *  lock; throws a "storage" refusal when the write fails. */
export function resolveBroadcasts(txids: Iterable<string>, to: "accepted" | "forget"): void {
  const ids = new Set([...txids].map((t) => t.toLowerCase()));
  const records = readRecords();
  if (!records.some((r) => ids.has(r.txid))) return;
  writeRecords(records.flatMap((r) => (!ids.has(r.txid) ? [r] : to === "accepted" ? [{ ...r, state: "accepted" as const }] : [])));
}
