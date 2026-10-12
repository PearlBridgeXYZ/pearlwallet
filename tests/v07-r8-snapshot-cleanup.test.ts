// R8 Q1 (GPT-5.6 G56-R5-01) — wipe / replace cleanup of unresolved-send
// records is scoped by a snapshot of the exact records, never by the wall
// clock.
//
// Before: wipeKeystore / the consented replace captured `startedAt =
// Date.now()` and, after the keystore transaction committed, removed every
// Pearl broadcast record with createdAt <= startedAt and every Ethereum send
// record (localStorage and its IndexedDB copy) with ts <= startedAt. A record
// written after the commit by a wallet restored in another tab, but with an
// equal timestamp (same millisecond) or an earlier one (the clock stepped
// back), was taken for one of the wiped wallet's and deleted: the only block
// against a second payment with different coins / the next nonce.
//
// Now the wipe / replace snapshots the exact records (PRL: per-record id +
// content; ETH: every key + value in localStorage and in the IndexedDB copy)
// before its keystore transaction and, after the commit, removes only those
// that are still unchanged. Timestamps play no part.
//
// Real signer (public "abandon … about" seed), real broadcast paths and
// records; the nodes are fetch mocks, the wallet's Dexie tables are stubbed,
// navigator.locks is broadcast-env's in-process implementation and
// IndexedDB is tests/helpers/fake-idb (the ETH part: tabs = module
// instances sharing them).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { keccak256, parseTransaction, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { masterFromSeed, pearlBranchPath, type HdBranch } from "../src/crypto/hd";
import { signPearlTxWithSeed, p2trScriptForInternalKey, type PearlTxRequest, type PearlUtxoSpec } from "../src/crypto/pearl-sign";
import { pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import * as workerClient from "../src/crypto/worker-client";
import { rawTxId } from "../src/services/pearl-rpc";
import { broadcastPearlPrecomposed, type ComposedPearlTx } from "../src/services/pearl-tx";
import {
  BroadcastRefusedError,
  clearPendingSpends,
  recordBroadcast,
  resolveBroadcasts,
  unresolvedBroadcasts,
  type BroadcastPlan,
} from "../src/services/pending-spends";
import { db, wipeKeystore } from "../src/storage/db";
import { useUI } from "../src/state/ui-store";
import { fakeLocks, memoryStorage, rec, seedRecords, storedRecords, useFakeLocks, useMemoryStorage, type MemoryStorage } from "./helpers/broadcast-env";
import { fakeIndexedDB, type FakeIdb } from "./helpers/fake-idb";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const realNow = Date.now.bind(Date);
/** While set, Date.now() returns it (the wall clock as the code sees it). */
let clock: number | null = null;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ─── Pearl ────────────────────────────────────────────────────────────────

const params = pearlParams("mainnet");
let seed: Uint8Array;
let master: HDKey;
beforeAll(async () => {
  seed = await bip39.mnemonicToSeed(MNEMONIC);
  master = masterFromSeed(seed);
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
function signedFixture(n: number) {
  const ins = [spec(n)];
  const req: PearlTxRequest = { utxos: ins, outputs: [{ address: DEST, amountGrains: "100000" }], network: "mainnet", maxFeeGrains: "100000" };
  const { raw } = signPearlTxWithSeed(seed, req);
  return { raw, ins, txid: rawTxId(raw)! };
}
const planOf = (f: ReturnType<typeof signedFixture>): BroadcastPlan => ({
  kind: "payment",
  inputs: f.ins.map((u) => ({ txid: u.txid, vout: u.vout })),
  destination: DEST,
  amountGrains: 100_000n,
});
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
function sendPrl(f: ReturnType<typeof signedFixture>) {
  vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: f.raw } as never);
  return broadcastPearlPrecomposed({ composed: composedFrom(f.ins), composedAt: Date.now() }, "mainnet", Date.now(), []);
}
/** A node that accepts everything; returns the txids submitted. */
function acceptingPearlNode() {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      if (body.method === "sendrawtransaction") {
        sent.push(rawTxId(body.params[0] as string)!);
        return new Response(JSON.stringify({ result: rawTxId(body.params[0] as string), error: null }));
      }
      return new Response(JSON.stringify({ result: null, error: { code: -5, message: "No information available about transaction" } }));
    }),
  );
  return sent;
}

/** The wallet's Dexie tables: the wipe transaction runs its body and
 *  commits; `afterCommit` runs right after (the wiping tab is suspended
 *  meanwhile; another tab acts). */
function stubWipeTables(afterCommit?: () => Promise<void> | void) {
  vi.spyOn(db, "transaction").mockImplementation((async (...args: unknown[]) => {
    const out = await (args[args.length - 1] as () => Promise<unknown>)();
    if (afterCommit) await afterCommit();
    return out;
  }) as never);
  vi.spyOn(db.keystore, "get").mockResolvedValue(undefined as never);
  for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
    const tbl = db[t] as unknown as { clear?: () => Promise<void>; delete?: () => Promise<void> };
    if (tbl.clear) vi.spyOn(tbl, "clear").mockResolvedValue(undefined as never);
    if (tbl.delete) vi.spyOn(tbl, "delete").mockResolvedValue(undefined as never);
  }
}

describe("R8 Q1 — Pearl: the wipe's cleanup removes only the records it snapshotted", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
    useMemoryStorage();
    useFakeLocks();
    clock = null;
    vi.spyOn(Date, "now").mockImplementation(() => clock ?? realNow());
  });
  afterEach(() => {
    clock = null;
    clearPendingSpends();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const [label, offset] of [
    ["the same millisecond as the wipe's start", 0],
    ["a wall clock stepped back 1 ms", -1],
    ["a wall clock stepped back an hour", -3_600_000],
  ] as const) {
    it(`a status-unknown record saved after the commit at ${label} survives and refuses a different-coin payment`, async () => {
      const T = realNow();
      const first = signedFixture(0x11);
      clock = T; // the wipe starts at T
      stubWipeTables(() => {
        // Another tab restored the wallet and recorded its payment before
        // submitting it (it then ended status-unknown: the record stays).
        clock = T + offset;
        expect(recordBroadcast(first.txid, planOf(first))).toBe(true);
        expect(storedRecords()[0].createdAt).toBe(T + offset);
        clock = null;
      });
      await expect(wipeKeystore()).resolves.toBe("wiped");
      expect(unresolvedBroadcasts().map((r) => r.txid)).toEqual([first.txid]);

      const sent = acceptingPearlNode();
      const err = await sendPrl(signedFixture(0x22)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BroadcastRefusedError);
      expect((err as BroadcastRefusedError).reason).toBe("unresolved");
      expect(sent).toEqual([]);
    });
  }

  it("the records stored when the wipe started still go (unknown, accepted, and one saved by an earlier build without an id)", async () => {
    const T = realNow();
    const legacy = rec({ txid: "c1".repeat(32), inputs: [`${"01".repeat(32)}:0`], createdAt: T + 10_000, state: "unknown" });
    expect(legacy).not.toHaveProperty("id");
    seedRecords([legacy, rec({ txid: "c2".repeat(32), inputs: [`${"02".repeat(32)}:0`], createdAt: T - 5, state: "accepted" })]);
    const own = signedFixture(0x33);
    clock = T + 20_000; // the wiped wallet's own record, from a clock running ahead
    // (The user accepted the earlier status-unknown one may pay twice.)
    expect(recordBroadcast(own.txid, { ...planOf(own), acknowledged: [legacy.txid] })).toBe(true);
    clock = T;
    const later = signedFixture(0x44);
    stubWipeTables(() => {
      clock = T - 1;
      expect(recordBroadcast(later.txid, { ...planOf(later), acknowledged: [legacy.txid, own.txid] })).toBe(true);
      clock = null;
    });
    await expect(wipeKeystore()).resolves.toBe("wiped");
    expect(storedRecords().map((r) => r.txid)).toEqual([later.txid]);
  });

  it("a snapshotted record rewritten after the snapshot (marked accepted) is kept", async () => {
    const T = realNow();
    const f = signedFixture(0x55);
    clock = T - 60_000;
    recordBroadcast(f.txid, planOf(f));
    clock = T;
    stubWipeTables(() => {
      clock = null;
      resolveBroadcasts([f.txid], "accepted");
    });
    await expect(wipeKeystore()).resolves.toBe("wiped");
    expect(storedRecords().map((r) => [r.txid, r.state])).toEqual([[f.txid, "accepted"]]);
  });

  it("every new record carries its own random id", () => {
    const a = signedFixture(0x66);
    const b = signedFixture(0x67);
    recordBroadcast(a.txid, planOf(a));
    resolveBroadcasts([a.txid], "accepted");
    recordBroadcast(b.txid, planOf(b));
    const ids = storedRecords().map((r) => r.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ─── Ethereum ─────────────────────────────────────────────────────────────

const account = mnemonicToAccount(MNEMONIC);
const ME = account.address;
const TO = "0x000000000000000000000000000000000000dEaD" as const;
const V3 = "pearl-wallet-eth-unknown-v3:";
const JOURNAL: [string, string] = ["pearl-wallet-eth-sends", "records"];
const g = globalThis as unknown as Record<string, unknown>;

interface RpcReq { id?: number; method: string; params?: unknown[] }
const okJson = (id: number | undefined, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, result }), { status: 200, headers: { "content-type": "application/json" } });
const z64 = "0x" + "0".repeat(64);
const block = {
  number: "0x100", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), baseFeePerGas: "0x3b9aca00",
  gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x6500000", transactions: [], difficulty: "0x0", extraData: "0x",
  logsBloom: "0x" + "0".repeat(512), miner: "0x" + "0".repeat(40), mixHash: z64, nonce: "0x0000000000000000",
  receiptsRoot: z64, sha3Uncles: z64, size: "0x1", stateRoot: z64, totalDifficulty: "0x0", transactionsRoot: z64, uncles: [],
};
function ethNode() {
  const accepted = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const req = (Array.isArray(body) ? body[0] : body) as RpcReq;
    switch (req.method) {
      case "eth_chainId": return okJson(req.id, "0x1");
      case "eth_getTransactionCount": return okJson(req.id, "0x" + (5 + accepted.size).toString(16));
      case "eth_estimateGas": return okJson(req.id, "0x5208");
      case "eth_getBlockByNumber": return okJson(req.id, block);
      case "eth_sendRawTransaction": {
        const raw = req.params?.[0] as Hex;
        const hash = keccak256(raw);
        if (!accepted.has(hash)) accepted.set(hash, parseTransaction(raw).nonce ?? -1);
        return okJson(req.id, hash);
      }
      default: return okJson(req.id, null);
    }
  }));
  return { accepted };
}

const KEYSTORE_BLOB = { version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: "w" };

let ls: MemoryStorage;
let idb: FakeIdb;
/** A fresh module graph = a tab. `afterCommit` runs right after the
 *  wallet's (stubbed) IndexedDB transaction commits. */
async function openTab(afterCommit?: () => Promise<void>) {
  vi.resetModules();
  const dbm = await import("../src/storage/db");
  const row: { rec: unknown } = {
    rec: {
      id: "primary", version: 1, blob: KEYSTORE_BLOB,
      publicData: { pearlAddress: "prl1pold", pearlAddressPool: ["prl1pold"], pearlChangePool: [], ethAddress: "0x" + "01".repeat(20), pearlNetwork: "mainnet", ethNetwork: "mainnet", createdAt: 0 },
    },
  };
  vi.spyOn(dbm.db, "transaction").mockImplementation((async (...args: unknown[]) => {
    const out = await (args[args.length - 1] as () => Promise<unknown>)();
    if (afterCommit) await afterCommit();
    return out;
  }) as never);
  vi.spyOn(dbm.db.keystore, "get").mockImplementation((async () => structuredClone(row.rec)) as never);
  vi.spyOn(dbm.db.keystore, "put").mockImplementation((async (r: unknown) => void (row.rec = structuredClone(r))) as never);
  vi.spyOn(dbm.db.keystore, "delete").mockImplementation((async () => void (row.rec = undefined)) as never);
  for (const name of ["addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
    vi.spyOn(dbm.db[name] as never, "clear" as never).mockResolvedValue(undefined as never);
  }
  const ethTx = await import("../src/services/eth-tx");
  const store = await import("../src/state/eth-unknown");
  const journal = await import("../src/state/eth-send-journal");
  const wc = await import("../src/crypto/worker-client");
  const ws = await import("../src/state/wallet-store");
  const { useUI: ui } = await import("../src/state/ui-store");
  ui.setState({ ethRpcOverride: undefined } as never);
  ethTx.ETH_BROADCAST_PROBE.intervalMs = 0;
  ethTx.ETH_BROADCAST_PROBE.timeoutMs = 500;
  ethTx.ETH_BROADCAST_PROBE.deadlineMs = 2_000;
  vi.spyOn(wc.cryptoWorker, "reset").mockImplementation(() => undefined);
  const sign = vi.fn(async (p: { tx: import("../src/crypto/worker").EthTxRequest }) => {
    const t = p.tx;
    const raw = await account.signTransaction({
      chainId: t.chainId, type: "eip1559", nonce: t.nonce, to: t.to, value: BigInt(t.value), data: t.data,
      gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
    });
    return { raw };
  });
  vi.spyOn(wc.cryptoWorker, "call").mockImplementation((async (m: string, p: never) => {
    if (m === "signEthTx") return sign(p);
    if (m === "lock") return {};
    if (m === "restoreWallet") {
      return {
        mnemonic: MNEMONIC,
        blob: { ...KEYSTORE_BLOB, ciphertext: "new" },
        addresses: { pearl: "prl1pnew", pearlPool: ["prl1pnew"], pearlChange: [], eth: ME },
      };
    }
    throw new Error(`unexpected ${m}`);
  }) as never);
  return { ethTx, store, journal, ws, dbm, sign };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

const mine = (k: string) => k.startsWith(`${V3}mainnet:${ME.toLowerCase()}:`);
const stored = () => [...ls.data].filter(([k]) => mine(k)).map(([, v]) => JSON.parse(v));
const durable = () => [...idb.entries(...JOURNAL)].filter(([k]) => mine(k)).map(([, v]) => JSON.parse(v as string));
const frozen = () => ({ gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, composedAt: Date.now() });

/** A fresh tab (the wiping one and the recording one are gone): the next
 *  nonce's send refuses before signing, naming `hash`. */
async function expectNextSendBlocked(hash: string) {
  vi.stubGlobal("navigator", { locks: fakeLocks() });
  const node = ethNode();
  const C = await openTab();
  const err = await C.ethTx.sendNative({ network: "mainnet", from: ME, to: TO, value: 1n, tier: "normal", frozen: frozen() }).catch((e) => e);
  expect(err).toBeInstanceOf(C.store.EthUnresolvedBroadcastError);
  expect((err as { hash: string }).hash).toBe(hash);
  expect(C.sign).not.toHaveBeenCalled();
  expect(node.accepted.size).toBe(0);
}

/** Where tab R writes its later record: both stores (the send path's own
 *  writer), only localStorage (its IndexedDB copy lost) or only the
 *  IndexedDB copy (its localStorage copy lost). */
type Where = "both" | "localStorage" | "indexedDB";
async function writeLater(R: Tab, where: Where, hash: `0x${string}`, ts: number) {
  const r = { network: "mainnet" as const, from: ME.toLowerCase(), hash, what: "ETH transfer", ts };
  if (where === "both") return R.store.recordEthUnknown(r);
  const key = R.store.ethUnknownRecordKey("mainnet", ME, hash);
  if (where === "localStorage") return R.store.putEthUnknown(ls, r);
  await R.journal.mutateEthSendJournal(() => new Map([[key, JSON.stringify(r)]]));
}

describe("R8 Q1 — Ethereum: the wipe / replace cleanup removes only the records it snapshotted", () => {
  beforeEach(() => {
    ls = memoryStorage();
    idb = fakeIndexedDB();
    vi.stubGlobal("localStorage", ls);
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    vi.stubGlobal("indexedDB", idb.factory);
    clock = null;
    vi.spyOn(Date, "now").mockImplementation(() => clock ?? realNow());
  });
  afterEach(() => {
    clock = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete g.addEventListener;
  });

  for (const where of ["both", "localStorage", "indexedDB"] as const) {
    for (const [label, offset] of [["an equal", 0], ["a backward (−1 ms)", -1]] as const) {
      it(`wipe: a record saved after the commit (${where}) with ${label} timestamp survives and blocks the next nonce; the snapshotted one goes`, async () => {
        ethNode();
        const T = realNow();
        const OLD = `0x${"66".repeat(32)}` as const;
        const H = `0x${"55".repeat(32)}` as const;
        const R = await openTab();
        await R.store.recordEthUnknown({ network: "mainnet", from: ME, hash: OLD, what: "ETH transfer", ts: T - 60_000 });
        clock = T;
        const B = await openTab(async () => {
          await writeLater(R, where, H, T + offset);
        });
        expect(await B.dbm.wipeKeystore()).toBe("wiped");
        clock = null;
        const inLs = where !== "indexedDB";
        const inIdb = where !== "localStorage";
        expect(stored().map((r) => [r.hash, r.ts])).toEqual(inLs ? [[H, T + offset]] : []);
        expect(durable().map((r) => [r.hash, r.ts])).toEqual(inIdb ? [[H, T + offset]] : []);
        await expectNextSendBlocked(H);
      });
    }
  }

  it("wipe: a snapshotted record rewritten after the snapshot (in flight → status-unknown) is kept in both stores", async () => {
    ethNode();
    const T = realNow();
    const H = `0x${"77".repeat(32)}` as const;
    const R = await openTab();
    // Saved in flight by a tab that is gone (lock free): plain wipe material…
    const inflight = { network: "mainnet", from: ME.toLowerCase(), hash: H, what: "ETH transfer", ts: T - 1, inflight: true, owner: "tab-gone" };
    const key = R.store.ethUnknownRecordKey("mainnet", ME, H);
    ls.setItem(key, JSON.stringify(inflight));
    await R.journal.mutateEthSendJournal(() => new Map([[key, JSON.stringify(inflight)]]));
    clock = T;
    // …but its outcome is recorded after the snapshot: a different value.
    const B = await openTab(async () => {
      await R.store.recordEthUnknown({ network: "mainnet", from: ME, hash: H, what: "ETH transfer" });
    });
    expect(await B.dbm.wipeKeystore()).toBe("wiped");
    clock = null;
    expect(stored()).toEqual([expect.objectContaining({ hash: H, ts: T - 1 })]);
    expect(stored()[0].inflight).toBeUndefined();
    expect(durable()).toEqual([expect.objectContaining({ hash: H, ts: T - 1 })]);
    await expectNextSendBlocked(H);
  });

  it("replace (restore over another wallet): equal-timestamp records saved after the commit survive in both families", async () => {
    ethNode();
    const T = realNow();
    const OLD = `0x${"88".repeat(32)}` as const;
    const H = `0x${"99".repeat(32)}` as const;
    const R = await openTab();
    await R.store.recordEthUnknown({ network: "mainnet", from: ME, hash: OLD, what: "ETH transfer", ts: T - 60_000 });
    const oldPrl = signedFixture(0x71);
    const newPrl = signedFixture(0x72);
    clock = T - 60_000;
    recordBroadcast(oldPrl.txid, planOf(oldPrl));
    clock = T;
    // Right after the replace's keystore transaction commits, a tab that
    // restored the new wallet records its sends (the static Pearl module
    // and tab R share this localStorage and IndexedDB).
    let armed = false;
    const A = await openTab(async () => {
      if (!armed) return;
      armed = false;
      await R.store.recordEthUnknown({ network: "mainnet", from: ME, hash: H, what: "ETH transfer" });
      expect(recordBroadcast(newPrl.txid, { ...planOf(newPrl), acknowledged: [oldPrl.txid] })).toBe(true);
    });
    await A.ws.useWallet.getState().init();
    armed = true;
    await A.ws.useWallet.getState().restoreWallet(MNEMONIC, "pw", { allowOverwrite: true, observedBlob: KEYSTORE_BLOB as never });
    expect(armed).toBe(false);
    clock = null;
    expect(stored().map((r) => [r.hash, r.ts])).toEqual([[H, T]]);
    expect(durable().map((r) => [r.hash, r.ts])).toEqual([[H, T]]);
    expect(storedRecords().map((r) => [r.txid, r.createdAt])).toEqual([[newPrl.txid, T]]);
    await expectNextSendBlocked(H);
  });
});
