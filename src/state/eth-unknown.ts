// Ethereum broadcasts whose outcome could not be determined
// (EthBroadcastStatusUnknownError) and that the user has not yet
// acknowledged. While one is recorded for a network + sending address,
// Send ETH, Send WPRL and Unwrap refuse another send from that address,
// and so does the signing service itself (services/eth-tx.ts refuses with
// E_ETH_UNRESOLVED_BROADCAST before reading a nonce): the network may
// already have the transaction, and a new send would sign a fresh nonce
// and could pay twice.
//
// Kept in localStorage (origin-wide), not component state or
// sessionStorage, so the block holds in every tab of this wallet, after a
// reload and after the browser is closed and reopened; a 'storage' event
// listener keeps open tabs' views live. It also survives the page being
// unmounted (the bridge unwrap runs at module level). Keyed by network +
// lowercase address: one address's record never blocks or shows on
// another. Acknowledging ("I checked; it was not sent") clears that
// record; a later lookup that finds the hash marks it sent ("it was
// sent"), which no longer blocks. When storage is blocked, an in-memory
// copy keeps the block for this page load. The records are public chain
// data; wiping the wallet removes them.
//
// One localStorage key per record (ETH_UNKNOWN_KEY_PREFIX + network +
// address + hash), never one shared key rewritten whole: each tab's
// localStorage view is updated from the others asynchronously, so a tab
// rewriting a shared key from a stale view would erase a record another
// tab had just saved (and with it the only block against a second
// payment). Reads enumerate the keys by prefix. An entry that is not a
// valid record for its key fails closed: it blocks its address as an
// unreadable status-unknown record until acknowledged. The v2 (one
// shared key) and v1 (sessionStorage) layouts are not read or migrated;
// wipe removes them.
//
// In-flight records: services/eth-tx.ts saves every signed tx here BEFORE
// submitting it (beginEthBroadcast), marked `inflight` with the sending
// tab's id, inside the per-address broadcast lock. Such a record is not a
// status-unknown broadcast while that send is still running: it is shown
// as "sending" (neutral; in the sending tab not at all) and cannot be
// acknowledged, since the explorer cannot show the tx yet and clearing it
// would remove the only block that survives the sending tab dying. It
// becomes status-unknown when the send ends with an unknown outcome, or
// once its sender is gone (the lock is free: the tab closed or crashed
// mid-send) — from then on it reads, blocks and is acknowledged like any
// other status-unknown record.
//
// Durable copy (state/eth-send-journal.ts): localStorage is committed to
// disk lazily, so a browser-process crash right after submission could
// lose the pre-submission record. The send path therefore also writes it to
// IndexedDB (durability "strict") and awaits the commit before submitting;
// a failed write refuses the send. Every reader takes the union of both
// stores (an entry unresolved in either one blocks; `durable` below is this
// tab's view of the IndexedDB copy, refreshed from IndexedDB before every
// send, before the mount-time lookups and whenever another tab changes a
// record), and every resolution (confirmed sent, definitive rejection,
// acknowledgement, a lookup finding the hash) and the wipe apply to both.

import type { EthNetwork } from "../chains/ethereum/network";
import {
  ethSendJournalAvailable,
  mutateEthSendJournal,
  readEthSendJournal,
  type JournalChanges,
  type JournalEntries,
} from "./eth-send-journal";
import {
  BroadcastRefusedError,
  ethBroadcastLockName,
  hasWebLocks,
  thisTabId,
  walletTabMayBeOpen,
  webLockHeld,
  withBroadcastLock,
} from "../services/broadcast-lock";

/** Prefix of the per-record keys: `${prefix}<network>:<address>:<hash>`
 *  (address and hash lowercase), one key per record. */
export const ETH_UNKNOWN_KEY_PREFIX = "pearl-wallet-eth-unknown-v3:";
/** The former single-key layout (one JSON object holding every record,
 *  rewritten whole on each change): not read, not migrated; only removed
 *  on wipe. */
export const ETH_UNKNOWN_STORAGE_KEY_V2 = "pearl-wallet-eth-unknown-v2";
/** The former, tab-local (sessionStorage) key; only removed on wipe. */
export const ETH_UNKNOWN_SESSION_KEY_V1 = "pearl-wallet-eth-unknown-v1";

export interface EthUnknownRecord {
  network: EthNetwork;
  /** Sending address (stored lowercase). */
  from: string;
  hash: `0x${string}`;
  /** What was being sent, e.g. "ETH transfer", "approval", "burn". */
  what: string;
  /** When it was recorded (ms since epoch). */
  ts: number;
  /** A later lookup found the hash on the network: it was sent. No longer
   *  blocks; shown until the user dismisses it. */
  sent?: true;
  /** Saved before submission (beginEthBroadcast); the send in tab `owner`
   *  may still be running. Blocks like any unresolved record. */
  inflight?: true;
  /** The sending tab's id (broadcast-lock thisTabId), with `inflight`. */
  owner?: string;
}

type Records = Record<string, EthUnknownRecord[]>;

/** Minimal Storage surface (localStorage, or a test double). `key` /
 *  `length` enumerate the per-record keys. */
export interface KVStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

export function ethUnknownKey(network: string, from: string): string {
  return `${network}:${from.toLowerCase()}`;
}

/** Storage key of one record. */
export function ethUnknownRecordKey(network: string, from: string, hash: string): string {
  return `${ETH_UNKNOWN_KEY_PREFIX}${network}:${from.toLowerCase()}:${hash.toLowerCase()}`;
}

/** Shown (and blocking) in place of an entry that is not a valid record. */
export const ETH_UNKNOWN_UNREADABLE = "unreadable record";
const ZERO_HASH = `0x${"0".repeat(64)}` as const;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

/**
 * The network, address and hash segment a v3 key names, all lowercased
 * (keys are matched case-insensitively: a key written with a mixed-case
 * address still belongs to, and blocks, that address). `hashPart` is null
 * when the key has no hash segment. Null: not a v3 key, or it names no
 * network + valid address (such a key cannot block any send).
 */
function parseRecordKey(key: string): { network: string; addr: string; hashPart: string | null } | null {
  if (!key.startsWith(ETH_UNKNOWN_KEY_PREFIX)) return null;
  const rest = key.slice(ETH_UNKNOWN_KEY_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const network = rest.slice(0, i).toLowerCase();
  const after = rest.slice(i + 1);
  const j = after.indexOf(":");
  const addr = (j < 0 ? after : after.slice(0, j)).toLowerCase();
  if (!ADDR_RE.test(addr)) return null;
  return { network, addr, hashPart: j < 0 ? null : after.slice(j + 1).toLowerCase() };
}

function isRecord(x: unknown): x is EthUnknownRecord {
  const r = x as EthUnknownRecord;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.network === "string" &&
    typeof r.from === "string" &&
    typeof r.hash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(r.hash) &&
    typeof r.what === "string" &&
    typeof r.ts === "number" &&
    (r.sent === undefined || r.sent === true) &&
    (r.inflight === undefined || r.inflight === true) &&
    (r.owner === undefined || typeof r.owner === "string")
  );
}

interface Entry {
  /** The storage key it was read from. */
  key: string;
  rec: EthUnknownRecord;
  /** False: not a valid record (rec stands in for it, failing closed). */
  valid: boolean;
}

/** Every key under `prefix` (a snapshot; read before anything changes). */
function keysWithPrefix(storage: KVStorage, prefix: string): string[] {
  const out: string[] = [];
  const n = storage.length;
  for (let i = 0; i < n; i++) {
    const k = storage.key(i);
    if (k !== null && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

/**
 * The entry stored under `key`, which belongs to `network` + `from`
 * (lowercase). Anything that is not a valid record for exactly that key
 * (unparseable, another shape, another network / address / hash, a
 * missing or bad hash segment in the key) FAILS CLOSED: it reads as an unresolved status-unknown
 * record for that address (what = ETH_UNKNOWN_UNREADABLE, the key's hash
 * when it has one), so it blocks signing until the user checks and
 * acknowledges it, never silently unblocks. Null: the key is gone.
 */
function readEntry(storage: KVStorage, key: string, network: string, from: string): Entry | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const hashPart = parseRecordKey(key)?.hashPart ?? null;
  const keyHash = hashPart !== null && HASH_RE.test(hashPart) ? (hashPart as `0x${string}`) : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (
    keyHash &&
    isRecord(parsed) &&
    parsed.network === network &&
    parsed.from.toLowerCase() === from &&
    parsed.hash.toLowerCase() === keyHash
  ) {
    return { key, rec: { ...parsed, from }, valid: true };
  }
  return {
    key,
    rec: { network: network as EthNetwork, from, hash: keyHash ?? ZERO_HASH, what: ETH_UNKNOWN_UNREADABLE, ts: 0 },
    valid: false,
  };
}

const byAge = (a: Entry, b: Entry) => a.rec.ts - b.rec.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Entries for this network + address, oldest first: every v3 key that
 *  names them, compared case-insensitively (a key without a valid hash
 *  segment reads as an unreadable record and fails closed). Throws if the
 *  storage cannot be read. */
function entriesFor(storage: KVStorage, network: string, from: string): Entry[] {
  const addr = from.toLowerCase();
  const net = network.toLowerCase();
  const out: Entry[] = [];
  for (const k of keysWithPrefix(storage, ETH_UNKNOWN_KEY_PREFIX)) {
    const p = parseRecordKey(k);
    if (!p || p.network !== net || p.addr !== addr) continue;
    const e = readEntry(storage, k, network, addr);
    if (e) out.push(e);
  }
  return out.sort(byAge);
}

/** All records, grouped by ethUnknownKey (each entry read as
 *  entriesFor does: an invalid one fails closed for its address). Keys
 *  that name no network + address cannot block any send and are skipped. */
export function readEthUnknownRecords(storage: KVStorage): Records {
  let keys: string[];
  try {
    keys = keysWithPrefix(storage, ETH_UNKNOWN_KEY_PREFIX);
  } catch {
    return {};
  }
  const groups = new Map<string, Entry[]>();
  for (const k of keys) {
    const p = parseRecordKey(k);
    if (!p) continue;
    const { network, addr } = p;
    let e: Entry | null;
    try {
      e = readEntry(storage, k, network, addr);
    } catch {
      continue;
    }
    if (!e) continue;
    const g = ethUnknownKey(network, addr);
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const out: Records = {};
  for (const [g, es] of groups) out[g] = es.sort(byAge).map((e) => e.rec);
  return out;
}

/** Records (blocking and sent) for this network + address, oldest first. */
export function ethUnknownFor(storage: KVStorage, network: string, from: string | undefined): EthUnknownRecord[] {
  if (!from) return [];
  return entriesFor(storage, network, from).map((e) => e.rec);
}

/** Records a status-unknown broadcast (idempotent per hash). A plain
 *  record for a hash saved in flight turns that record status-unknown (a
 *  record already found sent stays sent). Writes only this record's own
 *  key, so a concurrent write by another tab never erases it or is erased
 *  by it. */
export function putEthUnknown(storage: KVStorage, rec: EthUnknownRecord): void {
  const r: EthUnknownRecord = { ...rec, from: rec.from.toLowerCase() };
  const key = ethUnknownRecordKey(r.network, r.from, r.hash);
  const e = readEntry(storage, key, r.network, r.from);
  // (An unreadable entry under this key is replaced by the valid record.)
  if (e?.valid) {
    const x = e.rec;
    if (!x.inflight || x.sent || r.inflight) return;
    storage.setItem(key, JSON.stringify({ network: x.network, from: x.from, hash: x.hash, what: x.what, ts: x.ts }));
    return;
  }
  storage.setItem(key, JSON.stringify(r));
}

/** Unresolved (blocking) records for this network + address, oldest first. */
export function unresolvedEthUnknownFor(storage: KVStorage, network: string, from: string | undefined): EthUnknownRecord[] {
  return ethUnknownFor(storage, network, from).filter((r) => !r.sent);
}

/** A lookup found `hash` on the network: marks that record sent. */
export function markEthUnknownSentIn(storage: KVStorage, network: string, from: string, hash: string): boolean {
  let changed = false;
  for (const { key, rec: x } of entriesFor(storage, network, from)) {
    if (x.hash.toLowerCase() !== hash.toLowerCase() || x.sent) continue;
    storage.setItem(key, JSON.stringify({ network: x.network, from: x.from, hash: x.hash, what: x.what, ts: x.ts, sent: true }));
    changed = true;
  }
  return changed;
}

/** The user checked `hash` and it was not sent: clears that record only. */
export function acknowledgeEthUnknown(storage: KVStorage, network: string, from: string, hash: string): void {
  for (const { key, rec } of entriesFor(storage, network, from)) {
    if (rec.hash.toLowerCase() === hash.toLowerCase()) storage.removeItem(key);
  }
}

// ── Live store (localStorage + IndexedDB copy + change listeners) ───────

function memoryStorage(m: Map<string, string> = new Map()): KVStorage {
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

let fallback: KVStorage | null = null;
function liveStorage(): KVStorage {
  try {
    const s = (globalThis as { localStorage?: KVStorage }).localStorage;
    if (s) {
      // Probe: localStorage can exist but throw (blocked storage).
      s.getItem(ETH_UNKNOWN_KEY_PREFIX);
      return s;
    }
  } catch {
    /* fall through */
  }
  return (fallback ??= memoryStorage());
}

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of [...listeners]) l();
}

// ── The IndexedDB copy (state/eth-send-journal.ts) ──────────────────────
//
// `durable` is this tab's view of it: replaced wholesale by every read
// and every committed change, in the order those IndexedDB transactions
// were created (they run, and complete, in that order), so a slow read
// never overwrites a newer view.

let durableMap: Map<string, string> = new Map();
let durable: KVStorage = memoryStorage(durableMap);
let journalSeq = 0;
let appliedSeq = 0;

function applyDurable(entries: JournalEntries, seq: number): boolean {
  if (seq < appliedSeq) return false;
  appliedSeq = seq;
  const same = entries.size === durableMap.size && [...entries].every(([k, v]) => durableMap.get(k) === v);
  if (same) return false;
  durableMap = new Map(entries);
  durable = memoryStorage(durableMap);
  return true;
}

/**
 * Re-reads the IndexedDB copy into this tab's view (and notifies when it
 * changed). False if IndexedDB could not be read; true when it was read,
 * or where there is no IndexedDB at all. Never throws.
 */
export async function refreshDurableEthUnknown(): Promise<boolean> {
  if (!ethSendJournalAvailable()) return true;
  const seq = ++journalSeq;
  try {
    const entries = await readEthSendJournal();
    if (applyDurable(entries, seq)) notify();
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies `change` (one of the KVStorage functions above) to the
 * IndexedDB copy inside one read-write transaction, durability "strict",
 * and resolves once it has committed, with the entries as they now are;
 * null where there is no IndexedDB. Rejects if the transaction failed
 * (nothing changed).
 */
async function mutateDurable(change: (s: KVStorage) => void): Promise<JournalEntries | null> {
  if (!ethSendJournalAvailable()) return null;
  const seq = ++journalSeq;
  const after = await mutateEthSendJournal((entries) => {
    const m = new Map(entries);
    change(memoryStorage(m));
    const out: JournalChanges = new Map();
    for (const [k, v] of m) if (entries.get(k) !== v) out.set(k, v);
    for (const k of entries.keys()) if (!m.has(k)) out.set(k, null);
    return out;
  });
  if (applyDurable(after, seq)) notify();
  return after;
}

// Another tab wrote a record: re-read. (A 'storage' event fires in every
// OTHER same-origin document; key null = localStorage.clear().) Every
// change to the IndexedDB copy is paired with one to localStorage, so the
// same event refreshes this tab's view of the IndexedDB copy.
{
  const g = globalThis as { addEventListener?: (t: string, fn: (e: { key?: string | null }) => void) => void };
  if (typeof g.addEventListener === "function") {
    try {
      g.addEventListener("storage", (e) => {
        if (!e || e.key === null || e.key === undefined || e.key.startsWith(ETH_UNKNOWN_KEY_PREFIX)) {
          notify();
          void refreshDurableEthUnknown();
        }
      });
    } catch {
      /* no storage events: this tab still reads storage before every send */
    }
  }
}
// A fresh page: load the IndexedDB copy (a record whose localStorage copy
// was lost shows, and blocks, from here on).
if (ethSendJournalAvailable()) void refreshDurableEthUnknown();

export function subscribeEthUnknown(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Hashes this tab is submitting right now (between beginEthBroadcast and
// the outcome being recorded or cleared).
const ownInflight = new Set<string>();
const ownKey = (network: string, hash: string) => `${network}:${hash.toLowerCase()}`;

/** Records a status-unknown broadcast in both stores (localStorage at
 *  once, the IndexedDB copy before this resolves). Never throws: if a
 *  store refuses, the other one (or the in-memory copy) still holds it. */
export async function recordEthUnknown(rec: Omit<EthUnknownRecord, "ts" | "sent" | "inflight" | "owner"> & { ts?: number }): Promise<void> {
  ownInflight.delete(ownKey(rec.network, rec.hash));
  const r: EthUnknownRecord = { network: rec.network, from: rec.from, hash: rec.hash, what: rec.what, ts: rec.ts ?? Date.now() };
  try {
    putEthUnknown(liveStorage(), r);
  } catch {
    // Storage full / blocked: keep it for this page load at least.
    putEthUnknown((fallback ??= memoryStorage()), r);
  }
  notify();
  try {
    await mutateDurable((s) => putEthUnknown(s, r));
  } catch {
    /* the localStorage copy holds it */
  }
}

const recordRefusal = () =>
  new BroadcastRefusedError(
    "storage",
    "E_ETH_BROADCAST_RECORD: the wallet could not save this transaction before sending it, so nothing was sent",
  );

/**
 * Records a signed Ethereum tx BEFORE it is submitted (services/eth-tx.ts,
 * inside the per-address broadcast lock), as an unresolved record: from
 * here until the outcome is known it blocks every tab, and if this page
 * (or the whole browser) dies mid-submission or mid-lookup it keeps
 * blocking (a fresh tab looks the hash up on mount, as for any
 * status-unknown record). The caller clears it on a confirmed send or a
 * definitive rejection.
 *
 * Must reach localStorage (read back) AND, where IndexedDB exists, the
 * IndexedDB copy (a committed durability-"strict" transaction), else
 * nothing is sent: rejects with a BroadcastRefusedError("storage") and
 * removes what it saved (nothing was submitted). Only where there is no
 * localStorage at all (not a browser) the in-memory copy stands in.
 */
export async function beginEthBroadcast(rec: Omit<EthUnknownRecord, "ts" | "sent" | "inflight" | "owner">): Promise<void> {
  const r: EthUnknownRecord = {
    network: rec.network,
    from: rec.from.toLowerCase(),
    hash: rec.hash,
    what: rec.what,
    ts: Date.now(),
    inflight: true,
    owner: thisTabId,
  };
  const sameHash = (x: EthUnknownRecord) => x.hash.toLowerCase() === r.hash.toLowerCase();
  let ls: KVStorage | undefined;
  let blocked = false;
  try {
    ls = (globalThis as { localStorage?: KVStorage }).localStorage;
  } catch {
    blocked = true;
  }
  if (!ls && !blocked) {
    putEthUnknown((fallback ??= memoryStorage()), r);
  } else {
    try {
      if (!ls) throw new Error("blocked");
      putEthUnknown(ls, r);
      if (!ethUnknownFor(ls, r.network, r.from).some(sameHash)) throw new Error("not saved");
    } catch {
      throw recordRefusal();
    }
  }
  // From here this tab's own (not "another tab's") in-flight send.
  ownInflight.add(ownKey(r.network, r.hash));
  if (ethSendJournalAvailable()) {
    let saved = false;
    try {
      const after = await mutateDurable((s) => putEthUnknown(s, r));
      saved = after !== null && ethUnknownFor(memoryStorage(new Map(after)), r.network, r.from).some(sameHash);
    } catch {
      saved = false;
    }
    if (!saved) {
      // Nothing was submitted: take the record back out of both stores.
      ownInflight.delete(ownKey(r.network, r.hash));
      try {
        if (ls) acknowledgeEthUnknown(ls, r.network, r.from, r.hash);
      } catch {
        /* ignore */
      }
      if (fallback) acknowledgeEthUnknown(fallback, r.network, r.from, r.hash);
      void mutateDurable((s) => acknowledgeEthUnknown(s, r.network, r.from, r.hash)).catch(() => undefined);
      notify();
      throw recordRefusal();
    }
  }
  notify();
}

/**
 * Removes the record(s) of `hash` from both stores (a confirmed send, a
 * definitive rejection, an acknowledgement, dismissing a "sent" record).
 * True once both are gone; false if the IndexedDB copy could not be
 * changed (it then still blocks, failing closed). Never throws.
 */
export async function clearEthUnknown(network: string, from: string, hash: string): Promise<boolean> {
  try {
    acknowledgeEthUnknown(liveStorage(), network, from, hash);
  } catch {
    /* ignore */
  }
  if (fallback) acknowledgeEthUnknown(fallback, network, from, hash);
  notify();
  let ok = true;
  try {
    await mutateDurable((s) => acknowledgeEthUnknown(s, network, from, hash));
  } catch {
    ok = false;
  }
  // Only now: until the IndexedDB copy is gone this tab's own in-flight
  // record must not read as another (gone) sender's.
  ownInflight.delete(ownKey(network, hash));
  notify();
  return ok;
}

/** A lookup found `hash` on the network: "it was sent", in both stores.
 *  Unblocks. Never throws. */
export async function markEthUnknownSent(network: string, from: string, hash: string): Promise<void> {
  try {
    markEthUnknownSentIn(liveStorage(), network, from, hash);
  } catch {
    /* ignore */
  }
  if (fallback) markEthUnknownSentIn(fallback, network, from, hash);
  notify();
  try {
    await mutateDurable((s) => void markEthUnknownSentIn(s, network, from, hash));
  } catch {
    /* the IndexedDB copy still blocks (fails closed); the next lookup retries */
  }
}

/** The in-flight record stored under `key`, when that key holds a valid
 *  one (null otherwise: a plain, sent or unreadable entry). */
function inflightEntryAt(storage: KVStorage, key: string): EthUnknownRecord | null {
  const p = parseRecordKey(key);
  if (!p) return null;
  const e = readEntry(storage, key, p.network, p.addr);
  return e?.valid && e.rec.inflight && !e.rec.sent ? e.rec : null;
}

/**
 * Wipe / replace-wallet: forgets every record (every per-record key in
 * live storage and in the IndexedDB copy, the former v2 key and v1 session
 * key, and the in-memory copy) EXCEPT an in-flight record whose send may
 * still be running (ethInflightSenderActive: this tab's own running send,
 * or the per-address broadcast lock held by another tab). That send has
 * signed and may have submitted; its record is the only block that
 * survives the sender dying mid-flight, so removing it then would let a
 * later tab (the same wallet restored) sign a second payment. Once its
 * sender is gone the record reads status-unknown and a later wipe removes
 * it.
 *
 * Plain, sent and unreadable records go at once (localStorage
 * synchronously, the IndexedDB copy in one transaction); each in-flight
 * one is removed only after its sender is found gone, and then from either
 * store only if its entry is still exactly the one seen (an in-flight
 * record that turned status-unknown meanwhile, or any other change, stays).
 * Keys saved after the snapshot (a send that starts meanwhile) are never
 * touched.
 *
 * `recordedUpTo` (ms since epoch; the wipe / replace passes the time it
 * started): a valid record saved after it (ts greater) is kept. Between the
 * keystore transaction committing and this clear running, another tab can
 * restore a wallet and send from it; that send's record belongs to the
 * restored wallet, not the one wiped, and is its only block against paying
 * twice.
 */
export async function clearAllEthUnknown(opts: { recordedUpTo?: number } = {}): Promise<void> {
  const upTo = opts.recordedUpTo;
  /** A valid record under `key` saved after `upTo`: not this clear's. */
  const newer = (s: KVStorage, key: string): boolean => {
    if (upTo === undefined) return false;
    const p = parseRecordKey(key);
    if (!p) return false;
    const e = readEntry(s, key, p.network, p.addr);
    return !!e?.valid && e.rec.ts > upTo;
  };
  const stores: KVStorage[] = [];
  for (const s of [
    (globalThis as { localStorage?: KVStorage }).localStorage,
    (globalThis as { sessionStorage?: KVStorage }).sessionStorage,
  ]) {
    try {
      s?.removeItem(ETH_UNKNOWN_STORAGE_KEY_V2);
      s?.removeItem(ETH_UNKNOWN_SESSION_KEY_V1);
      if (s) stores.push(s);
    } catch {
      /* ignore */
    }
  }
  if (fallback) stores.push(fallback);
  const pending: Array<{ rec: EthUnknownRecord; remove: () => Promise<void> }> = [];
  for (const s of stores) {
    try {
      for (const k of keysWithPrefix(s, ETH_UNKNOWN_KEY_PREFIX)) {
        let rec: EthUnknownRecord | null = null;
        let value: string | null = null;
        try {
          if (newer(s, k)) continue;
          value = s.getItem(k);
          rec = inflightEntryAt(s, k);
        } catch {
          rec = null;
        }
        if (rec) {
          pending.push({
            rec,
            // Compare-and-remove: only the exact entry seen in the snapshot
            // (the IndexedDB copy below follows the same rule).
            remove: async () => {
              try {
                if (s.getItem(k) === value) s.removeItem(k);
              } catch {
                /* ignore */
              }
            },
          });
        } else s.removeItem(k);
      }
    } catch {
      /* ignore */
    }
  }
  // The IndexedDB copy: everything but in-flight records, in one
  // transaction (every key in that store is a record key).
  try {
    const seen: Array<{ key: string; value: string; rec: EthUnknownRecord }> = [];
    await mutateDurable((s) => {
      for (const k of keysWithPrefix(s, "")) {
        let rec: EthUnknownRecord | null = null;
        try {
          if (newer(s, k)) continue;
          rec = inflightEntryAt(s, k);
        } catch {
          rec = null;
        }
        if (rec) seen.push({ key: k, value: s.getItem(k) ?? "", rec });
        else s.removeItem(k);
      }
    });
    for (const { key, value, rec } of seen) {
      pending.push({
        rec,
        remove: async () => {
          try {
            await mutateDurable((s) => {
              if (s.getItem(key) === value) s.removeItem(key);
            });
          } catch {
            /* still blocks; a later wipe removes it */
          }
        },
      });
    }
  } catch {
    /* IndexedDB failed: its records stay (and keep blocking) */
  }
  const kept = new Set<string>();
  const active = new Map<string, Promise<boolean>>();
  for (const { rec, remove } of pending) {
    const id = `${rec.network}:${rec.from}:${rec.hash.toLowerCase()}:${rec.owner ?? ""}`;
    let a = active.get(id);
    if (!a) active.set(id, (a = ethInflightSenderActive(rec)));
    if (await a) {
      kept.add(ownKey(rec.network, rec.hash));
      continue;
    }
    await remove();
  }
  if (fallback && fallback.length === 0) fallback = null;
  for (const k of [...ownInflight]) if (!kept.has(k)) ownInflight.delete(k);
  notify();
}

/** This network + address's records in every store (localStorage, the
 *  in-memory copy, the IndexedDB copy), one per hash, oldest first. Where
 *  the stores disagree about a hash, an unresolved entry wins over a
 *  "sent" one (either store unresolved blocks), and an earlier store's
 *  entry over a later one's. */
function liveFor(network: string, from: string | undefined): EthUnknownRecord[] {
  const sources: EthUnknownRecord[][] = [];
  try {
    sources.push(ethUnknownFor(liveStorage(), network, from));
  } catch {
    /* ignore */
  }
  if (fallback) sources.push(ethUnknownFor(fallback, network, from));
  sources.push(ethUnknownFor(durable, network, from));
  const byHash = new Map<string, EthUnknownRecord>();
  for (const list of sources) {
    for (const r of list) {
      const h = r.hash.toLowerCase();
      const x = byHash.get(h);
      if (!x || (x.sent && !r.sent)) byHash.set(h, r);
    }
  }
  return [...byHash.values()].sort((a, b) => a.ts - b.ts);
}

/** Every unresolved (blocking) record for this network + address,
 *  in-flight ones included. */
export function unresolvedEthUnknown(network: string, from: string | undefined): EthUnknownRecord[] {
  return liveFor(network, from).filter((r) => !r.sent);
}

/** This tab is submitting `rec` right now. */
export function isOwnInflight(rec: EthUnknownRecord): boolean {
  return rec.inflight === true && rec.owner === thisTabId && ownInflight.has(ownKey(rec.network, rec.hash));
}

/**
 * Whether the send that saved in-flight record `rec` may still be running:
 * this tab's own running send; with Web Locks, while the per-address
 * broadcast lock is held (the sender holds it from before saving the record
 * until its outcome is recorded; the browser frees it when the tab closes
 * or crashes); without Web Locks, while its tab is still listed. False for
 * a record that is not in flight. Fails closed (true) if the lock cannot
 * be probed.
 */
export async function ethInflightSenderActive(rec: EthUnknownRecord): Promise<boolean> {
  if (!rec.inflight || rec.sent) return false;
  if (rec.owner === thisTabId) return ownInflight.has(ownKey(rec.network, rec.hash));
  if (!hasWebLocks()) return rec.owner === undefined || walletTabMayBeOpen(rec.owner);
  try {
    return await webLockHeld(ethBroadcastLockName(rec.network, rec.from));
  } catch {
    return true;
  }
}

/**
 * Refuses ("busy", nothing signed) while an in-flight record for this
 * network + address belongs to a send that may still be running (another
 * tab, or this one): "another wallet tab is sending from this address",
 * not "may already be on the network". An in-flight record whose sender
 * is gone is left to the check inside the broadcast lock, which refuses it
 * as status-unknown (EthUnresolvedBroadcastError).
 */
export async function assertNoRunningEthSend(network: string, from: string): Promise<void> {
  for (const r of unresolvedEthUnknown(network, from)) {
    if (r.inflight && (await ethInflightSenderActive(r))) {
      throw new BroadcastRefusedError("busy", "E_BROADCAST_BUSY: another wallet tab is sending from this address");
    }
  }
}

/**
 * "I checked; it was not sent." Clears a status-unknown record (in both
 * stores; false if the IndexedDB copy could not be cleared, so it still
 * blocks). An in-flight record is cleared only once its sender is gone,
 * and then while holding the per-address broadcast lock (no send can
 * start meanwhile); while the send may still be running nothing is
 * cleared (false).
 */
export async function acknowledgeEthUnknownChecked(network: string, from: string, hash: string): Promise<boolean> {
  const find = () => liveFor(network, from).find((r) => r.hash.toLowerCase() === hash.toLowerCase());
  const rec = find();
  if (!rec) return true;
  if (!rec.inflight || rec.sent) return clearEthUnknown(network, from, hash);
  if (rec.owner === thisTabId && ownInflight.has(ownKey(network, hash))) return false;
  if (!hasWebLocks()) {
    if (rec.owner === undefined || walletTabMayBeOpen(rec.owner)) return false;
    return clearEthUnknown(network, from, hash);
  }
  try {
    return await withBroadcastLock(
      // Holding the lock: no send from this address is running.
      async () => clearEthUnknown(network, from, hash),
      { name: ethBroadcastLockName(network, from), ifAvailable: true },
    );
  } catch {
    return false;
  }
}

/** The record to show for this network + address: the oldest unresolved
 *  one, else the oldest one found sent; null when there is none. */
export function currentEthUnknown(network: string, from: string | undefined): EthUnknownRecord | null {
  const all = liveFor(network, from);
  return all.find((r) => !r.sent) ?? all[0] ?? null;
}

/** True for the stand-in of an entry that could not be read (its hash is
 *  the key's, or the zero hash when the key had none). */
export function isUnreadableEthUnknown(rec: { what: string }): boolean {
  return rec.what === ETH_UNKNOWN_UNREADABLE;
}

/** The zero hash an unreadable entry without a usable hash carries. */
export const ETH_UNKNOWN_ZERO_HASH = ZERO_HASH;

/**
 * Refusal raised by the signing service (services/eth-tx.ts) while an
 * unresolved status-unknown broadcast is recorded for the sending network +
 * address: nothing was signed. Names the hash to check.
 */
export class EthUnresolvedBroadcastError extends Error {
  readonly hash: `0x${string}`;
  readonly what: string;
  constructor(rec: EthUnknownRecord) {
    super(`E_ETH_UNRESOLVED_BROADCAST: ${rec.hash}`);
    this.name = "EthUnresolvedBroadcastError";
    this.hash = rec.hash;
    this.what = rec.what;
  }
}

/** Throws EthUnresolvedBroadcastError while an unresolved record exists
 *  for this network + address in either store (localStorage read fresh;
 *  the IndexedDB copy as last read — assertNoUnresolvedEthBroadcastDurable
 *  re-reads it first). `exceptInflight`: in-flight records are left to the
 *  check made inside the broadcast lock (eth-tx signAndBroadcast). There,
 *  holding the lock, any in-flight record's sender is gone, so it blocks as
 *  status-unknown; before the lock the caller just waits for a running
 *  send to finish. */
export function assertNoUnresolvedEthBroadcast(network: string, from: string, opts: { exceptInflight?: boolean } = {}): void {
  const rec = unresolvedEthUnknown(network, from).find((r) => !(opts.exceptInflight && r.inflight));
  if (rec) throw new EthUnresolvedBroadcastError(rec);
}

/** assertNoUnresolvedEthBroadcast after re-reading the IndexedDB copy
 *  from IndexedDB itself. If IndexedDB cannot be read, refuses
 *  (BroadcastRefusedError "storage"): a record only it still holds (its
 *  localStorage copy lost in a crash) must not be missed. */
export async function assertNoUnresolvedEthBroadcastDurable(
  network: string,
  from: string,
  opts: { exceptInflight?: boolean } = {},
): Promise<void> {
  if (!(await refreshDurableEthUnknown())) {
    throw new BroadcastRefusedError(
      "storage",
      "E_ETH_BROADCAST_RECORD: the wallet could not read its saved send records, so nothing was signed",
    );
  }
  assertNoUnresolvedEthBroadcast(network, from, opts);
}

/** Tests only: drop this module's view of the IndexedDB copy. */
export function __resetDurableEthUnknownForTests(): void {
  durableMap = new Map();
  durable = memoryStorage(durableMap);
  appliedSeq = journalSeq;
}
