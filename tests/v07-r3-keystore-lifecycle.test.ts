// R3 — keystore lifecycle races, through the REAL storage writers
// (src/storage/db.ts) and the REAL wallet store, two module instances
// standing in for two tabs.
//
// FZ2 (GPT-6 R2-A2): wipe deleted the keystore row in one transaction and
//   cleared vaults / pending txs / bridge records in later ones, so a wallet
//   restored in another tab in between lost the vault it saved meanwhile.
// FZ3 (Sol PW-R2-01): create / restore WITH overwrite consent blindly put
//   the new record, erasing a different wallet another tab installed while
//   this tab derived and encrypted.
// FZ4 (Sonnet S1): lock() racing the tail of unlock() ended "unlocked" with
//   no worker session; a wipe whose IndexedDB part failed after the worker
//   reset ended "unlocked" too.
//
// Fake IndexedDB: every object store is an in-memory Map shared by the
// tabs. Transactions run one at a time (overlapping read-write
// transactions never interleave); a table operation outside any
// transaction is its own single-operation transaction and queues the same
// way (as Dexie / IndexedDB do). AsyncLocalStorage tells the two apart.
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeystoreBlobJSON, KeystoreRecord } from "../src/storage/db";

const STORES = ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const;
type StoreName = (typeof STORES)[number];
const data = new Map<StoreName, Map<string, unknown>>();
const inTx = new AsyncLocalStorage<boolean>();
let queue: Promise<unknown> = Promise.resolve();
const txLog: Array<{ stores: string[] }> = [];
/** Pauses named table operations (before they run): tests interleave. */
const holds = new Map<string, Promise<void>>();
const reached = new Set<string>();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(() => inTx.run(true, fn));
  queue = run.catch(() => undefined);
  return run;
}
function op<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  // The pause happens where the caller issues the operation: inside a
  // transaction it keeps that transaction open; outside one it happens
  // before the operation's own transaction is queued (nothing held).
  const pause = async () => {
    reached.add(name);
    const h = holds.get(name);
    if (h) await h;
  };
  if (inTx.getStore()) return pause().then(fn);
  return pause().then(() => enqueue(async () => await fn()));
}

function installFakeIdb(db: Record<string, unknown>) {
  vi.spyOn(db as never, "transaction" as never).mockImplementation(((...args: unknown[]) => {
    const fn = args[args.length - 1] as () => Promise<unknown>;
    const tables = args.slice(1, -1).flat() as Array<{ name: string }>;
    txLog.push({ stores: tables.map((t) => t.name) });
    return enqueue(fn);
  }) as never);
  for (const s of STORES) {
    const t = db[s] as Record<string, unknown>;
    const m = () => data.get(s)!;
    const key = (r: Record<string, unknown>) => String(s === "keystore" ? r.id : s === "bridgeDepositPins" ? r.ethAddress : r.id);
    vi.spyOn(t as never, "get" as never).mockImplementation(((k: string) => op(`${s}.get`, () => structuredClone(m().get(k)))) as never);
    vi.spyOn(t as never, "put" as never).mockImplementation(((r: Record<string, unknown>) =>
      op(`${s}.put`, () => {
        m().set(key(r), structuredClone(r));
        return key(r);
      })) as never);
    vi.spyOn(t as never, "add" as never).mockImplementation(((r: Record<string, unknown>) =>
      op(`${s}.add`, () => {
        if (m().has(key(r))) throw Object.assign(new Error("Key already exists in the object store."), { name: "ConstraintError" });
        m().set(key(r), structuredClone(r));
        return key(r);
      })) as never);
    vi.spyOn(t as never, "delete" as never).mockImplementation(((k: string) => op(`${s}.delete`, () => void m().delete(k))) as never);
    vi.spyOn(t as never, "clear" as never).mockImplementation((() => op(`${s}.clear`, () => void m().clear())) as never);
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

type Reply = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
async function openTab(reply: Reply) {
  vi.resetModules();
  const dbm = await import("../src/storage/db");
  installFakeIdb(dbm.db as never);
  const wc = await import("../src/crypto/worker-client");
  const reset = vi.spyOn(wc.cryptoWorker, "reset").mockImplementation(() => undefined);
  vi.spyOn(wc.cryptoWorker, "call").mockImplementation(((cmd: string, args: Record<string, unknown>) => reply(cmd, args)) as never);
  const ws = await import("../src/state/wallet-store");
  const eu = await import("../src/state/eth-unknown");
  tabs.push(ws);
  return { store: ws.useWallet, ws, dbm, reset, eu };
}

const blob = (c: string): KeystoreBlobJSON => ({
  version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: c,
});
const list = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}-${i}`);
const addrs = (p: string, n = 20) => ({ pearl: `${p}-ext-0`, pearlPool: list(`${p}-ext`, n), pearlChange: list(`${p}-int`, n), eth: "0x1111111111111111111111111111111111111111" });
const record = (c: string, p: string): KeystoreRecord => ({
  id: "primary", version: 1, blob: blob(c),
  publicData: { pearlAddress: `${p}-ext-0`, pearlAddressPool: list(`${p}-ext`, 20), pearlChangePool: list(`${p}-int`, 20), ethAddress: "0x1111111111111111111111111111111111111111", pearlNetwork: "mainnet", ethNetwork: "mainnet", createdAt: 1 },
});
const vault = (id: string) => ({ id, version: 1, label: id, threshold: 1, total: 1, sortedPubkeysHex: ["aa"], myPubkeyHex: "aa", myOriginPath: "m", myVaultAccount: 0, myKeyIndex: 0, pearlAddress: "prl1pv", network: "mainnet", createdAt: 1 });
const stored = () => data.get("keystore")!.get("primary") as KeystoreRecord | undefined;

const tabs: Array<{ __resetWalletStoreForTests(): void }> = [];
beforeEach(() => {
  for (const s of STORES) data.set(s, new Map());
  queue = Promise.resolve();
  txLog.length = 0;
  holds.clear();
  reached.clear();
});
afterEach(() => {
  for (const t of tabs.splice(0)) t.__resetWalletStoreForTests();
  vi.restoreAllMocks();
});

// ── FZ2 ─────────────────────────────────────────────────────────────────

describe("FZ2 — wipe is one IndexedDB transaction", () => {
  it("GPT-6's interleaving: B restores + saves a vault while A's wipe is between the keystore delete and the clears → B's vault survives", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    data.get("vaults")!.set("old-vault", vault("old-vault"));
    const A = await openTab(async (cmd) => {
      if ((cmd === "exportMnemonic" || cmd === "verifyPassword")) return { mnemonic: "m" };
      throw new Error(`unexpected ${cmd}`);
    });
    const B = await openTab(async (cmd) => {
      if (cmd === "restoreWallet") return { mnemonic: "m", blob: blob("wallet-B"), addresses: addrs("b") };
      throw new Error(`unexpected ${cmd}`);
    });
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    B.store.setState({ status: "no-wallet", blob: null, addresses: null });

    // Pause A immediately before addressBook.clear() (after the keystore
    // delete), as GPT-6's harness did.
    const gate = deferred();
    holds.set("addressBook.clear", gate.promise);
    const pA = A.store.getState().wipe("pw");
    for (let i = 0; i < 50 && !reached.has("addressBook.clear"); i++) await tick(2);
    expect(reached.has("addressBook.clear")).toBe(true);

    // Tab B restores (no overwrite: the row looks empty) and saves a vault.
    const pB = B.store.getState().restoreWallet("words", "pw-b").then(() => B.dbm.db.vaults.put(vault("new-vault") as never));
    await tick(30);
    gate.resolve();
    await pA;
    await pB;

    expect(stored()?.blob).toEqual(blob("wallet-B"));
    expect(data.get("vaults")!.has("new-vault")).toBe(true); // pre-fix: false (cleared by A)
    expect(data.get("vaults")!.has("old-vault")).toBe(false);
    expect(A.store.getState().status).toBe("no-wallet");
    expect(B.store.getState().status).toBe("unlocked");
  });

  it("one read-write transaction over every store, compare included; a refused compare touches nothing", async () => {
    const dbm = await import("../src/storage/db");
    installFakeIdb(dbm.db as never);
    data.get("keystore")!.set("primary", record("wallet-Y", "y"));
    data.get("vaults")!.set("v", vault("v"));
    await expect(dbm.wipeKeystore(blob("wallet-W"))).resolves.toBe("changed");
    expect(stored()?.blob).toEqual(blob("wallet-Y"));
    expect(data.get("vaults")!.has("v")).toBe(true);
    await expect(dbm.wipeKeystore(blob("wallet-Y"))).resolves.toBe("wiped");
    expect(stored()).toBeUndefined();
    expect(data.get("vaults")!.size).toBe(0);
    expect(txLog).toHaveLength(2);
    for (const t of txLog) expect([...t.stores].sort()).toEqual([...STORES].sort());
  });

  it("the localStorage scrub runs only after the transaction commits", async () => {
    const ls = new Map<string, string>([["pearl-wallet-ui-v6", "{}"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k),
      key: (i: number) => [...ls.keys()][i] ?? null, get length() { return ls.size; },
    });
    const dbm = await import("../src/storage/db");
    installFakeIdb(dbm.db as never);
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const gate = deferred();
    holds.set("bridgeDepositPins.clear", gate.promise); // the last op of the transaction
    const p = dbm.wipeKeystore(blob("wallet-W"));
    for (let i = 0; i < 50 && !reached.has("bridgeDepositPins.clear"); i++) await tick(2);
    expect(ls.has("pearl-wallet-ui-v6")).toBe(true); // not before the commit
    gate.resolve();
    await expect(p).resolves.toBe("wiped");
    expect(ls.has("pearl-wallet-ui-v6")).toBe(false);
    vi.unstubAllGlobals();
  });
});

// ── FZ3 ─────────────────────────────────────────────────────────────────

describe("FZ3 — explicit overwrite is a compare-and-replace against the record the user confirmed over", () => {
  for (const kind of ["restoreWallet", "createWallet"] as const) {
    it(`${kind}: another tab replaces X with Y while A derives → A refuses E_WALLET_CHANGED, Y untouched`, async () => {
      data.get("keystore")!.set("primary", record("wallet-X", "x"));
      const hold = deferred();
      const A = await openTab(async (cmd) => {
        if (cmd !== kind) throw new Error(`unexpected ${cmd}`);
        await hold.promise;
        return { mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") };
      });
      A.store.setState({ status: "locked", blob: blob("wallet-X"), addresses: null });
      const p = kind === "restoreWallet"
        ? A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") })
        : A.store.getState().createWallet(128, "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") });
      const settled = p.then(() => "ok", (e: Error) => e.message);
      await tick();
      // Tab B installs wallet Y meanwhile.
      data.get("keystore")!.set("primary", record("wallet-Y", "y"));
      hold.resolve();
      expect(await settled).toBe("E_WALLET_CHANGED"); // pre-fix: "ok", Y erased
      expect(stored()?.blob).toEqual(blob("wallet-Y"));
      expect(stored()?.publicData.pearlAddress).toBe("y-ext-0");
      expect(A.reset).toHaveBeenCalled(); // the unsaved session is discarded
      expect(A.store.getState().status).not.toBe("unlocked");
    });
  }

  it("observed X, another tab wiped meanwhile → refused, nothing written", async () => {
    data.get("keystore")!.set("primary", record("wallet-X", "x"));
    const hold = deferred();
    const A = await openTab(async () => {
      await hold.promise;
      return { mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") };
    });
    A.store.setState({ status: "locked", blob: blob("wallet-X"), addresses: null });
    const settled = A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") }).then(() => "ok", (e: Error) => e.message);
    await tick();
    data.get("keystore")!.delete("primary");
    hold.resolve();
    expect(await settled).toBe("E_WALLET_CHANGED");
    expect(stored()).toBeUndefined();
  });

  it("observed absent (overwrite consent with nothing stored), another tab stores Y → refused", async () => {
    const hold = deferred();
    const A = await openTab(async () => {
      await hold.promise;
      return { mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") };
    });
    A.store.setState({ status: "no-wallet", blob: null, addresses: null });
    const settled = A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: null }).then(() => "ok", (e: Error) => e.message);
    await tick();
    data.get("keystore")!.set("primary", record("wallet-Y", "y"));
    hold.resolve();
    expect(await settled).toBe("E_WALLET_CHANGED");
    expect(stored()?.blob).toEqual(blob("wallet-Y"));
  });

  it("uncontended overwrite still replaces X (and the non-overwrite path still adds only if absent)", async () => {
    data.get("keystore")!.set("primary", record("wallet-X", "x"));
    const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") }));
    A.store.setState({ status: "locked", blob: blob("wallet-X"), addresses: null });
    const exists = await A.store.getState().restoreWallet("words", "pw").catch((e) => e);
    expect(exists).toBeInstanceOf(A.ws.WalletExistsError);
    expect(exists.message).toBe("E_WALLET_EXISTS");
    expect(exists.observedBlob).toEqual(blob("wallet-X"));
    await A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: exists.observedBlob });
    expect(stored()?.blob).toEqual(blob("wallet-A"));
    expect(A.store.getState().status).toBe("unlocked");
  });
});

describe("FZ3 (round 3) — a consented overwrite with a different wallet takes the replaced wallet's data with it", () => {
  // Before: replaceKeystoreIfUnchanged put only the keystore row, so the
  // replaced wallet's vaults stayed in db.vaults and listVaults() showed
  // them as the new wallet's "Your vaults" (Sol R2 orphans.mjs R-a).
  const seed = () => {
    data.get("keystore")!.set("primary", record("wallet-X", "x"));
    data.get("vaults")!.set("x-vault", vault("x-vault"));
    data.get("vaultPendingTxs")!.set("x-ptx", { id: "x-ptx", vaultId: "x-vault" });
    data.get("addressBook")!.set("1", { id: 1, label: "x-payee", address: "prl1px", chain: "pearl", createdAt: 1 });
    data.get("txCache")!.set("1", { id: 1, txHash: "aa" });
    data.get("bridgeCrossings")!.set("x-cross", { id: "x-cross" });
    data.get("bridgeDepositPins")!.set("0xpin", { ethAddress: "0xpin", pearlAddress: "prl1px", pinnedAt: 1 });
  };
  const associated = STORES.filter((s) => s !== "keystore");

  for (const kind of ["createWallet", "restoreWallet"] as const) {
    it(`${kind}: replacing X with Y clears X's vaults, pending txs, address book, tx cache and bridge records in the replace transaction`, async () => {
      seed();
      const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-Y"), addresses: addrs("y") }));
      A.store.setState({ status: "locked", blob: blob("wallet-X"), addresses: null });
      txLog.length = 0;
      if (kind === "createWallet") await A.store.getState().createWallet(128, "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") });
      else await A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") });
      expect(stored()?.blob).toEqual(blob("wallet-Y"));
      for (const s of associated) expect(data.get(s)!.size, s).toBe(0);
      // One read-write transaction: the compare, the put and the clears.
      expect(txLog).toHaveLength(1);
      expect([...txLog[0]!.stores].sort()).toEqual([...STORES].sort());
    });
  }

  it("listVaults() is empty for the new wallet (real multisig reader over the same store)", async () => {
    seed();
    const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-Y"), addresses: addrs("y") }));
    const ms = await import("../src/services/multisig");
    const dbm = await import("../src/storage/db");
    vi.spyOn(dbm.db.vaults as never, "toArray" as never).mockImplementation((async () => [...data.get("vaults")!.values()]) as never);
    expect(await ms.listVaults()).toHaveLength(1);
    await A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") });
    expect(await ms.listVaults()).toEqual([]);
  });

  it("restoring the SAME wallet over itself (e.g. a new password) keeps its vaults and records", async () => {
    seed();
    const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-X2"), addresses: addrs("x") }));
    await A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") });
    expect(stored()?.blob).toEqual(blob("wallet-X2"));
    for (const s of associated) expect(data.get(s)!.size, s).toBe(1);
  });

  it("a refused compare (another tab stored Z after the dialog opened over X) clears nothing", async () => {
    seed();
    data.get("keystore")!.set("primary", record("wallet-Z", "z"));
    expect(await dbmReplace(record("wallet-Y", "y"), blob("wallet-X"))).toBe(false);
    expect(stored()?.blob).toEqual(blob("wallet-Z"));
    for (const s of associated) expect(data.get(s)!.size, s).toBe(1);
  });

  it("the replaced wallet's localStorage records (ETH status-unknown, Pearl broadcasts) go only after the commit", async () => {
    const ls = new Map<string, string>([["pearl-wallet-ui-v6", "{}"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k),
      key: (i: number) => [...ls.keys()][i] ?? null, get length() { return ls.size; },
    });
    try {
      seed();
      const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-Y"), addresses: { ...addrs("y"), eth: "0x2222222222222222222222222222222222222222" } }));
      A.eu.recordEthUnknown({ network: "mainnet", from: "0x1111111111111111111111111111111111111111", hash: `0x${"ab".repeat(32)}`, what: "ETH transfer" });
      ls.set("pearl-wallet-broadcasts-v1", "[]");
      const gate = deferred();
      holds.set("bridgeDepositPins.clear", gate.promise); // the last op of the replace transaction
      const p = A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") });
      for (let i = 0; i < 50 && !reached.has("bridgeDepositPins.clear"); i++) await tick(2);
      expect(reached.has("bridgeDepositPins.clear")).toBe(true);
      const ethKeys = () => [...ls.keys()].filter((k) => k.startsWith("pearl-wallet-eth-unknown-v3:"));
      expect(ethKeys()).toHaveLength(1); // not before the commit
      expect(ls.has("pearl-wallet-broadcasts-v1")).toBe(true);
      gate.resolve();
      await p;
      expect(ethKeys()).toEqual([]);
      expect(ls.has("pearl-wallet-broadcasts-v1")).toBe(false);
      expect(A.eu.currentEthUnknown("mainnet", "0x1111111111111111111111111111111111111111")).toBeNull();
      expect(ls.has("pearl-wallet-ui-v6")).toBe(true); // settings are kept
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // R7 P1 (GPT-6 R4-A1): the cleanup is fenced at the replace start.
  it("another tab's status-unknown Pearl send saved while the replace runs survives its cleanup; the replaced wallet's older records go", async () => {
    const ls = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k),
      key: (i: number) => [...ls.keys()][i] ?? null, get length() { return ls.size; },
    });
    const r = (txid: string, coin: string, createdAt: number) => ({
      txid, inputs: [`${coin}:0`], addresses: [], destination: null, amountGrains: "100000000", kind: "payment", createdAt, state: "unknown",
    });
    const OLD = "a1".repeat(32);
    const NEW = "b2".repeat(32);
    try {
      seed();
      ls.set("pearl-wallet-broadcasts-v1", JSON.stringify({ v: 1, records: [r(OLD, "11".repeat(32), Date.now() - 60_000)] }));
      const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-Y"), addresses: addrs("y") }));
      const gate = deferred();
      holds.set("bridgeDepositPins.clear", gate.promise);
      const p = A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true, observedBlob: blob("wallet-X") });
      for (let i = 0; i < 50 && !reached.has("bridgeDepositPins.clear"); i++) await tick(2);
      expect(reached.has("bridgeDepositPins.clear")).toBe(true);
      await tick(5);
      // Tab B (the new wallet) records a payment whose fate is unknown.
      const cur = JSON.parse(ls.get("pearl-wallet-broadcasts-v1")!) as { v: 1; records: unknown[] };
      ls.set("pearl-wallet-broadcasts-v1", JSON.stringify({ v: 1, records: [...cur.records, r(NEW, "22".repeat(32), Date.now())] }));
      gate.resolve();
      await p;
      const left = (JSON.parse(ls.get("pearl-wallet-broadcasts-v1") ?? '{"records":[]}') as { records: Array<{ txid: string }> }).records;
      expect(left.map((x) => x.txid)).toEqual([NEW]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function dbmReplace(r: KeystoreRecord, observed: KeystoreBlobJSON | null) {
  const dbm = await import("../src/storage/db");
  installFakeIdb(dbm.db as never);
  return dbm.replaceKeystoreIfUnchanged(r, observed);
}

describe("FZ3 (round 2) — consent is bound to the record the dialog was opened over, not one read after the click", () => {
  // As the onboarding pages do: the first submit's WalletExistsError
  // carries the stored blob the dialog is shown over; the click passes it
  // back. Before: the compare used a fresh read taken when the click's call
  // started, so a wallet Y installed while the dialog was open was erased.
  const variants = [
    ["another tab overwrite-restores Y", (Y: KeystoreRecord) => void data.get("keystore")!.set("primary", Y)],
    ["another tab wipes X, then restores Y", (Y: KeystoreRecord) => {
      data.get("keystore")!.delete("primary");
      data.get("keystore")!.set("primary", Y);
    }],
  ] as const;
  for (const kind of ["restoreWallet", "createWallet"] as const) {
    for (const [label, installY] of variants) {
      it(`${kind}: dialog open over X, ${label}, then Replace → E_WALLET_CHANGED, Y intact, nothing derived`, async () => {
        data.get("keystore")!.set("primary", record("wallet-X", "x"));
        const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") }));
        const call = (opts?: import("../src/state/wallet-store").OnboardOptions) =>
          kind === "restoreWallet" ? A.store.getState().restoreWallet("words", "pw", opts) : A.store.getState().createWallet(128, "pw", opts);
        const first = await call().catch((e) => e);
        expect(first).toBeInstanceOf(A.ws.WalletExistsError); // the dialog opens over X
        installY(record("wallet-Y", "y"));
        const click = await call({ allowOverwrite: true, observedBlob: first.observedBlob }).then(() => "ok", (e: Error) => e.message);
        expect(click).toBe("E_WALLET_CHANGED"); // before: "ok", Y erased
        expect(stored()?.blob).toEqual(blob("wallet-Y"));
        expect(A.store.getState().status).not.toBe("unlocked");
      });
    }
  }

  it("overwrite consent that names no observed record is refused (nothing derived or written)", async () => {
    data.get("keystore")!.set("primary", record("wallet-X", "x"));
    const worker = vi.fn(async () => ({ mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") }));
    const A = await openTab(worker);
    const err = await A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true } as never).catch((e) => e);
    expect(String(err.message)).toMatch(/^E_OVERWRITE_UNBOUND/);
    expect(worker).not.toHaveBeenCalled();
    expect(stored()?.blob).toEqual(blob("wallet-X"));
  });

  it("subscribeStoredWalletChange fires once when this tab's stored-wallet view changes (closes the dialog), not on other state", async () => {
    const A = await openTab(async () => ({}));
    A.store.setState({ status: "locked", blob: blob("wallet-X"), addresses: null });
    const fired = vi.fn();
    A.ws.subscribeStoredWalletChange(fired);
    A.store.setState({ lastActivity: 123 });
    expect(fired).not.toHaveBeenCalled();
    A.store.setState({ blob: blob("wallet-Y") }); // e.g. a blob-updated broadcast
    A.store.setState({ status: "no-wallet", blob: null });
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

// ── FZ4 ─────────────────────────────────────────────────────────────────

describe("FZ4 — lock generation; a failed wipe ends locked", () => {
  it("lock() during the tail of unlock() (after the worker unlocked): ends locked, worker reset, unlock refuses", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    // The address-list migration write is the tail of unlock: hold it.
    const A = await openTab(async (cmd) => {
      if (cmd === "unlock") return { addresses: addrs("w", 25) }; // longer list → migration write
      if (cmd === "lock") return {};
      throw new Error(`unexpected ${cmd}`);
    });
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    const gate = deferred();
    holds.set("keystore.put", gate.promise);
    const p = A.store.getState().unlock("pw").then(() => "ok", (e: Error) => e.message);
    for (let i = 0; i < 50 && !reached.has("keystore.put"); i++) await tick(2);
    expect(reached.has("keystore.put")).toBe(true);
    await A.store.getState().lock(); // auto-lock / Lock button
    const resetsAfterLock = A.reset.mock.calls.length;
    gate.resolve();
    expect(await p).toBe(A.ws.E_LOCKED_DURING_UNLOCK); // pre-fix: "ok"
    expect(A.store.getState().status).toBe("locked"); // pre-fix: "unlocked"
    expect(A.store.getState().addresses).toBeNull();
    expect(A.reset.mock.calls.length).toBeGreaterThan(resetsAfterLock); // the fresh session is discarded
  });

  it("an unlock with no lock in between still unlocks", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab(async () => ({ addresses: addrs("w", 25) }));
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    await A.store.getState().unlock("pw");
    expect(A.store.getState().status).toBe("unlocked");
  });

  it("wipe whose IndexedDB transaction fails after the worker reset ends 'locked', not 'unlocked' with no session", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab(async (cmd) => ((cmd === "exportMnemonic" || cmd === "verifyPassword") ? { mnemonic: "m" } : {}));
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    vi.spyOn(A.dbm.db as never, "transaction" as never).mockRejectedValue(new Error("IDB broken") as never);
    await expect(A.store.getState().wipe("pw")).rejects.toThrow("IDB broken");
    expect(A.reset).toHaveBeenCalled();
    expect(A.store.getState().status).toBe("locked"); // pre-fix: "unlocked"
    expect(A.store.getState().addresses).toBeNull();
    expect(stored()?.blob).toEqual(blob("wallet-W")); // nothing deleted
  });

  it("a successful wipe also forgets the ETH status-unknown records (FZ1 / Sonnet S2)", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab(async (cmd) => ((cmd === "exportMnemonic" || cmd === "verifyPassword") ? { mnemonic: "m" } : {}));
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    A.eu.recordEthUnknown({ network: "mainnet", from: "0x1111111111111111111111111111111111111111", hash: `0x${"ab".repeat(32)}`, what: "ETH transfer" });
    expect(A.eu.currentEthUnknown("mainnet", "0x1111111111111111111111111111111111111111")).not.toBeNull();
    await A.store.getState().wipe("pw");
    expect(A.eu.currentEthUnknown("mainnet", "0x1111111111111111111111111111111111111111")).toBeNull();
  });
});
