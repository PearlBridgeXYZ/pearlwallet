// R4 L2 / L3 — wallet-bound vault and deposit-pin writes; lock() racing a
// wipe. Through the REAL storage writers (src/storage/db.ts), the REAL
// wallet store, the REAL createVault and Bridge deposit TOFU store; two
// module instances stand in for two tabs.
//
// L2 (Sol r3 orphans.mjs R-b in Chromium): tab A, still unlocked on wallet
//   W, saved a vault (or a bridge deposit pin) while tab B's wipe
//   transaction ran. The plain put queued behind the wipe, landed after it
//   and then showed under the next wallet restored here.
// L3: lock() whose worker call settled after the wipe committed set
//   "locked" over "no-wallet": a dead-end Unlock page with no stored wallet.
//
// Fake IndexedDB as in v07-r3-keystore-lifecycle: every object store is an
// in-memory Map shared by the tabs; transactions run one at a time; a
// table operation outside any transaction is its own single-operation
// transaction and queues the same way (as IndexedDB does).
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { masterFromSeed, pearlMultisigPath } from "../src/crypto/hd";
import { bytesToHex } from "../src/crypto/descriptor";
import type { KeystoreBlobJSON, KeystoreRecord } from "../src/storage/db";

const STORES = ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const;
type StoreName = (typeof STORES)[number];
const data = new Map<StoreName, Map<string, unknown>>();
const inTx = new AsyncLocalStorage<boolean>();
let queue: Promise<unknown> = Promise.resolve();
const txLog: Array<{ stores: string[] }> = [];
const holds = new Map<string, Promise<void>>();
const reached = new Set<string>();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(() => inTx.run(true, fn));
  queue = run.catch(() => undefined);
  return run;
}
function op<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
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
    vi.spyOn(t as never, "toArray" as never).mockImplementation((() => op(`${s}.toArray`, () => structuredClone([...m().values()]))) as never);
    const key = (r: Record<string, unknown>) => String(s === "keystore" ? r.id : s === "bridgeDepositPins" ? r.ethAddress : r.id);
    vi.spyOn(t as never, "where" as never).mockImplementation(((field: string) => ({
      equals: (value: unknown) => ({ first: () => op(`${s}.where`, () => structuredClone(
        [...m().values()].find(r => (r as Record<string, unknown>)[field] === value)
      )) })
    })) as never);
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
async function until(name: string) {
  for (let i = 0; i < 100 && !reached.has(name); i++) await tick(2);
  expect(reached.has(name)).toBe(true);
}

// Public test mnemonic only: two multisig pubkeys of "this wallet".
const master = masterFromSeed(mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"));
const xonlyHex = (i: number) => bytesToHex(master.derive(pearlMultisigPath(0, i)).publicKey!.slice(1));
const MY = xonlyHex(0);
const COSIGNER = xonlyHex(1);

type Reply = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
const defaultReply: Reply = async (cmd) => {
  if ((cmd === "exportMnemonic" || cmd === "verifyPassword")) return { mnemonic: "m" };
  if (cmd === "derivePearlMultisigPubkey") return { pubkeyHex: MY, originPath: pearlMultisigPath(0, 0) };
  if (cmd === "lock") return {};
  throw new Error(`unexpected ${cmd}`);
};
const tabs: Array<{ __resetWalletStoreForTests(): void }> = [];
async function openTab(reply: Reply = defaultReply) {
  vi.resetModules();
  const dbm = await import("../src/storage/db");
  installFakeIdb(dbm.db as never);
  const wc = await import("../src/crypto/worker-client");
  vi.spyOn(wc.cryptoWorker, "reset").mockImplementation(() => undefined);
  vi.spyOn(wc.cryptoWorker, "call").mockImplementation(((cmd: string, args: Record<string, unknown>) => reply(cmd, args)) as never);
  const ws = await import("../src/state/wallet-store");
  const ms = await import("../src/services/multisig");
  tabs.push(ws);
  return { store: ws.useWallet, ws, dbm, ms };
}

const blob = (c: string): KeystoreBlobJSON => ({
  version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: c,
});
const list = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}-${i}`);
const addrs = (p: string) => ({ pearl: `${p}-ext-0`, pearlPool: list(`${p}-ext`, 20), pearlChange: list(`${p}-int`, 20), eth: "0x1111111111111111111111111111111111111111" });
const record = (c: string, p: string): KeystoreRecord => ({
  id: "primary", version: 1, blob: blob(c),
  publicData: { pearlAddress: `${p}-ext-0`, pearlAddressPool: list(`${p}-ext`, 20), pearlChangePool: list(`${p}-int`, 20), ethAddress: "0x1111111111111111111111111111111111111111", pearlNetwork: "mainnet", ethNetwork: "mainnet", createdAt: 1 },
});
const stored = () => data.get("keystore")!.get("primary") as KeystoreRecord | undefined;
const mkVault = (ms: typeof import("../src/services/multisig"), label: string) =>
  ms.createVault({ label, threshold: 1, cosignerPubkeysHex: [MY, COSIGNER], myPubkeyHex: MY, myVaultAccount: 0, myKeyIndex: 0, network: "mainnet" });

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

it("concurrent creates of the same policy reuse one vault atomically", async () => {
  data.get("keystore")!.set("primary", record("wallet-W", "w"));
  const A = await openTab(); const B = await openTab();
  A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
  B.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
  const [a,b] = await Promise.all([mkVault(A.ms,"first"),mkVault(B.ms,"second")]);
  expect(a.id).toBe(b.id); expect(data.get("vaults")!.size).toBe(1);
});

describe("L2 — a vault saved by a still-unlocked tab never lands after another tab's wipe", () => {
  it("R-b: A (unlocked on W) saves a vault while B's wipe transaction runs → refused E_WALLET_WIPED; nothing shows under the next wallet", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    const B = await openTab();
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    B.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    const gate = deferred();
    holds.set("vaultPendingTxs.clear", gate.promise); // B's wipe transaction is open
    const wipe = B.store.getState().wipe("pw");
    await until("vaultPendingTxs.clear");
    const save = mkVault(A.ms, "late-W-vault").then((v) => `saved ${v.label}`, (e: Error) => e.message);
    await tick(30);
    gate.resolve();
    await wipe;
    expect(await save).toBe("E_WALLET_WIPED"); // pre-fix: "saved late-W-vault"
    expect(data.get("vaults")!.size).toBe(0); // pre-fix: 1 (landed after the wipe)
    // B restores another wallet: no vault is listed as its own.
    const B2 = await openTab(async () => ({ mnemonic: "m", blob: blob("wallet-Y"), addresses: addrs("y") }));
    B2.store.setState({ status: "no-wallet", blob: null, addresses: null });
    await B2.store.getState().restoreWallet("words", "pw");
    expect(stored()?.publicData.pearlAddress).toBe("y-ext-0");
    vi.spyOn(B2.dbm.db.vaults as never, "toArray" as never).mockImplementation((async () => [...data.get("vaults")!.values()]) as never);
    expect(await B2.ms.listVaults()).toEqual([]);
  });

  it("another wallet stored meanwhile → refused E_WALLET_CHANGED, nothing written", async () => {
    data.get("keystore")!.set("primary", record("wallet-Y", "y"));
    const A = await openTab();
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    await expect(mkVault(A.ms, "W-vault")).rejects.toThrow("E_WALLET_CHANGED");
    expect(data.get("vaults")!.size).toBe(0);
  });

  it("locked tab: refused before anything is derived or written", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const reply = vi.fn(defaultReply);
    const A = await openTab(reply);
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    await expect(mkVault(A.ms, "v")).rejects.toThrow("E_LOCKED");
    expect(reply).not.toHaveBeenCalled();
    expect(data.get("vaults")!.size).toBe(0);
  });

  it("uncontended: the vault is saved, its keystore check and put in ONE read-write transaction over [keystore, vaults]", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    const v = await mkVault(A.ms, "W-vault");
    expect(data.get("vaults")!.get(v.id)).toMatchObject({ label: "W-vault", myPubkeyHex: MY });
    expect(txLog).toHaveLength(1);
    expect([...txLog[0]!.stores].sort()).toEqual(["keystore", "vaults"]);
  });
});

describe("L2 — the bridge deposit pin is bound to the session's wallet the same way", () => {
  const ETH = "0x1111111111111111111111111111111111111111";
  it("a first-use pin written while another tab's wipe runs is refused E_WALLET_WIPED; the next wallet inherits no pin", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    const B = await openTab();
    const { depositTofu } = await import("../src/ui/pages/Bridge");
    // (Bridge.tsx imported last: it binds to the latest module instances = tab B's.)
    B.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    const gate = deferred();
    holds.set("vaultPendingTxs.clear", gate.promise);
    const wipe = A.store.getState().wipe("pw");
    await until("vaultPendingTxs.clear");
    const pin = depositTofu.set(`pin:${ETH}`, "prl1pdeposit").then(() => "pinned", (e: Error) => e.message);
    await tick(30);
    gate.resolve();
    await wipe;
    expect(await pin).toBe("E_WALLET_WIPED"); // pre-fix: "pinned" (landed after the wipe)
    expect(data.get("bridgeDepositPins")!.size).toBe(0);
  });

  it("another wallet stored → E_WALLET_CHANGED; the same wallet → pinned in one [keystore, bridgeDepositPins] transaction", async () => {
    const A = await openTab();
    const { depositTofu } = await import("../src/ui/pages/Bridge");
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    data.get("keystore")!.set("primary", record("wallet-Y", "y"));
    await expect(depositTofu.set(`pin:${ETH}`, "prl1pdeposit")).rejects.toThrow("E_WALLET_CHANGED");
    expect(data.get("bridgeDepositPins")!.size).toBe(0);
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    txLog.length = 0;
    await depositTofu.set(`pin:${ETH}`, "prl1pdeposit");
    expect(await depositTofu.get(`pin:${ETH}`)).toBe("prl1pdeposit");
    expect([...txLog[0]!.stores].sort()).toEqual(["bridgeDepositPins", "keystore"]);
  });
});

describe("L3 — lock() racing a wipe ends 'no-wallet' once the wipe commits", () => {
  it("lock() called during the wipe's IndexedDB transaction, its worker call settling after the commit → 'no-wallet' (not a dead-end 'locked')", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const lockCall = deferred<unknown>();
    const A = await openTab(async (cmd) => {
      if ((cmd === "exportMnemonic" || cmd === "verifyPassword")) return { mnemonic: "m" };
      if (cmd === "lock") return lockCall.promise;
      throw new Error(`unexpected ${cmd}`);
    });
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    const gate = deferred();
    holds.set("bridgeCrossings.clear", gate.promise);
    const wipe = A.store.getState().wipe("pw");
    await until("bridgeCrossings.clear");
    const lock = A.store.getState().lock(); // auto-lock / Lock button mid-wipe
    gate.resolve();
    await wipe;
    expect(stored()).toBeUndefined();
    expect(A.store.getState().status).toBe("no-wallet");
    lockCall.resolve({});
    await lock;
    expect(A.store.getState().status).toBe("no-wallet"); // pre-fix: "locked" with nothing stored
    expect(A.store.getState().blob).toBeNull();
    expect(A.store.getState().addresses).toBeNull();
  });

  it("lock() that finishes inside the wipe's transaction also ends 'no-wallet'; a plain lock still locks", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    const gate = deferred();
    holds.set("bridgeCrossings.clear", gate.promise);
    const wipe = A.store.getState().wipe("pw");
    await until("bridgeCrossings.clear");
    await A.store.getState().lock();
    expect(A.store.getState().status).toBe("locked");
    gate.resolve();
    await wipe;
    expect(A.store.getState().status).toBe("no-wallet");

    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const B = await openTab();
    B.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    await B.store.getState().lock();
    expect(B.store.getState().status).toBe("locked");
  });
});

  it("wipe refuses an unacknowledged vault created during password verification", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const verification = deferred<unknown>();
    const A = await openTab(async (cmd, args) => {
      if (cmd === "verifyPassword") { reached.add("verify-started"); return verification.promise; }
      return defaultReply(cmd, args);
    });
    A.store.setState({ status:"unlocked",blob:blob("wallet-W"),addresses:addrs("w") });
    const shown = await A.ms.listVaults();
    const current = await A.ms.listVaults();
    expect(current.map(v=>v.id).sort().join()).toBe(shown.map(v=>v.id).sort().join());
    const wiping = A.store.getState().wipe("pw", shown.map(v=>v.id)).then(()=>"wiped",(e:Error)=>e.message);
    await until("verify-started");
    const B = await openTab();
    B.store.setState({ status:"unlocked",blob:blob("wallet-W"),addresses:addrs("w") });
    const unacknowledged = await mkVault(B.ms, "not-in-acknowledged-list");
    expect(data.get("vaults")!.has(unacknowledged.id)).toBe(true);
    verification.resolve({ok:true}); expect(await wiping).toBe("E_VAULT_LIST_CHANGED");
    expect(data.get("vaults")!.has(unacknowledged.id)).toBe(true);
    expect(stored()).toBeDefined();
  });

