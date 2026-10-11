// R2 FY2 / FY3 — cross-tab keystore races, exercised through the REAL
// storage writers (src/storage/db.ts) and the REAL wallet store, with two
// independent module instances standing in for two tabs.
//
// Fake IndexedDB: one shared in-memory "primary" row. Each tab's Dexie
// instance gets its `transaction` replaced by a serial queue (IndexedDB
// read-write transactions on one store never interleave) and its keystore
// table's get / put / add / delete backed by the shared row. Only the
// crypto worker is mocked; its replies can be held to interleave tabs.
//
// FY2 (GPT-6 R1-A1 part 2, Sonnet F13): two tabs with no wallet both pass
//   the existence check, then both write; pre-fix the second silently
//   replaced the first wallet's ciphertext.
// FY3 (GPT-6 R1-A4): an unlock that started with 20 addresses wrote them
//   over the 40 another tab had discovered and saved meanwhile; and a
//   refused address write during a concurrent unlock of the SAME wallet was
//   reported as E_WALLET_CHANGED.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeystoreBlobJSON, KeystoreRecord } from "../src/storage/db";

const row: { rec: KeystoreRecord | undefined } = { rec: undefined };
let txQueue: Promise<unknown> = Promise.resolve();
/** One-shot: runs as the next transaction starts (another tab's write that
 *  commits just before it). */
let beforeNextTx: (() => void) | null = null;

function installFakeIdb(db: { transaction: unknown; keystore: unknown }) {
  vi.spyOn(db as never, "transaction" as never).mockImplementation(((...args: unknown[]) => {
    const fn = args[args.length - 1] as () => Promise<unknown>;
    const run = txQueue.then(() => {
      const hook = beforeNextTx;
      beforeNextTx = null;
      hook?.();
      return fn();
    });
    txQueue = run.catch(() => undefined);
    return run;
  }) as never);
  const ks = db.keystore as Record<string, unknown>;
  vi.spyOn(ks as never, "get" as never).mockImplementation((async () => (row.rec ? structuredClone(row.rec) : undefined)) as never);
  vi.spyOn(ks as never, "put" as never).mockImplementation((async (r: KeystoreRecord) => {
    row.rec = structuredClone(r);
    return "primary";
  }) as never);
  vi.spyOn(ks as never, "add" as never).mockImplementation((async (r: KeystoreRecord) => {
    if (row.rec) throw Object.assign(new Error("Key already exists in the object store."), { name: "ConstraintError" });
    row.rec = structuredClone(r);
    return "primary";
  }) as never);
  vi.spyOn(ks as never, "delete" as never).mockImplementation((async () => {
    row.rec = undefined;
  }) as never);
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Reply = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** A fresh module graph = a separate tab (own store, own worker client). */
async function openTab(reply: Reply) {
  vi.resetModules();
  const dbm = await import("../src/storage/db");
  installFakeIdb(dbm.db as never);
  const wc = await import("../src/crypto/worker-client");
  vi.spyOn(wc.cryptoWorker, "reset").mockImplementation(() => undefined);
  vi.spyOn(wc.cryptoWorker, "call").mockImplementation(((cmd: string, args: Record<string, unknown>) => reply(cmd, args)) as never);
  const ws = await import("../src/state/wallet-store");
  return { store: ws.useWallet, ws, worker: wc.cryptoWorker };
}

const blob = (c: string): KeystoreBlobJSON => ({
  version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: c,
});
const list = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}-${i}`);
const addrs = (p: string, n = 20) => ({ pearl: `${p}-ext-0`, pearlPool: list(`${p}-ext`, n), pearlChange: list(`${p}-int`, n), eth: "0x1111111111111111111111111111111111111111" });

const tabs: Array<{ ws: { __resetWalletStoreForTests(): void } }> = [];
beforeEach(() => {
  row.rec = undefined;
  txQueue = Promise.resolve();
  beforeNextTx = null;
});
afterEach(() => {
  for (const t of tabs.splice(0)) t.ws.__resetWalletStoreForTests();
  vi.restoreAllMocks();
});

describe("FY2 — concurrent create/restore into an empty keystore", () => {
  it("interleaved restores: the first wins, the second refuses with E_WALLET_EXISTS and leaves the first intact", async () => {
    const holdA = deferred();
    const holdB = deferred();
    const A = await openTab(async (cmd) => {
      if (cmd !== "restoreWallet") throw new Error(`unexpected ${cmd}`);
      await holdA.promise;
      return { mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") };
    });
    const B = await openTab(async (cmd) => {
      if (cmd !== "restoreWallet") throw new Error(`unexpected ${cmd}`);
      await holdB.promise;
      return { mnemonic: "m", blob: blob("wallet-B"), addresses: addrs("b") };
    });
    tabs.push(A, B);
    A.store.setState({ status: "no-wallet", blob: null, addresses: null });
    B.store.setState({ status: "no-wallet", blob: null, addresses: null });

    // Both pass the existence check (nothing stored), then wait on the worker.
    const pA = A.store.getState().restoreWallet("words", "pw-a");
    const pB = B.store.getState().restoreWallet("words", "pw-b");
    const settledB = pB.then(() => "ok", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    holdA.resolve();
    await pA;
    expect(row.rec!.blob).toEqual(blob("wallet-A"));
    holdB.resolve();
    const outcomeB = await settledB;

    expect(outcomeB).toBe(B.ws.E_WALLET_EXISTS_ELSEWHERE);
    expect(outcomeB.startsWith("E_WALLET_EXISTS")).toBe(true);
    // First wallet's ciphertext and lists are intact.
    expect(row.rec!.blob).toEqual(blob("wallet-A"));
    expect(row.rec!.publicData.pearlAddress).toBe("a-ext-0");
    expect(A.store.getState().status).toBe("unlocked");
    // The refused tab discarded its unsaved worker session and did not
    // claim to hold a wallet.
    expect(B.worker.reset).toHaveBeenCalled();
    expect(B.store.getState().status).toBe("no-wallet");
    expect(B.store.getState().blob).toBeNull();
  });

  it("interleaved create vs restore: same rule (createWallet is guarded too)", async () => {
    const holdB = deferred();
    const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-A"), addresses: addrs("a") }));
    const B = await openTab(async () => {
      await holdB.promise;
      return { mnemonic: "m", blob: blob("wallet-B"), addresses: addrs("b") };
    });
    tabs.push(A, B);
    A.store.setState({ status: "no-wallet", blob: null, addresses: null });
    B.store.setState({ status: "no-wallet", blob: null, addresses: null });
    const pB = B.store.getState().createWallet(128, "pw-b").then(() => "ok", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    await A.store.getState().restoreWallet("words", "pw-a");
    holdB.resolve();
    expect(await pB).toMatch(/^E_WALLET_EXISTS/);
    expect(row.rec!.blob).toEqual(blob("wallet-A"));
  });

  it("explicit overwrite (allowOverwrite) still replaces the stored wallet", async () => {
    const A = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-new"), addresses: addrs("n") }));
    tabs.push(A);
    row.rec = {
      id: "primary", version: 1, blob: blob("wallet-old"),
      publicData: { pearlAddress: "o-ext-0", pearlAddressPool: list("o-ext", 20), pearlChangePool: list("o-int", 20), ethAddress: "0x2222222222222222222222222222222222222222", pearlNetwork: "mainnet", ethNetwork: "mainnet", createdAt: 1 },
    };
    A.store.setState({ status: "locked", blob: blob("wallet-old"), addresses: null });
    await expect(A.store.getState().restoreWallet("words", "pw")).rejects.toThrow("E_WALLET_EXISTS");
    expect(row.rec!.blob).toEqual(blob("wallet-old"));
    await A.store.getState().restoreWallet("words", "pw", { allowOverwrite: true });
    expect(row.rec!.blob).toEqual(blob("wallet-new"));
  });
});

function storedWallet(n: number, primary = "w-ext-0", withChange = true): KeystoreRecord {
  return {
    id: "primary", version: 1, blob: blob("wallet-W"),
    publicData: {
      pearlAddress: primary,
      pearlAddressPool: list("w-ext", n),
      ...(withChange ? { pearlChangePool: list("w-int", n) } : {}),
      ethAddress: "0x1111111111111111111111111111111111111111", pearlNetwork: "mainnet", ethNetwork: "mainnet", createdAt: 1,
    },
  } as KeystoreRecord;
}

describe("FY3 — unlock never shrinks a longer pool another tab saved", () => {
  it("tab A unlock begins with 20, tab B extends to 40 and persists, A resumes: stored stays 40", async () => {
    row.rec = storedWallet(20);
    const holdA = deferred();
    let countsSeenByA: unknown;
    const A = await openTab(async (cmd, args) => {
      if (cmd !== "unlock") throw new Error(`unexpected ${cmd}`);
      countsSeenByA = args.counts;
      await holdA.promise;
      // Derived from the counts captured at the start: 20 + 20.
      return { addresses: addrs("w", 20) };
    });
    const B = await openTab(async () => {
      throw new Error("B makes no worker call");
    });
    tabs.push(A, B);
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    B.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w", 20) });

    const pA = A.store.getState().unlock("pw");
    await new Promise((r) => setTimeout(r, 10));
    expect(countsSeenByA).toEqual({ external: 20, internal: 20 });
    // Tab B: discovery extends both branches to 40 and persists.
    const ok = await B.store.getState().extendPearlAddresses({ external: list("w-ext", 40), internal: list("w-int", 40) });
    expect(ok).toBe(true);
    expect(row.rec!.publicData.pearlAddressPool).toHaveLength(40);
    // A derived 20/20, both now prefixes of the stored 40/40.
    holdA.resolve();
    await pA;
    expect(A.store.getState().status).toBe("unlocked");
    expect(row.rec!.publicData.pearlAddressPool).toEqual(list("w-ext", 40));
    expect(row.rec!.publicData.pearlChangePool).toEqual(list("w-int", 40));
    expect(row.rec!.blob).toEqual(blob("wallet-W"));
  });

  it("only resetPearlAddresses shortens the stored lists", async () => {
    row.rec = storedWallet(40);
    const A = await openTab(async () => {
      throw new Error("no worker call");
    });
    tabs.push(A);
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w", 40) });
    expect(await A.store.getState().resetPearlAddresses()).toBe(true);
    expect(row.rec!.publicData.pearlAddressPool).toEqual(list("w-ext", 20));
    expect(row.rec!.publicData.pearlChangePool).toEqual(list("w-int", 20));
  });

  it("a stale extension (30) after another tab saved 40 keeps the 40", async () => {
    row.rec = storedWallet(40);
    const A = await openTab(async () => {
      throw new Error("no worker call");
    });
    tabs.push(A);
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w", 20) });
    expect(await A.store.getState().extendPearlAddresses({ external: list("w-ext", 30), internal: list("w-int", 30) })).toBe(true);
    expect(row.rec!.publicData.pearlAddressPool).toEqual(list("w-ext", 40));
    expect(row.rec!.publicData.pearlChangePool).toEqual(list("w-int", 40));
  });

  it("a refused write during a concurrent unlock of the SAME wallet (same blob) is merged, not E_WALLET_CHANGED", async () => {
    // A record from an older build: a different stored primary and no
    // change pool, so every unlock migrates it. Tab B's unlock of the same
    // wallet commits its migration just before tab A's address write
    // (after A read the record), so A's compare on the primary it read
    // fails although the stored blob is still the one A decrypted.
    row.rec = storedWallet(20, "legacy-primary", false);
    const A = await openTab(async (cmd) => {
      if (cmd !== "unlock") throw new Error(`unexpected ${cmd}`);
      return { addresses: addrs("w", 20) };
    });
    tabs.push(A);
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    beforeNextTx = () => {
      // What tab B's unlock writes (same wallet, same blob).
      row.rec = storedWallet(20);
    };
    const outcome = await A.store.getState().unlock("pw").then(() => "ok", (e: Error) => e.message);
    expect(beforeNextTx).toBeNull(); // the other tab's write did land first
    expect(outcome).toBe("ok");
    expect(A.store.getState().status).toBe("unlocked");
    expect(A.worker.reset).not.toHaveBeenCalled();
    expect(row.rec!.blob).toEqual(blob("wallet-W"));
    expect(row.rec!.publicData.pearlAddress).toBe("w-ext-0");
    expect(row.rec!.publicData.pearlAddressPool).toEqual(list("w-ext", 20));
    expect(row.rec!.publicData.pearlChangePool).toEqual(list("w-int", 20));
  });

  it("a different wallet stored meanwhile is still refused (E_WALLET_CHANGED, nothing written)", async () => {
    row.rec = storedWallet(20);
    const holdA = deferred();
    const A = await openTab(async () => {
      await holdA.promise;
      return { addresses: addrs("w", 25) };
    });
    tabs.push(A);
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    const pA = A.store.getState().unlock("pw").then(() => "ok", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    const y = { ...storedWallet(20, "y-ext-0"), blob: blob("wallet-Y") };
    row.rec = structuredClone(y);
    holdA.resolve();
    expect(await pA).toBe("E_WALLET_CHANGED");
    expect(row.rec).toEqual(y);
  });
});
