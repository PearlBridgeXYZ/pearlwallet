// Durable copy of the Ethereum send records (state/eth-unknown.ts) in
// IndexedDB.
//
// Why a second store: localStorage is the shared, synchronous view every
// tab reads, but browsers commit it to disk lazily (Chromium batches
// writes for seconds). If the browser process dies right after a signed
// tx was submitted, the record saved just before submission can be lost
// with it, and a relaunched wallet would see no block and sign a second
// payment. So the send path (services/eth-tx.ts) also writes the record
// here, in a read-write transaction opened with durability "strict"
// (committed to disk before `complete` fires, where the browser supports
// the hint), and awaits that commit before submitting; a failed write
// refuses the send. Readers take the union of both stores: a record
// unresolved in either one blocks.
//
// A separate small database ("pearl-wallet-eth-sends"), not a table of the
// wallet's Dexie database: no schema change to the keystore database, and
// these writes never queue behind (or block) the wallet's own
// transactions. One object store, out-of-line keys: each key is the
// record's localStorage key (ETH_UNKNOWN_KEY_PREFIX + network + address +
// hash) and each value the same JSON string, so both stores are read by
// the same validating code. The records are public chain data (address +
// tx hash); wipe removes them by the same rules as the localStorage copy.

/** IndexedDB database and object store of the durable copy. */
export const ETH_SEND_JOURNAL_DB = "pearl-wallet-eth-sends";
export const ETH_SEND_JOURNAL_STORE = "records";
const DB_VERSION = 1;

/** A write that has not committed by then is treated as failed (the send
 *  is refused). Mutable for tests only. */
export const ETH_SEND_JOURNAL_TIMEOUT = { ms: 15_000 };

export type JournalEntries = Map<string, string>;
/** A change to apply: a value to put, or null to delete the key. */
export type JournalChanges = Map<string, string | null>;

function factory(): IDBFactory | undefined {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}

/** False only where there is no IndexedDB at all (not a browser): then the
 *  localStorage copy (or its in-memory stand-in) is all there is. A browser
 *  whose IndexedDB exists but fails is NOT this case: its writes fail and
 *  the send is refused. */
export function ethSendJournalAvailable(): boolean {
  return factory() !== undefined;
}

let conn: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (conn) return conn;
  const f = factory();
  if (!f) return Promise.reject(new Error("E_NO_INDEXEDDB"));
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = f.open(ETH_SEND_JOURNAL_DB, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ETH_SEND_JOURNAL_STORE)) db.createObjectStore(ETH_SEND_JOURNAL_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading or deleting the database: let it, and open
      // again on the next call.
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        if (conn === p) conn = null;
      };
      db.onclose = () => {
        if (conn === p) conn = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("E_ETH_SEND_JOURNAL_OPEN"));
    // onblocked (an older connection has not closed yet): keep waiting; the
    // callers' timeout bounds it.
  });
  conn = p;
  p.catch(() => {
    if (conn === p) conn = null;
  });
  return p;
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`E_ETH_SEND_JOURNAL_TIMEOUT: ${what}`)), ETH_SEND_JOURNAL_TIMEOUT.ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Reads every key + value of `store` (one request each, in the same
 *  transaction), then calls `done` synchronously inside that transaction. */
function readAll(store: IDBObjectStore, done: (entries: JournalEntries) => void): void {
  const keysReq = store.getAllKeys();
  const valsReq = store.getAll();
  valsReq.onsuccess = () => {
    const keys = keysReq.result as IDBValidKey[];
    const vals = valsReq.result as unknown[];
    const out: JournalEntries = new Map();
    keys.forEach((k, i) => {
      // Anything that is not a string key + string value is kept as an
      // unreadable value under its key (the reader fails closed on it).
      out.set(String(k), typeof vals[i] === "string" ? (vals[i] as string) : "\u0000unreadable");
    });
    done(out);
  };
}

/** Every entry of the durable copy. Rejects if IndexedDB cannot be read. */
export async function readEthSendJournal(): Promise<JournalEntries> {
  const db = await withTimeout(open(), "open");
  return withTimeout(
    new Promise<JournalEntries>((resolve, reject) => {
      let result: JournalEntries = new Map();
      const tx = db.transaction(ETH_SEND_JOURNAL_STORE, "readonly");
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("E_ETH_SEND_JOURNAL_READ"));
      tx.onabort = () => reject(tx.error ?? new Error("E_ETH_SEND_JOURNAL_READ"));
      readAll(tx.objectStore(ETH_SEND_JOURNAL_STORE), (entries) => {
        result = entries;
      });
    }),
    "read",
  );
}

/**
 * One read-write transaction (durability "strict"): reads every entry,
 * asks `change` (synchronous, inside the transaction) what to put or
 * delete, applies it, and resolves once the transaction has COMMITTED,
 * with the entries as they now are. Rejects (nothing changed) if the
 * transaction fails, aborts or does not commit within the timeout.
 */
export async function mutateEthSendJournal(change: (entries: JournalEntries) => JournalChanges): Promise<JournalEntries> {
  const db = await withTimeout(open(), "open");
  return withTimeout(
    new Promise<JournalEntries>((resolve, reject) => {
      let after: JournalEntries = new Map();
      let tx: IDBTransaction;
      try {
        tx = db.transaction(ETH_SEND_JOURNAL_STORE, "readwrite", { durability: "strict" });
      } catch {
        // Engines that reject the options argument.
        tx = db.transaction(ETH_SEND_JOURNAL_STORE, "readwrite");
      }
      tx.oncomplete = () => resolve(after);
      tx.onerror = () => reject(tx.error ?? new Error("E_ETH_SEND_JOURNAL_WRITE"));
      tx.onabort = () => reject(tx.error ?? new Error("E_ETH_SEND_JOURNAL_WRITE"));
      const store = tx.objectStore(ETH_SEND_JOURNAL_STORE);
      readAll(store, (entries) => {
        let changes: JournalChanges;
        try {
          changes = change(entries);
        } catch (e) {
          try {
            tx.abort();
          } catch {
            /* ignore */
          }
          reject(e);
          return;
        }
        after = new Map(entries);
        for (const [k, v] of changes) {
          if (v === null) {
            store.delete(k);
            after.delete(k);
          } else {
            store.put(v, k);
            after.set(k, v);
          }
        }
      });
    }),
    "write",
  );
}

/** Tests only: forget the cached connection (a fresh "tab"). */
export function __resetEthSendJournalForTests(): void {
  conn = null;
}
