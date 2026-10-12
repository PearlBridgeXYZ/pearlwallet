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
// v1 of this key lived in sessionStorage; it is not migrated.
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

import type { EthNetwork } from "../chains/ethereum/network";
import {
  BroadcastRefusedError,
  ethBroadcastLockName,
  hasWebLocks,
  thisTabId,
  walletTabMayBeOpen,
  webLockHeld,
  withBroadcastLock,
} from "../services/broadcast-lock";

export const ETH_UNKNOWN_STORAGE_KEY = "pearl-wallet-eth-unknown-v2";
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

/** Minimal Storage surface (localStorage, or a test double). */
export interface KVStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function ethUnknownKey(network: string, from: string): string {
  return `${network}:${from.toLowerCase()}`;
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

/** All records, validated (malformed entries are dropped, never trusted). */
export function readEthUnknownRecords(storage: KVStorage): Records {
  let raw: string | null;
  try {
    raw = storage.getItem(ETH_UNKNOWN_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Records = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    // A record only counts under the key it belongs to.
    const recs = v.filter((r): r is EthUnknownRecord => isRecord(r) && ethUnknownKey(r.network, r.from) === k);
    if (recs.length > 0) out[k] = recs;
  }
  return out;
}

function writeRecords(storage: KVStorage, recs: Records): void {
  if (Object.keys(recs).length === 0) storage.removeItem(ETH_UNKNOWN_STORAGE_KEY);
  else storage.setItem(ETH_UNKNOWN_STORAGE_KEY, JSON.stringify(recs));
}

/** Records (blocking and sent) for this network + address, oldest first. */
export function ethUnknownFor(storage: KVStorage, network: string, from: string | undefined): EthUnknownRecord[] {
  if (!from) return [];
  return readEthUnknownRecords(storage)[ethUnknownKey(network, from)] ?? [];
}

/** Records a status-unknown broadcast (idempotent per hash). A plain
 *  record for a hash saved in flight turns that record status-unknown (a
 *  record already found sent stays sent). */
export function putEthUnknown(storage: KVStorage, rec: EthUnknownRecord): void {
  const r: EthUnknownRecord = { ...rec, from: rec.from.toLowerCase() };
  const all = readEthUnknownRecords(storage);
  const k = ethUnknownKey(r.network, r.from);
  const list = all[k] ?? [];
  const i = list.findIndex((x) => x.hash.toLowerCase() === r.hash.toLowerCase());
  if (i >= 0) {
    const x = list[i]!;
    if (!x.inflight || x.sent || r.inflight) return;
    const settled: EthUnknownRecord = { network: x.network, from: x.from, hash: x.hash, what: x.what, ts: x.ts };
    all[k] = list.map((y, j) => (j === i ? settled : y));
  } else {
    all[k] = [...list, r];
  }
  writeRecords(storage, all);
}

/** Unresolved (blocking) records for this network + address, oldest first. */
export function unresolvedEthUnknownFor(storage: KVStorage, network: string, from: string | undefined): EthUnknownRecord[] {
  return ethUnknownFor(storage, network, from).filter((r) => !r.sent);
}

/** A lookup found `hash` on the network: marks that record sent. */
export function markEthUnknownSentIn(storage: KVStorage, network: string, from: string, hash: string): boolean {
  const all = readEthUnknownRecords(storage);
  const k = ethUnknownKey(network, from);
  const list = all[k];
  if (!list) return false;
  let changed = false;
  all[k] = list.map((x) => {
    if (x.hash.toLowerCase() !== hash.toLowerCase() || x.sent) return x;
    changed = true;
    return { network: x.network, from: x.from, hash: x.hash, what: x.what, ts: x.ts, sent: true as const };
  });
  if (changed) writeRecords(storage, all);
  return changed;
}

/** The user checked `hash` and it was not sent: clears that record only. */
export function acknowledgeEthUnknown(storage: KVStorage, network: string, from: string, hash: string): void {
  const all = readEthUnknownRecords(storage);
  const k = ethUnknownKey(network, from);
  const list = (all[k] ?? []).filter((x) => x.hash.toLowerCase() !== hash.toLowerCase());
  if (list.length > 0) all[k] = list;
  else delete all[k];
  writeRecords(storage, all);
}

// ── Live store (localStorage + change listeners) ────────────────────────

function memoryStorage(): KVStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

let fallback: KVStorage | null = null;
function liveStorage(): KVStorage {
  try {
    const s = (globalThis as { localStorage?: KVStorage }).localStorage;
    if (s) {
      // Probe: localStorage can exist but throw (blocked storage).
      s.getItem(ETH_UNKNOWN_STORAGE_KEY);
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

// Another tab wrote the key: re-read. (A 'storage' event fires in every
// OTHER same-origin document; key null = localStorage.clear().)
{
  const g = globalThis as { addEventListener?: (t: string, fn: (e: { key?: string | null }) => void) => void };
  if (typeof g.addEventListener === "function") {
    try {
      g.addEventListener("storage", (e) => {
        if (!e || e.key === null || e.key === undefined || e.key === ETH_UNKNOWN_STORAGE_KEY) notify();
      });
    } catch {
      /* no storage events: this tab still reads storage before every send */
    }
  }
}

export function subscribeEthUnknown(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Hashes this tab is submitting right now (between beginEthBroadcast and
// the outcome being recorded or cleared).
const ownInflight = new Set<string>();
const ownKey = (network: string, hash: string) => `${network}:${hash.toLowerCase()}`;

export function recordEthUnknown(rec: Omit<EthUnknownRecord, "ts" | "sent" | "inflight" | "owner"> & { ts?: number }): void {
  ownInflight.delete(ownKey(rec.network, rec.hash));
  const r: EthUnknownRecord = { network: rec.network, from: rec.from, hash: rec.hash, what: rec.what, ts: rec.ts ?? Date.now() };
  try {
    putEthUnknown(liveStorage(), r);
  } catch {
    // Storage full / blocked: keep it for this page load at least.
    putEthUnknown((fallback ??= memoryStorage()), r);
  }
  notify();
}

/**
 * Records a signed Ethereum tx BEFORE it is submitted (services/eth-tx.ts,
 * inside the per-address broadcast lock), as an unresolved record: from
 * here until the outcome is known it blocks every tab, and if this page
 * dies mid-submission or mid-lookup it keeps blocking (a fresh tab looks
 * the hash up on mount, as for any status-unknown record). The caller
 * clears it on a confirmed send or a definitive rejection.
 *
 * Must reach localStorage (read back), else nothing is sent: throws a
 * BroadcastRefusedError("storage"). Only where there is no localStorage at
 * all (not a browser) the in-memory copy stands in.
 */
export function beginEthBroadcast(rec: Omit<EthUnknownRecord, "ts" | "sent" | "inflight" | "owner">): void {
  const r: EthUnknownRecord = {
    network: rec.network,
    from: rec.from.toLowerCase(),
    hash: rec.hash,
    what: rec.what,
    ts: Date.now(),
    inflight: true,
    owner: thisTabId,
  };
  let ls: KVStorage | undefined;
  let blocked = false;
  try {
    ls = (globalThis as { localStorage?: KVStorage }).localStorage;
  } catch {
    blocked = true;
  }
  if (!ls && !blocked) {
    putEthUnknown((fallback ??= memoryStorage()), r);
    ownInflight.add(ownKey(r.network, r.hash));
    notify();
    return;
  }
  try {
    if (!ls) throw new Error("blocked");
    putEthUnknown(ls, r);
    const saved = ethUnknownFor(ls, r.network, r.from).some((x) => x.hash.toLowerCase() === r.hash.toLowerCase());
    if (!saved) throw new Error("not saved");
  } catch {
    throw new BroadcastRefusedError(
      "storage",
      "E_ETH_BROADCAST_RECORD: the wallet could not save this transaction before sending it, so nothing was sent",
    );
  }
  ownInflight.add(ownKey(r.network, r.hash));
  notify();
}

export function clearEthUnknown(network: string, from: string, hash: string): void {
  ownInflight.delete(ownKey(network, hash));
  try {
    acknowledgeEthUnknown(liveStorage(), network, from, hash);
  } catch {
    /* ignore */
  }
  if (fallback) acknowledgeEthUnknown(fallback, network, from, hash);
  notify();
}

/** A lookup found `hash` on the network: "it was sent". Unblocks. */
export function markEthUnknownSent(network: string, from: string, hash: string): void {
  try {
    markEthUnknownSentIn(liveStorage(), network, from, hash);
  } catch {
    /* ignore */
  }
  if (fallback) markEthUnknownSentIn(fallback, network, from, hash);
  notify();
}

/** Wipe: forgets every record (live storage, the v1 session key and the
 *  in-memory copy). */
export function clearAllEthUnknown(): void {
  for (const s of [
    (globalThis as { localStorage?: KVStorage }).localStorage,
    (globalThis as { sessionStorage?: KVStorage }).sessionStorage,
  ]) {
    try {
      s?.removeItem(ETH_UNKNOWN_STORAGE_KEY);
      s?.removeItem(ETH_UNKNOWN_SESSION_KEY_V1);
    } catch {
      /* ignore */
    }
  }
  fallback = null;
  ownInflight.clear();
  notify();
}

function liveFor(network: string, from: string | undefined): EthUnknownRecord[] {
  let live: EthUnknownRecord[] = [];
  try {
    live = ethUnknownFor(liveStorage(), network, from);
  } catch {
    /* ignore */
  }
  const mem = fallback ? ethUnknownFor(fallback, network, from) : [];
  const seen = new Set(live.map((r) => r.hash.toLowerCase()));
  return [...live, ...mem.filter((r) => !seen.has(r.hash.toLowerCase()))];
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
 * "I checked; it was not sent." Clears a status-unknown record. An
 * in-flight record is cleared only once its sender is gone, and then while
 * holding the per-address broadcast lock (no send can start meanwhile);
 * while the send may still be running nothing is cleared (false).
 */
export async function acknowledgeEthUnknownChecked(network: string, from: string, hash: string): Promise<boolean> {
  const find = () => liveFor(network, from).find((r) => r.hash.toLowerCase() === hash.toLowerCase());
  const rec = find();
  if (!rec) return true;
  if (!rec.inflight || rec.sent) {
    clearEthUnknown(network, from, hash);
    return true;
  }
  if (rec.owner === thisTabId && ownInflight.has(ownKey(network, hash))) return false;
  if (!hasWebLocks()) {
    if (rec.owner === undefined || walletTabMayBeOpen(rec.owner)) return false;
    clearEthUnknown(network, from, hash);
    return true;
  }
  try {
    return await withBroadcastLock(
      async () => {
        // Holding the lock: no send from this address is running.
        if (find()) clearEthUnknown(network, from, hash);
        return true;
      },
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
 *  for this network + address (read fresh from storage, not a cached view).
 *  `exceptInflight`: in-flight records are left to the check made inside
 *  the broadcast lock (eth-tx signAndBroadcast). There, holding the lock,
 *  any in-flight record's sender is gone, so it blocks as status-unknown;
 *  before the lock the caller just waits for a running send to finish. */
export function assertNoUnresolvedEthBroadcast(network: string, from: string, opts: { exceptInflight?: boolean } = {}): void {
  const rec = unresolvedEthUnknown(network, from).find((r) => !(opts.exceptInflight && r.inflight));
  if (rec) throw new EthUnresolvedBroadcastError(rec);
}
