// Ethereum broadcasts whose outcome could not be determined
// (EthBroadcastStatusUnknownError) and that the user has not yet
// acknowledged. While one is recorded for a network + sending address,
// Send ETH, Send WPRL and Unwrap refuse another send from that address:
// the network may already have the transaction, and a new send would sign
// a fresh nonce and could pay twice.
//
// Kept in sessionStorage, not component state, so the block survives the
// page being unmounted and remounted (navigating away and back, switching
// bridge tabs, a reload) and so a result delivered after its page
// unmounted (the bridge unwrap runs at module level) is still recorded.
// Keyed by network + lowercase address: one address's record never blocks
// or shows on another. Acknowledging ("I checked; it was not sent") clears
// that record.

import type { EthNetwork } from "../chains/ethereum/network";

export const ETH_UNKNOWN_STORAGE_KEY = "pearl-wallet-eth-unknown-v1";

export interface EthUnknownRecord {
  network: EthNetwork;
  /** Sending address (stored lowercase). */
  from: string;
  hash: `0x${string}`;
  /** What was being sent, e.g. "ETH transfer", "approval", "burn". */
  what: string;
  /** When it was recorded (ms since epoch). */
  ts: number;
}

type Records = Record<string, EthUnknownRecord[]>;

/** Minimal Storage surface (sessionStorage, or a test double). */
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
    typeof r.ts === "number"
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

/** Unacknowledged records for this network + address, oldest first. */
export function ethUnknownFor(storage: KVStorage, network: string, from: string | undefined): EthUnknownRecord[] {
  if (!from) return [];
  return readEthUnknownRecords(storage)[ethUnknownKey(network, from)] ?? [];
}

/** Records a status-unknown broadcast (idempotent per hash). */
export function putEthUnknown(storage: KVStorage, rec: EthUnknownRecord): void {
  const r: EthUnknownRecord = { ...rec, from: rec.from.toLowerCase() };
  const all = readEthUnknownRecords(storage);
  const k = ethUnknownKey(r.network, r.from);
  const list = all[k] ?? [];
  if (list.some((x) => x.hash.toLowerCase() === r.hash.toLowerCase())) return;
  all[k] = [...list, r];
  writeRecords(storage, all);
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

// ── Live store (sessionStorage + change listeners) ──────────────────────

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
    const s = (globalThis as { sessionStorage?: KVStorage }).sessionStorage;
    if (s) {
      // Probe: sessionStorage can exist but throw (blocked storage).
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

export function subscribeEthUnknown(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recordEthUnknown(rec: Omit<EthUnknownRecord, "ts"> & { ts?: number }): void {
  try {
    putEthUnknown(liveStorage(), { ...rec, ts: rec.ts ?? Date.now() });
  } catch {
    // Storage full / blocked: keep it for this page load at least.
    putEthUnknown((fallback ??= memoryStorage()), { ...rec, ts: rec.ts ?? Date.now() });
  }
  notify();
}

export function clearEthUnknown(network: string, from: string, hash: string): void {
  try {
    acknowledgeEthUnknown(liveStorage(), network, from, hash);
  } catch {
    /* ignore */
  }
  if (fallback) acknowledgeEthUnknown(fallback, network, from, hash);
  notify();
}

/** The oldest unacknowledged record for this network + address. */
export function currentEthUnknown(network: string, from: string | undefined): EthUnknownRecord | null {
  const live = ethUnknownFor(liveStorage(), network, from);
  if (live.length > 0) return live[0]!;
  return fallback ? (ethUnknownFor(fallback, network, from)[0] ?? null) : null;
}
