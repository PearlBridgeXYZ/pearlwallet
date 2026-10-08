// Test helpers for the broadcast records (src/services/pending-spends.ts):
// an in-memory localStorage that can be told to fail, a seeded record
// list, and an in-process Web Locks implementation (exclusive, FIFO,
// `ifAvailable`, `signal`) so lock behaviour is real, not mocked away.

import { vi } from "vitest";
import { BROADCASTS_STORAGE_KEY, outpointKey, type BroadcastRecord } from "../../src/services/pending-spends";

export interface MemoryStorage extends Storage {
  failWrites: boolean;
  failReads: boolean;
  data: Map<string, string>;
}

/** A Storage backed by a Map; `failWrites` / `failReads` make it throw. */
export function memoryStorage(data: Map<string, string> = new Map()): MemoryStorage {
  const s = {
    data,
    failWrites: false,
    failReads: false,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem(k: string) {
      if (s.failReads) throw new Error("SecurityError");
      return data.has(k) ? data.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (s.failWrites) throw new Error("QuotaExceededError");
      data.set(k, String(v));
    },
    removeItem(k: string) {
      data.delete(k);
    },
    clear() {
      data.clear();
    },
  };
  return s as MemoryStorage;
}

/** Installs a fresh in-memory localStorage (undone by vi.unstubAllGlobals). */
export function useMemoryStorage(data?: Map<string, string>): MemoryStorage {
  const s = memoryStorage(data);
  vi.stubGlobal("localStorage", s);
  return s;
}

/** A complete record with defaults. */
export function rec(p: Partial<BroadcastRecord> & { txid: string; inputs: string[] }): BroadcastRecord {
  return {
    addresses: [],
    destination: null,
    amountGrains: null,
    kind: "payment",
    createdAt: Date.now(),
    state: "unknown",
    ...p,
  };
}

/** Writes `records` straight into storage (as another tab / an earlier
 *  session would have left them). */
export function seedRecords(records: BroadcastRecord[]): void {
  localStorage.setItem(BROADCASTS_STORAGE_KEY, JSON.stringify({ v: 1, records }));
}

export function storedRecords(): BroadcastRecord[] {
  const raw = localStorage.getItem(BROADCASTS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { records: BroadcastRecord[] }).records : [];
}

type Cb = (lock: unknown) => Promise<unknown>;

/** In-process navigator.locks: one exclusive holder per name, FIFO. */
export function fakeLocks() {
  const held = new Set<string>();
  const queues = new Map<string, (() => void)[]>();
  const requests: string[] = [];
  const release = (name: string) => {
    held.delete(name);
    queues.get(name)?.shift()?.();
  };
  const locks = {
    requests,
    isHeld: (name: string) => held.has(name),
    request(name: string, opts: { mode: string; ifAvailable?: boolean; signal?: AbortSignal }, cb: Cb) {
      requests.push(name);
      const run = async () => {
        held.add(name);
        try {
          return await cb({ name });
        } finally {
          release(name);
        }
      };
      if (!held.has(name) && !(queues.get(name)?.length ?? 0)) return run();
      if (opts.ifAvailable) return cb(null);
      return new Promise((resolve, reject) => {
        const q = queues.get(name) ?? [];
        queues.set(name, q);
        const go = () => void run().then(resolve, reject);
        q.push(go);
        opts.signal?.addEventListener("abort", () => {
          const i = q.indexOf(go);
          if (i >= 0) {
            q.splice(i, 1);
            reject(new DOMException("aborted", "AbortError"));
          }
        });
      });
    },
  };
  return locks;
}

/** Installs fakeLocks() as navigator.locks. */
export function useFakeLocks() {
  const locks = fakeLocks();
  vi.stubGlobal("navigator", { locks });
  return locks;
}

/** Adds a record spending `inputs` (default "accepted": reserves the coins
 *  without holding new broadcasts). */
export function addRecord(
  txid: string,
  inputs: readonly { txid: string; vout: number }[],
  over: Partial<BroadcastRecord> = {},
): void {
  seedRecords([...storedRecords(), rec({ txid, inputs: inputs.map(outpointKey), state: "accepted", ...over })]);
}
