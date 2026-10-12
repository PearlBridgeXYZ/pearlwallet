// A small in-memory IndexedDB (the subset state/eth-send-journal.ts uses):
// open + upgrade, one object store with out-of-line keys, transactions
// that run one at a time per database (in creation order, as IndexedDB
// runs overlapping read-write transactions), requests get / getAll /
// getAllKeys / put / delete on a working copy that becomes visible only
// when the transaction commits, abort on a failed request, and the
// transaction options recorded (durability). Shared by every module
// instance (tab) of a test, like the origin's real IndexedDB.

type Store = Map<string, unknown>;

interface Req<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

export interface FakeIdb {
  factory: IDBFactory;
  /** dbName -> storeName -> key -> value (committed state). */
  data: Map<string, Map<string, Store>>;
  /** Every transaction created, with its mode and options. */
  txLog: Array<{ db: string; stores: string[]; mode: string; options: unknown; committed: boolean }>;
  /** Puts / deletes fail (the transaction aborts). */
  failWrites: boolean;
  /** Reads fail. */
  failReads: boolean;
  /** open() fails. */
  failOpen: boolean;
  /** Awaited before each read-write commit (hold a commit open). */
  beforeCommit: (() => Promise<void>) | null;
  /** The committed entries of one store (empty map when absent). */
  entries(db: string, store: string): Store;
}

const later = (fn: () => void) => setTimeout(fn, 0);

function req<T>(): Req<T> {
  return { result: undefined as T, error: null, onsuccess: null, onerror: null };
}

export function fakeIndexedDB(): FakeIdb {
  const data = new Map<string, Map<string, Store>>();
  const versions = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  const f: FakeIdb = {
    factory: null as unknown as IDBFactory,
    data,
    txLog: [],
    failWrites: false,
    failReads: false,
    failOpen: false,
    beforeCommit: null,
    entries(db, store) {
      return data.get(db)?.get(store) ?? new Map();
    },
  };

  function makeDb(name: string) {
    const stores = () => data.get(name)!;
    const dbObj = {
      name,
      onversionchange: null as null | (() => void),
      onclose: null as null | (() => void),
      objectStoreNames: { contains: (n: string) => stores().has(n) },
      createObjectStore(n: string) {
        stores().set(n, new Map());
        return {};
      },
      close() {},
      transaction(names: string | string[], mode: IDBTransactionMode = "readonly", options?: unknown) {
        const list = Array.isArray(names) ? names : [names];
        const log = { db: name, stores: list, mode, options, committed: false };
        f.txLog.push(log);
        const work = new Map<string, Store>(list.map((n) => [n, new Map(stores().get(n) ?? [])]));
        let done!: () => void;
        const finished = new Promise<void>((r) => (done = r));
        let pending = 0;
        let failed = false;
        let started = false;
        const ops: Array<() => void> = [];
        const tx = {
          error: null as unknown,
          oncomplete: null as null | (() => void),
          onerror: null as null | (() => void),
          onabort: null as null | (() => void),
          abort() {
            if (failed) return;
            failed = true;
            done();
            later(() => tx.onabort?.());
          },
          objectStore(n: string) {
            const s = work.get(n)!;
            const op = <T>(kind: "read" | "write", run: () => T): Req<T> => {
              const r = req<T>();
              pending++;
              ops.push(() => {
                later(() => {
                  pending--;
                  if (failed) return;
                  if ((kind === "write" && f.failWrites) || (kind === "read" && f.failReads)) {
                    const err = Object.assign(new Error(kind === "write" ? "QuotaExceededError" : "UnknownError"), { name: "UnknownError" });
                    r.error = err;
                    tx.error = err;
                    r.onerror?.();
                    tx.onerror?.();
                    tx.abort();
                    return;
                  }
                  r.result = run();
                  r.onsuccess?.();
                  maybeCommit();
                });
              });
              if (started) ops.shift()!();
              return r;
            };
            const sortedKeys = () => [...s.keys()].sort();
            return {
              get: (k: string) => op("read", () => structuredClone(s.get(String(k)))),
              getAll: () => op("read", () => sortedKeys().map((k) => structuredClone(s.get(k)))),
              getAllKeys: () => op("read", () => sortedKeys()),
              put: (v: unknown, k: string) => op("write", () => (s.set(String(k), structuredClone(v)), k)),
              delete: (k: string) => op("write", () => void s.delete(String(k))),
            };
          },
        };
        let committing = false;
        function maybeCommit() {
          later(() => {
            if (failed || committing || pending > 0) return;
            committing = true;
            void (async () => {
              if (mode === "readwrite" && f.beforeCommit) await f.beforeCommit();
              if (failed) return;
              for (const [n, m] of work) if (mode === "readwrite") stores().set(n, m);
              log.committed = true;
              tx.oncomplete?.();
              done();
            })();
          });
        }
        const prev = queues.get(name) ?? Promise.resolve();
        queues.set(name, prev.then(() => finished));
        void prev.then(() => {
          started = true;
          for (const run of ops.splice(0)) run();
          if (pending === 0) maybeCommit();
        });
        return tx;
      },
    };
    return dbObj;
  }

  f.factory = {
    open(name: string, version = 1) {
      const r = req<unknown>() as Req<unknown> & { onupgradeneeded: null | (() => void); onblocked: null | (() => void) };
      r.onupgradeneeded = null;
      r.onblocked = null;
      later(() => {
        if (f.failOpen) {
          r.error = new Error("InvalidStateError");
          r.onerror?.();
          return;
        }
        if (!data.has(name)) data.set(name, new Map());
        const dbObj = makeDb(name);
        r.result = dbObj;
        if ((versions.get(name) ?? 0) < version) {
          versions.set(name, version);
          r.onupgradeneeded?.();
        }
        r.onsuccess?.();
      });
      return r;
    },
  } as unknown as IDBFactory;
  return f;
}
