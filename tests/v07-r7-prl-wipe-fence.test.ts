// R7 P1 (GPT-6 R4-A1) — a wipe never deletes a Pearl broadcast record that
// a wallet restored meanwhile (or a still-running send) depends on.
//
// Before: after the wipe's IndexedDB transaction committed, scrubLocalStorage
// removed the whole "pearl-wallet-broadcasts-v1" key and wallet-store's
// wipe() removed it again (clearPendingSpends), unfenced and outside the
// broadcast lock. A tab suspended between the commit and that cleanup let
// another tab restore the wallet and record a status-unknown payment; the
// resumed cleanup erased it, and a payment with different coins went out:
// a possible second payment. The same unscoped clear ran on a wallet
// replacement (forgetReplacedWalletLocalData).
//
// Now one scoped clear (forgetSnapshotBroadcastRecords; R7: a createdAt
// fence, R8 Q1: a snapshot of the exact records taken before the keystore
// transaction) runs after the commit, under the broadcast lock: records
// saved after the wipe started are kept, and when a broadcast was running at
// that point every "unknown" record is kept too.
//
// Real signer (public "abandon … about" seed), real broadcast path and
// records; the node is a fetch mock, the wallet's Dexie tables are stubbed
// and navigator.locks is the in-process implementation of broadcast-env.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { masterFromSeed, pearlBranchPath, type HdBranch } from "../src/crypto/hd";
import { signPearlTxWithSeed, p2trScriptForInternalKey, type PearlTxRequest, type PearlUtxoSpec } from "../src/crypto/pearl-sign";
import { pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import * as workerClient from "../src/crypto/worker-client";
import { BroadcastStatusUnknownError, rawTxId } from "../src/services/pearl-rpc";
import { broadcastPearlPrecomposed, type ComposedPearlTx } from "../src/services/pearl-tx";
import {
  BROADCASTS_STORAGE_KEY,
  BroadcastRefusedError,
  broadcastRecords,
  clearPendingSpends,
  forgetSnapshotBroadcastRecords,
  snapshotBroadcastRecords,
  unresolvedBroadcasts,
} from "../src/services/pending-spends";
import { db, wipeKeystore } from "../src/storage/db";
import { useUI } from "../src/state/ui-store";
import { rec, seedRecords, storedRecords, useFakeLocks, useMemoryStorage } from "./helpers/broadcast-env";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const params = pearlParams("mainnet");
let seed: Uint8Array;
let master: HDKey;

beforeAll(async () => {
  seed = await bip39.mnemonicToSeed(MNEMONIC);
  master = masterFromSeed(seed);
});
beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
  useMemoryStorage();
});
afterEach(() => {
  clearPendingSpends();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const scriptOf = (branch: HdBranch, index: number) =>
  hex(p2trScriptForInternalKey(master.derive(pearlBranchPath(branch, index)).publicKey!.slice(1)));
const DEST = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/86'/808276'/0'/0/0");
  return pearlAddressFromInternalKey(k.publicKey!.slice(1), params);
})();
function spec(n: number): PearlUtxoSpec {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, valueGrains: "200000", scriptHex: scriptOf(0, 0), branch: 0, index: 0 };
}
/** A real signed payment of 100000 grains to DEST from one coin (txid n). */
function signedFixture(n: number) {
  const ins = [spec(n)];
  const req: PearlTxRequest = { utxos: ins, outputs: [{ address: DEST, amountGrains: "100000" }], network: "mainnet", maxFeeGrains: "100000" };
  const { raw } = signPearlTxWithSeed(seed, req);
  return { raw, ins, txid: rawTxId(raw)! };
}
function composedFrom(ins: PearlUtxoSpec[]): ComposedPearlTx {
  return {
    utxos: ins.map((u) => ({ ...u, valueGrains: BigInt(u.valueGrains), branch: u.branch as 0 | 1, index: u.index })),
    outputs: [{ address: DEST, amountGrains: 100_000n }],
    amountGrains: 100_000n,
    feeGrains: 100_000n,
    tipGrains: 0n,
    changeGrains: 0n,
    degraded: false,
    historyIncomplete: 0,
    spendableGrains: 200_000n,
    spendableUtxoCount: 1,
  };
}
function send(f: ReturnType<typeof signedFixture>) {
  vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: f.raw } as never);
  return broadcastPearlPrecomposed({ composed: composedFrom(f.ins), composedAt: Date.now() }, "mainnet", Date.now(), []);
}
type Handler = (method: string, params: unknown[]) => Response | Promise<Response>;
function stubRpc(handler: Handler) {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      if (body.method === "sendrawtransaction") sent.push(rawTxId(body.params[0] as string)!);
      return handler(body.method, body.params);
    }),
  );
  return sent;
}
const ok = (result: unknown) => new Response(JSON.stringify({ result, error: null }));
const NO_TX = () => new Response(JSON.stringify({ result: null, error: { code: -5, message: "No information available about transaction" } }));
/** The node took the tx, the reply was lost (truncated body). */
const LOST: Handler = (m) => (m === "sendrawtransaction" ? new Response('{"result":') : NO_TX());
const ACCEPT: Handler = (m, p) => (m === "sendrawtransaction" ? ok(rawTxId(p[0] as string)) : NO_TX());
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)));
  return { promise, resolve, reject };
}

/** The wallet's Dexie tables: the wipe transaction runs its body and
 *  commits; `afterCommit` (if given) suspends the wiping tab right after. */
function stubWipeTables(afterCommit?: Promise<void>) {
  const reached = { commit: false };
  vi.spyOn(db, "transaction").mockImplementation((async (...args: unknown[]) => {
    const out = await (args[args.length - 1] as () => Promise<unknown>)();
    reached.commit = true;
    if (afterCommit) await afterCommit;
    return out;
  }) as never);
  for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
    const tbl = db[t] as unknown as { clear?: () => Promise<void>; delete?: () => Promise<void> };
    if (tbl.clear) vi.spyOn(tbl, "clear").mockResolvedValue(undefined as never);
    if (tbl.delete) vi.spyOn(tbl, "delete").mockResolvedValue(undefined as never);
  }
  return reached;
}

describe("R7 P1 — the wipe's cleanup keeps Pearl broadcast records it doesn't own", () => {
  it("GPT-6's race: wipe suspended after commit, a restored wallet's payment ends status-unknown → it survives the cleanup; a different-coin payment is refused", async () => {
    useFakeLocks();
    const gate = deferred();
    const reached = stubWipeTables(gate.promise);
    const wipe = wipeKeystore();
    for (let i = 0; i < 100 && !reached.commit; i++) await tick(1);
    expect(reached.commit).toBe(true);
    await tick(5); // the restore in the other tab takes time; its send comes later

    const first = signedFixture(0x11);
    const sent = stubRpc(LOST);
    await expect(send(first)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(unresolvedBroadcasts().map((r) => r.txid)).toEqual([first.txid]);

    gate.resolve(); // the wiping tab resumes: its post-commit cleanup runs
    await expect(wipe).resolves.toBe("wiped");
    expect(unresolvedBroadcasts().map((r) => r.txid)).toEqual([first.txid]);

    stubRpc(ACCEPT);
    const second = signedFixture(0x22); // other coin, same payee and amount
    const err = await send(second).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BroadcastRefusedError);
    expect((err as BroadcastRefusedError).reason).toBe("unresolved");
    expect(sent).toEqual([first.txid]);
  });

  it("a send running when the cleanup starts keeps its record (saved before the wipe began) once it ends status-unknown; older accepted records still go", async () => {
    useFakeLocks();
    seedRecords([rec({ txid: "cd".repeat(32), inputs: [`${"33".repeat(32)}:0`], createdAt: Date.now() - 60_000, state: "accepted" })]);
    const answer = deferred<Response>();
    const f = signedFixture(0x44);
    stubRpc((m) => (m === "sendrawtransaction" ? answer.promise : NO_TX()));
    const sender = send(f).catch((e: unknown) => e);
    for (let i = 0; i < 100 && !broadcastRecords().some((r) => r.txid === f.txid); i++) await tick(1);
    expect(unresolvedBroadcasts().map((r) => r.txid)).toEqual([f.txid]);
    await tick(5);

    stubWipeTables();
    const wipe = wipeKeystore();
    await tick(10);
    // The cleanup waits for the running broadcast.
    expect(broadcastRecords()).toHaveLength(2);
    answer.resolve(new Response('{"result":')); // reply lost → status unknown
    expect(await sender).toBeInstanceOf(BroadcastStatusUnknownError);
    await expect(wipe).resolves.toBe("wiped");
    expect(storedRecords().map((r) => [r.txid, r.state])).toEqual([[f.txid, "unknown"]]);
  });

  // Updated (R8 Q1): the fence is the snapshot, not createdAt.
  it("forgets the snapshot's records, keeps later ones (no lock contention)", async () => {
    useFakeLocks();
    const fence = Date.now();
    seedRecords([
      rec({ txid: "a1".repeat(32), inputs: [`${"01".repeat(32)}:0`], createdAt: fence - 10, state: "unknown" }),
      rec({ txid: "a2".repeat(32), inputs: [`${"02".repeat(32)}:0`], createdAt: fence, state: "accepted" }),
    ]);
    const snap = snapshotBroadcastRecords();
    seedRecords([
      ...storedRecords(),
      rec({ txid: "a3".repeat(32), inputs: [`${"03".repeat(32)}:0`], createdAt: fence + 1, state: "unknown" }),
    ]);
    await expect(forgetSnapshotBroadcastRecords(snap)).resolves.toBe("cleared");
    expect(storedRecords().map((r) => r.txid)).toEqual(["a3".repeat(32)]);
    await expect(forgetSnapshotBroadcastRecords(snapshotBroadcastRecords())).resolves.toBe("cleared");
    expect(localStorage.getItem(BROADCASTS_STORAGE_KEY)).toBeNull();
  });

  it("a lock that is never granted removes nothing (fail closed)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const locks = useFakeLocks();
    const fence = Date.now();
    seedRecords([rec({ txid: "b1".repeat(32), inputs: [`${"04".repeat(32)}:0`], createdAt: fence - 10, state: "accepted" })]);
    const snap = snapshotBroadcastRecords();
    const held = deferred();
    void locks.request("pearl-wallet-broadcast", { mode: "exclusive" }, () => held.promise);
    const p = forgetSnapshotBroadcastRecords(snap);
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(p).resolves.toBe("kept");
    expect(storedRecords()).toHaveLength(1);
    held.resolve();
  });

  it("no unconditional whole-key clear remains in the wipe / replace paths", () => {
    const ws = readFileSync("src/state/wallet-store.ts", "utf8");
    const dbs = readFileSync("src/storage/db.ts", "utf8");
    expect(ws).not.toMatch(/clearPendingSpends\(/);
    expect(dbs).not.toMatch(/^\s*"pearl-wallet-broadcasts-v1",/m);
    expect(ws.match(/await forgetSnapshotBroadcastRecords\(snapshot\.prl\);/g)).toHaveLength(1);
    expect(dbs.match(/await forgetSnapshotBroadcastRecords\(prlSnapshot\);/g)).toHaveLength(1);
    // The unconditional reset is for tests only: no app code calls it.
    const callers = (readdirSync("src", { recursive: true }) as string[])
      .filter((p) => /\.tsx?$/.test(p) && p !== join("services", "pending-spends.ts"))
      .filter((p) => /clearPendingSpends\(/.test(readFileSync(join("src", p), "utf8")));
    expect(callers).toEqual([]);
  });
});
