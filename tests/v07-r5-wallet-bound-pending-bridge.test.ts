// R5 L-e — vault pending-tx writes and bridge crossings are wallet-bound,
// like vaults and deposit pins (v07-r4-wallet-bound-writes): the write and a
// check of the stored keystore against the session's wallet share one
// read-write transaction, so a tab still unlocked on a wallet another tab
// wiped or replaced never lands a draft / signature / broadcast state or a
// crossing under the next wallet (E_WALLET_WIPED / E_WALLET_CHANGED).
//
// Before: savePendingTx / persistComposedAsPending / signPendingTx /
// broadcastPendingTx and Bridge's onStarted + adoption tick used a plain
// put, which queued behind the other tab's wipe transaction and landed
// after it.
//
// Same fake IndexedDB and two-tab model as v07-r4-wallet-bound-writes.
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { masterFromSeed, pearlMultisigPath } from "../src/crypto/hd";
import { bytesToHex } from "../src/crypto/descriptor";
import type { KeystoreBlobJSON, KeystoreRecord, VaultRecord, VaultPendingTxRecord, BridgeCrossingRecord } from "../src/storage/db";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { vaultDescriptorFromPubkeys } from "../src/chains/pearl/multisig";
import { pearlParams } from "../src/chains/pearl/network";
import { hexToBytes } from "../src/crypto/descriptor";

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
const defaultReply: Reply = async (cmd, args) => {
  if (cmd === "exportMnemonic") return { mnemonic: "m" };
  if (cmd === "derivePearlMultisigPubkey") return { pubkeyHex: MY, originPath: pearlMultisigPath(0, 0) };
  if (cmd === "lock") return {};
  // Stand-in signer: returns the PSBT as is (no key material involved).
  if (cmd === "signPearlMultisigPsbt") return { psbtBase64: (args.req as { psbtBase64: string }).psbtBase64 };
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
// A 1-of-2 vault of "this wallet" and an unsigned PSBT paying 90,000 grains
// back to it (fee 10,000): enough for inspectPsbt / assertPsbtMatchesPreview.
const VDESC = vaultDescriptorFromPubkeys(1, [hexToBytes(MY), hexToBytes(COSIGNER)], pearlParams("mainnet"));
const VAULT: VaultRecord = {
  id: "vault-1", version: 1, label: "v", threshold: 1, total: 2,
  sortedPubkeysHex: VDESC.sortedPubkeys.map(bytesToHex), myPubkeyHex: MY, myOriginPath: pearlMultisigPath(0, 0),
  myVaultAccount: 0, myKeyIndex: 0, pearlAddress: VDESC.address, network: "mainnet", createdAt: 1,
};
function vaultPsbt(): string {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: hexToBytes("aa".repeat(32)), index: 0, witnessUtxo: { script: VDESC.outputScript, amount: 100_000n } });
  tx.addOutput({ script: VDESC.outputScript, amount: 90_000n });
  return base64.encode(tx.toPSBT());
}
const PREVIEW: VaultPendingTxRecord["preview"] = { destination: VDESC.address, amountGrains: "90000", feeGrains: "10000", changeGrains: "0", inputCount: 1 };
const pendingRec = (id = "p-1"): VaultPendingTxRecord => ({
  id, vaultId: VAULT.id, psbtBase64: vaultPsbt(), signersHex: [], createdAt: 1, updatedAt: 1, status: "drafting", preview: PREVIEW,
});
const crossing = (id = "c".repeat(64), phase: BridgeCrossingRecord["phase"] = "confirming"): BridgeCrossingRecord => ({
  id, direction: "wrap", amountGrains: "1", netGrains: "1", createdAt: 1, phase, relayState: null,
  confirmations: 0, settledRef: null, approveTxHash: null, updatedAt: 1,
});

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

type MS = typeof import("../src/services/multisig");
const writers: Array<[string, (ms: MS) => Promise<unknown>]> = [
  ["savePendingTx", (ms) => ms.savePendingTx(pendingRec())],
  ["persistComposedAsPending", (ms) => ms.persistComposedAsPending({ vault: VAULT, psbtBase64: vaultPsbt(), preview: PREVIEW })],
  ["signPendingTx", (ms) => ms.signPendingTx({ vault: VAULT, pending: pendingRec() })],
];

describe("L-e — vault pending-tx writes are bound to the session's wallet", () => {
  it.each(writers)("%s while another tab's wipe transaction runs → E_WALLET_WIPED, nothing lands after the wipe", async (_name, write) => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    const B = await openTab();
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    B.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    const gate = deferred();
    holds.set("vaultPendingTxs.clear", gate.promise); // B's wipe transaction is open
    const wipe = B.store.getState().wipe("pw");
    await until("vaultPendingTxs.clear");
    const w = write(A.ms).then(() => "written", (e: Error) => e.message);
    await tick(30);
    gate.resolve();
    await wipe;
    expect(await w).toBe("E_WALLET_WIPED"); // pre-fix: "written" (landed after the wipe)
    expect(data.get("vaultPendingTxs")!.size).toBe(0);
  });

  it.each(writers)("%s with another wallet stored → E_WALLET_CHANGED, nothing written", async (_name, write) => {
    data.get("keystore")!.set("primary", record("wallet-Y", "y"));
    const A = await openTab();
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    await expect(write(A.ms)).rejects.toThrow("E_WALLET_CHANGED");
    expect(data.get("vaultPendingTxs")!.size).toBe(0);
  });

  it.each(writers)("%s from a locked tab → E_LOCKED, nothing signed or written", async (_name, write) => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const reply = vi.fn(defaultReply);
    const A = await openTab(reply);
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    await expect(write(A.ms)).rejects.toThrow("E_LOCKED");
    expect(reply).not.toHaveBeenCalled();
    expect(data.get("vaultPendingTxs")!.size).toBe(0);
  });

  it.each(writers)("%s uncontended: written, the keystore check and the put in ONE read-write transaction over [keystore, vaultPendingTxs]", async (_name, write) => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    await write(A.ms);
    expect(data.get("vaultPendingTxs")!.size).toBe(1);
    expect(txLog).toHaveLength(1);
    expect([...txLog[0]!.stores].sort()).toEqual(["keystore", "vaultPendingTxs"]);
  });

  it("broadcastPendingTx: a locked tab is refused E_LOCKED before anything is finalised or sent; both of its writes are wallet-bound", async () => {
    const A = await openTab();
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    await expect(A.ms.broadcastPendingTx({ vault: VAULT, pending: { ...pendingRec(), status: "ready" } })).rejects.toThrow("E_LOCKED");
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/services/multisig.ts", "utf8");
    const body = src.slice(src.indexOf("export async function broadcastPendingTx("), src.indexOf("// Re-export the fee knobs"));
    expect(body.match(/await putPendingTxForWallet\((failed|broadcast), walletPrimary\);/g)).toHaveLength(2);
    expect(src).not.toMatch(/db\.vaultPendingTxs\.(put|add)\(/);
  });
});

describe("L-e — bridge crossings are bound to the session's wallet", () => {
  it("a crossing saved (onStarted) while another tab's wipe runs → E_WALLET_WIPED; the next wallet inherits no crossing", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    const B = await openTab();
    const { saveBridgeCrossing } = await import("../src/ui/pages/Bridge");
    // (Bridge.tsx imported last: it binds to tab B's module instances.)
    B.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    const gate = deferred();
    holds.set("vaultPendingTxs.clear", gate.promise);
    const wipe = A.store.getState().wipe("pw");
    await until("vaultPendingTxs.clear");
    const save = saveBridgeCrossing(crossing()).then(() => "saved", (e: Error) => e.message);
    await tick(30);
    gate.resolve();
    await wipe;
    expect(await save).toBe("E_WALLET_WIPED"); // pre-fix: "saved" (landed after the wipe)
    expect(data.get("bridgeCrossings")!.size).toBe(0);
  });

  it("another wallet stored → E_WALLET_CHANGED; locked → E_LOCKED; the same wallet → one [keystore, bridgeCrossings] transaction", async () => {
    const A = await openTab();
    const { saveBridgeCrossing } = await import("../src/ui/pages/Bridge");
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    data.get("keystore")!.set("primary", record("wallet-Y", "y"));
    await expect(saveBridgeCrossing(crossing())).rejects.toThrow("E_WALLET_CHANGED");
    expect(data.get("bridgeCrossings")!.size).toBe(0);
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    txLog.length = 0;
    expect(await saveBridgeCrossing(crossing())).toBe(true);
    expect(data.get("bridgeCrossings")!.size).toBe(1);
    expect(txLog).toHaveLength(1);
    expect([...txLog[0]!.stores].sort()).toEqual(["bridgeCrossings", "keystore"]);
    A.store.setState({ status: "locked", blob: blob("wallet-W"), addresses: null });
    await expect(saveBridgeCrossing(crossing("d".repeat(64)))).rejects.toThrow("E_LOCKED");
  });

  it("adoption (ifAbsent): never overwrites a row another tab saved; the check and the write share the transaction", async () => {
    data.get("keystore")!.set("primary", record("wallet-W", "w"));
    const A = await openTab();
    const { saveBridgeCrossing } = await import("../src/ui/pages/Bridge");
    A.store.setState({ status: "unlocked", blob: blob("wallet-W"), addresses: addrs("w") });
    data.get("bridgeCrossings")!.set("c".repeat(64), crossing("c".repeat(64), "done"));
    txLog.length = 0;
    expect(await saveBridgeCrossing(crossing(), { ifAbsent: true })).toBe(false);
    expect((data.get("bridgeCrossings")!.get("c".repeat(64)) as BridgeCrossingRecord).phase).toBe("done");
    expect(await saveBridgeCrossing(crossing("e".repeat(64)), { ifAbsent: true })).toBe(true);
    expect(txLog.map((t) => [...t.stores].sort())).toEqual([["bridgeCrossings", "keystore"], ["bridgeCrossings", "keystore"]]);
  });

  it("Bridge.tsx: onStarted (wrap and unwrap) and the adoption tick go through saveBridgeCrossing; no plain crossing put is left", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/ui/pages/Bridge.tsx", "utf8");
    expect(src.match(/onStarted=\{async \(rec\) => \{\n\s+await saveBridgeCrossing\(rec\);/g)).toHaveLength(2);
    expect(src).toMatch(/\}, \{ ifAbsent: true \}\);/);
    expect(src).not.toMatch(/db\.bridgeCrossings\.(put|add)\(/);
  });
});
