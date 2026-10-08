// Broadcast records (src/services/pending-spends.ts, src/services/
// broadcast-status.ts) — one test group per safety goal:
//
//   G1  a coin spent by a possibly delivered broadcast is never re-selected
//   G2  an unknown broadcast (any kind) holds every new broadcast unless the
//       user acknowledged exactly those records
//   G3  nothing is released on a timer
//   G4  resolution: txid found, complete scan, explicit manual release only
//       after the tx is absent AND every input unspent
//   G5  one Web Locks lock across sign → record → submit → outcome; without
//       Web Locks a second tab is refused
//   G6  one versioned key; write / read failures refuse (fail closed)
//   G7  offline and vault broadcasts go through the same record

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as bip39 from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { masterFromSeed, pearlBranchPath, type HdBranch } from "../src/crypto/hd";
import { signPearlTxWithSeed, p2trScriptForInternalKey, type PearlTxRequest, type PearlUtxoSpec } from "../src/crypto/pearl-sign";
import { decodeTaprootAddress, pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import * as workerClient from "../src/crypto/worker-client";
import { BroadcastStatusUnknownError, p2trScriptAddress, rawTxId } from "../src/services/pearl-rpc";
import { broadcastPearlPrecomposed, broadcastSignedPearlTx, type ComposedPearlTx } from "../src/services/pearl-tx";
import { broadcastConsolidationBatch, composeConsolidation } from "../src/services/pearl-consolidate";
import {
  ACCEPTED_KEEP_MS,
  BROADCASTS_STORAGE_KEY,
  broadcastRecordIssue,
  broadcastRecords,
  BroadcastRefusedError,
  claimOnlyWalletTab,
  clearPendingSpends,
  excludePendingSpends,
  otherWalletTabOpen,
  pendingOutpoints,
  PendingSpendConflictError,
  resetUnreadableBroadcastRecord,
  unresolvedBroadcasts,
  withBroadcastLock,
  WALLET_TABS_STORAGE_KEY,
} from "../src/services/pending-spends";
import { checkBroadcast, noteScan, releaseBroadcast } from "../src/services/broadcast-status";
import { db, wipeKeystore } from "../src/storage/db";
import { useUI } from "../src/state/ui-store";
import PendingBroadcasts, { refusalMessage } from "../src/ui/components/PendingBroadcasts";
import {
  addRecord,
  rec,
  seedRecords,
  storedRecords,
  useFakeLocks,
  useMemoryStorage,
  type MemoryStorage,
} from "./helpers/broadcast-env";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const params = pearlParams("mainnet");
let seed: Uint8Array;
let master: HDKey;
let storage: MemoryStorage;

beforeAll(async () => {
  seed = await bip39.mnemonicToSeed(MNEMONIC);
  master = masterFromSeed(seed);
});
beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
  storage = useMemoryStorage();
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
const DEST_SCRIPT = "5120" + hex(decodeTaprootAddress(DEST, params));
function spec(branch: HdBranch, index: number, value: bigint, n: number): PearlUtxoSpec {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, valueGrains: value.toString(), scriptHex: scriptOf(branch, index), branch, index };
}
/** A real signed tx: two inputs (txids n0, n0+1), one output to DEST. */
function signedFixture(n0 = 1) {
  const ins = [spec(0, 1, 60_000n, n0), spec(1, 2, 41_000n, n0 + 1)];
  const req: PearlTxRequest = { utxos: ins, outputs: [{ address: DEST, amountGrains: "100000" }], network: "mainnet" };
  const { raw } = signPearlTxWithSeed(seed, req);
  return { raw, ins, txid: rawTxId(raw)! };
}
function composedFrom(ins: PearlUtxoSpec[]): ComposedPearlTx {
  return {
    utxos: ins.map((u) => ({ ...u, valueGrains: BigInt(u.valueGrains), branch: u.branch as 0 | 1, index: u.index })),
    outputs: [{ address: DEST, amountGrains: 100_000n }],
    amountGrains: 100_000n,
    feeGrains: 1_000n,
    tipGrains: 0n,
    changeGrains: 0n,
    degraded: false,
    historyIncomplete: 0,
    spendableGrains: 101_000n,
    spendableUtxoCount: 2,
  };
}
/** Send: sign (mocked worker returns `raw`) and broadcast the preview. */
function send(f: ReturnType<typeof signedFixture>, acknowledged: string[] = []) {
  vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: f.raw } as never);
  return broadcastPearlPrecomposed({ composed: composedFrom(f.ins), composedAt: Date.now() }, "mainnet", Date.now(), acknowledged);
}
const offline = (raw: string) => broadcastSignedPearlTx(raw, { kind: "offline" });

type Handler = (method: string, params: unknown[]) => Response | Promise<Response>;
function stubRpc(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      calls.push(body.method);
      return handler(body.method, body.params);
    }),
  );
  return calls;
}
const ok = (result: unknown) => new Response(JSON.stringify({ result, error: null }));
const rpcErr = (code: number, message: string) => new Response(JSON.stringify({ result: null, error: { code, message } }));
const NO_TX = () => rpcErr(-5, "No information available about transaction");
const NO_ADDR = () => rpcErr(-5, "No information available about address");
const DROP = () => {
  throw new TypeError("network connection lost");
};
/** Node: accepts every broadcast (answers with the tx's own id). */
const ACCEPT: Handler = (m, p) => (m === "sendrawtransaction" ? ok(rawTxId(p[0] as string)) : NO_TX());
const refusal = (e: unknown) => (e instanceof BroadcastRefusedError ? e.reason : e);
const flush = () => new Promise((r) => setTimeout(r, 5));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Address history for searchrawtransactions: `credits` pay `address`
 *  (txid:0 each), `spends` spend outpoints. Mempool txs look the same. */
function history(address: string, script: string, credits: string[], spends: { txid: string; vout: number }[] = []) {
  const txs: unknown[] = credits.map((txid) => ({ txid, vin: [], vout: [{ value: 0.001, n: 0, scriptPubKey: { address, hex: script } }] }));
  if (spends.length > 0) txs.push({ txid: "ee".repeat(32), vin: spends, vout: [] });
  return txs;
}
const C1 = "11".repeat(32);
const C2 = "22".repeat(32);
const T = "ab".repeat(32);

// ─── G6 ──────────────────────────────────────────────────────────────────

describe("G6 — one versioned record, written before submission, failing closed", () => {
  it("the broadcast is stored as 'unknown' under one key BEFORE it is submitted", async () => {
    const f = signedFixture(1);
    let atSubmission: unknown = null;
    stubRpc((m, p) => {
      if (m === "sendrawtransaction") atSubmission = JSON.parse(storage.getItem(BROADCASTS_STORAGE_KEY)!);
      return ACCEPT(m, p);
    });
    await expect(send(f)).resolves.toMatchObject({ txid: f.txid });
    expect(atSubmission).toEqual({
      v: 1,
      records: [
        expect.objectContaining({
          txid: f.txid,
          kind: "payment",
          state: "unknown",
          destination: DEST,
          amountGrains: "100000",
          inputs: f.ins.map((u) => `${u.txid}:0`),
          addresses: [...new Set(f.ins.map((u) => p2trScriptAddress(u.scriptHex)))],
        }),
      ],
    });
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid: f.txid, state: "accepted" })]);
    expect([...storage.data.keys()]).toEqual([BROADCASTS_STORAGE_KEY]);
  });

  it("a write failure before submission refuses: signed maybe, but never sent", async () => {
    const calls = stubRpc(ACCEPT);
    storage.failWrites = true;
    const err = await send(signedFixture(3)).catch((e: unknown) => e);
    expect(refusal(err)).toBe("storage");
    expect(calls).not.toContain("sendrawtransaction");
    expect(refusalMessage(err)).toMatch(/couldn't save/);
  });

  it("no storage at all refuses", async () => {
    useFakeLocks();
    vi.stubGlobal("localStorage", undefined);
    const calls = stubRpc(ACCEPT);
    expect(refusal(await offline(signedFixture(5).raw).catch((e: unknown) => e))).toBe("storage");
    expect(calls).toEqual([]);
  });

  it("an unreadable or invalid stored value refuses every broadcast until the user resets it", async () => {
    const calls = stubRpc(ACCEPT);
    for (const bad of ["{oops", JSON.stringify({ v: 2, records: [] }), JSON.stringify({ v: 1, records: [{ txid: "zz" }] })]) {
      storage.setItem(BROADCASTS_STORAGE_KEY, bad);
      expect(refusal(await offline(signedFixture(7).raw).catch((e: unknown) => e))).toBe("storage");
      expect(broadcastRecordIssue()).toBe("unreadable");
    }
    expect(calls).toEqual([]);
    await resetUnreadableBroadcastRecord();
    expect(broadcastRecordIssue()).toBeNull();
    await expect(offline(signedFixture(7).raw)).resolves.toBe(signedFixture(7).txid);
  });

  it("a read failure refuses too", async () => {
    stubRpc(ACCEPT);
    useFakeLocks();
    storage.failReads = true;
    expect(refusal(await offline(signedFixture(9).raw).catch((e: unknown) => e))).toBe("storage");
  });

  it("an outcome that can't be saved leaves the record 'unknown' (more caution) and is reported", async () => {
    const f = signedFixture(11);
    stubRpc((m, p) => {
      if (m === "sendrawtransaction") storage.failWrites = true;
      return ACCEPT(m, p);
    });
    await expect(offline(f.raw)).resolves.toBe(f.txid);
    storage.failWrites = false;
    expect(unresolvedBroadcasts()).toEqual([expect.objectContaining({ txid: f.txid, state: "unknown" })]);
    expect(broadcastRecordIssue()).toBe("update-failed");
  });

  it("wipe removes the record", async () => {
    addRecord(T, [{ txid: C1, vout: 0 }]);
    for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
      const tbl = db[t] as unknown as { clear?: () => Promise<void>; delete?: () => Promise<void> };
      if (tbl.clear) vi.spyOn(tbl, "clear").mockResolvedValue(undefined as never);
      if (tbl.delete) vi.spyOn(tbl, "delete").mockResolvedValue(undefined as never);
    }
    await wipeKeystore();
    expect(storage.getItem(BROADCASTS_STORAGE_KEY)).toBeNull();
    addRecord(T, [{ txid: C1, vout: 0 }]);
    clearPendingSpends();
    expect(pendingOutpoints().size).toBe(0);
  });
});

// ─── G1 / G3 ─────────────────────────────────────────────────────────────

describe("G1 / G3 — recorded coins stay out of selection; nothing expires an unknown broadcast", () => {
  it("coins of a recorded broadcast are excluded and refused for any other tx; the same bytes may be re-sent", async () => {
    const f = signedFixture(13);
    const calls = stubRpc(ACCEPT);
    await offline(f.raw);
    const { spendable, pending } = excludePendingSpends([...f.ins, { txid: C1, vout: 0 }]);
    expect(pending.map((u) => u.txid)).toEqual(f.ins.map((u) => u.txid));
    expect(spendable.map((u) => u.txid)).toEqual([C1]);
    // Another tx spending one of the same coins (different output) is refused unsent.
    const other = signPearlTxWithSeed(seed, {
      utxos: [f.ins[0]!],
      outputs: [{ address: DEST, amountGrains: "59000" }],
      network: "mainnet",
    }).raw;
    calls.length = 0;
    await expect(offline(other)).rejects.toBeInstanceOf(PendingSpendConflictError);
    expect(calls).not.toContain("sendrawtransaction");
    await expect(offline(f.raw)).resolves.toBe(f.txid);
  });

  it("an unknown record never expires; an accepted one is dropped after 24 h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    seedRecords([
      rec({ txid: T, inputs: [`${C1}:0`], createdAt: t0 }),
      rec({ txid: "cd".repeat(32), inputs: [`${C2}:0`], createdAt: t0, state: "accepted" }),
    ]);
    vi.setSystemTime(t0 + ACCEPTED_KEEP_MS + 1);
    expect([...pendingOutpoints()]).toEqual([`${C1}:0`]);
    vi.setSystemTime(t0 + 365 * 24 * 3600 * 1000);
    expect(unresolvedBroadcasts().map((r) => r.txid)).toEqual([T]);
    expect(pendingOutpoints().has(`${C1}:0`)).toBe(true);
  });
});

// ─── G2 ──────────────────────────────────────────────────────────────────

describe("G2 — an unknown broadcast holds every new broadcast", () => {
  it("an unknown offline payment blocks the next Send unless explicitly acknowledged", async () => {
    const first = signedFixture(21);
    stubRpc(DROP);
    await expect(offline(first.raw)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(unresolvedBroadcasts()).toEqual([expect.objectContaining({ txid: first.txid, kind: "offline", destination: DEST })]);

    const calls = stubRpc(ACCEPT);
    const next = signedFixture(23);
    const err = await send(next).catch((e: unknown) => e);
    expect(refusal(err)).toBe("unresolved");
    expect((err as BroadcastRefusedError).txids).toEqual([first.txid]);
    expect(workerClient.cryptoWorker.call).not.toHaveBeenCalled(); // nothing signed
    expect(calls).toEqual([]);
    expect(refusalMessage(err)).toMatch(/unknown status and may already have paid/);
    // With the explicit acknowledgement of exactly that broadcast: sent.
    await expect(send(next, [first.txid])).resolves.toMatchObject({ txid: next.txid });
  });

  it("an unknown vault payment blocks the next Send too", async () => {
    const vaultTx = signedFixture(25);
    stubRpc(DROP);
    await expect(broadcastSignedPearlTx(vaultTx.raw, { kind: "vault", addresses: [DEST] })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    stubRpc(ACCEPT);
    expect(refusal(await send(signedFixture(27)).catch((e: unknown) => e))).toBe("unresolved");
  });

  it("an acknowledgement covers only the broadcasts it names", async () => {
    seedRecords([rec({ txid: T, inputs: [`${C1}:0`] }), rec({ txid: "cd".repeat(32), inputs: [`${C2}:0`] })]);
    stubRpc(ACCEPT);
    const err = await send(signedFixture(29), [T]).catch((e: unknown) => e);
    expect(refusal(err)).toBe("unresolved");
    expect((err as BroadcastRefusedError).txids).toEqual(["cd".repeat(32)]);
  });

  it("an unknown consolidation holds further consolidation, sends, vault and offline broadcasts until resolved", async () => {
    const coins = [41, 42].map((n) => ({
      txid: n.toString(16).padStart(64, "0"),
      vout: 0,
      valueGrains: 10_000_000n,
      scriptHex: "5120" + "00".repeat(32),
      branch: 0 as const,
      index: 0,
    }));
    const plan = composeConsolidation({ utxos: coins, destination: { address: "e0", branch: 0, index: 0 } });
    const batchTx = signedFixture(43);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: batchTx.raw } as never);
    stubRpc(DROP);
    await expect(
      broadcastConsolidationBatch({ batch: plan.batches[0]!, verifiedAt: Date.now() }, "mainnet"),
    ).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(unresolvedBroadcasts()).toEqual([expect.objectContaining({ txid: batchTx.txid, kind: "consolidation" })]);

    const calls = stubRpc(ACCEPT);
    const plan2 = composeConsolidation({ utxos: coins.map((c) => ({ ...c, txid: c.txid.replace(/^0/, "f") })), destination: { address: "e0", branch: 0, index: 0 } });
    const again = await broadcastConsolidationBatch({ batch: plan2.batches[0]!, verifiedAt: Date.now() }, "mainnet").catch((e: unknown) => e);
    expect(refusal(again)).toBe("unresolved");
    expect(refusal(await send(signedFixture(45)).catch((e: unknown) => e))).toBe("unresolved");
    expect(refusal(await offline(signedFixture(47).raw).catch((e: unknown) => e))).toBe("unresolved");
    expect(refusal(await broadcastSignedPearlTx(signedFixture(49).raw, { kind: "vault" }).catch((e: unknown) => e))).toBe("unresolved");
    expect(calls).not.toContain("sendrawtransaction");

    // Resolved (the node holds it) → everything may proceed.
    stubRpc((m, p) => (m === "getrawtransaction" ? ok(batchTx.raw) : ACCEPT(m, p)));
    await expect(checkBroadcast(batchTx.txid)).resolves.toBe("found");
    await expect(send(signedFixture(45))).resolves.toMatchObject({ txid: signedFixture(45).txid });
  });
});

// ─── G4 ──────────────────────────────────────────────────────────────────

describe("G4 — resolution", () => {
  it("txid found → accepted: the hold is lifted, the coins stay reserved", async () => {
    const f = signedFixture(51);
    seedRecords([rec({ txid: f.txid, inputs: [`${C1}:0`] })]);
    stubRpc((m) => (m === "getrawtransaction" ? ok(f.raw) : NO_TX()));
    await expect(checkBroadcast(f.txid)).resolves.toBe("found");
    expect(unresolvedBroadcasts()).toEqual([]);
    expect(pendingOutpoints().has(`${C1}:0`)).toBe(true);
  });

  it("a complete scan begun after the broadcast that no longer lists its inputs settles it — and only such a scan", async () => {
    const t0 = Date.now();
    const r = rec({ txid: T, inputs: [`${C1}:0`], addresses: [DEST], createdAt: t0 });
    const listed = [{ txid: C1, vout: 0 }];
    for (const [startedAt, complete, utxos] of [
      [t0 - 1, true, []], // began before the broadcast
      [t0 + 1, false, []], // incomplete
      [t0 + 1, true, listed], // still lists the input
    ] as const) {
      seedRecords([r]);
      await noteScan(startedAt, [{ address: DEST, complete, utxos }]);
      expect(unresolvedBroadcasts(), `${startedAt} ${complete}`).toHaveLength(1);
    }
    await noteScan(t0 + 1, [{ address: "prl1pother", complete: true, utxos: [] }]); // not its address
    expect(unresolvedBroadcasts()).toHaveLength(1);
    await noteScan(t0 + 1, [{ address: DEST, complete: true, utxos: [] }]);
    expect(broadcastRecords()).toEqual([]);
    // Accepted records go the same way.
    seedRecords([{ ...r, state: "accepted" }]);
    await noteScan(t0 + 1, [{ address: DEST, complete: true, utxos: [] }]);
    expect(broadcastRecords()).toEqual([]);
  });

  it("manual release needs the tx absent AND every input unspent, re-checked at release time", async () => {
    const f = signedFixture(55);
    const unknown = () => seedRecords([rec({ txid: f.txid, inputs: [`${C1}:0`, `${C2}:0`], addresses: [DEST] })]);
    unknown();
    let hist = history(DEST, DEST_SCRIPT, [C1, C2]);
    let probe: () => Response = NO_TX;
    stubRpc((m, p) => {
      if (m === "getrawtransaction") return probe();
      if (m === "searchrawtransactions") return (p[2] as number) === 0 ? ok(hist) : NO_ADDR();
      return rpcErr(-32601, "nope");
    });
    await expect(checkBroadcast(f.txid)).resolves.toBe("absent-unspent");
    expect(unresolvedBroadcasts()).toHaveLength(1); // a check alone releases nothing

    // The node can't be asked → nothing released.
    probe = () => new Response("", { status: 500 });
    await expect(releaseBroadcast(f.txid)).resolves.toBe("unknown");
    expect(unresolvedBroadcasts()).toHaveLength(1);

    // The tx turns up while the release re-checks → accepted, not released.
    let probes = 0;
    probe = () => (++probes >= 2 ? ok(f.raw) : NO_TX());
    await expect(releaseBroadcast(f.txid)).resolves.toBe("found");
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid: f.txid, state: "accepted" })]);

    // Absent, and both coins unspent → released.
    unknown();
    probe = NO_TX;
    await expect(releaseBroadcast(f.txid)).resolves.toBe("absent-unspent");
    expect(broadcastRecords()).toEqual([]);

    // Absent, but a coin was spent by another tx (mempool included) → it
    // can never confirm: settled as "spent", never offered for release.
    unknown();
    hist = history(DEST, DEST_SCRIPT, [C1, C2], [{ txid: C2, vout: 0 }]);
    await expect(checkBroadcast(f.txid)).resolves.toBe("spent");
    expect(broadcastRecords()).toEqual([]);
  });

  it("an incomplete walk of an input's address proves nothing", async () => {
    seedRecords([rec({ txid: T, inputs: [`${C1}:0`], addresses: [DEST] })]);
    stubRpc((m) => (m === "getrawtransaction" ? NO_TX() : m === "searchrawtransactions" ? new Response("", { status: 500 }) : NO_TX()));
    await expect(releaseBroadcast(T)).resolves.toBe("unknown");
    expect(unresolvedBroadcasts()).toHaveLength(1);
  });

  it("an input output the node returned without its script is unlisted, not spent: Check and Release both say unknown", async () => {
    const f = signedFixture(57);
    seedRecords([rec({ txid: f.txid, inputs: [`${C1}:0`, `${C2}:0`], addresses: [DEST] })]);
    const hist = history(DEST, DEST_SCRIPT, [C1, C2]) as { vout: { scriptPubKey: { hex?: string } }[] }[];
    delete hist[1]!.vout[0]!.scriptPubKey.hex; // C2:0 — dropped by the walk
    stubRpc((m, p) => {
      if (m === "getrawtransaction") return NO_TX();
      if (m === "searchrawtransactions") return (p[2] as number) === 0 ? ok(hist) : NO_ADDR();
      return rpcErr(-32601, "nope");
    });
    await expect(checkBroadcast(f.txid)).resolves.toBe("unknown");
    expect(unresolvedBroadcasts()).toHaveLength(1);
    await expect(releaseBroadcast(f.txid)).resolves.toBe("unknown");
    expect(unresolvedBroadcasts()).toHaveLength(1);
    expect(pendingOutpoints().has(`${C2}:0`)).toBe(true);
  });

  it("offline record without addresses: each input's address comes from its verified funding tx", async () => {
    const funding = signedFixture(61); // output 0 pays DEST
    seedRecords([rec({ txid: T, inputs: [`${funding.txid}:0`], kind: "offline" })]);
    const calls = stubRpc((m, p) => {
      if (m === "getrawtransaction") return p[0] === funding.txid ? ok(funding.raw) : NO_TX();
      if (m === "searchrawtransactions") {
        return p[0] === DEST && (p[2] as number) === 0 ? ok(history(DEST, DEST_SCRIPT, [funding.txid])) : NO_ADDR();
      }
      return rpcErr(-32601, "nope");
    });
    await expect(checkBroadcast(T)).resolves.toBe("absent-unspent");
    expect(calls).toContain("searchrawtransactions");
    // A funding tx whose bytes don't hash to its txid proves nothing.
    stubRpc((m) => (m === "getrawtransaction" ? NO_TX() : NO_ADDR()));
    await expect(checkBroadcast(T)).resolves.toBe("unknown");
  });

  it("only an 'unknown' record can be released", async () => {
    addRecord(T, [{ txid: C1, vout: 0 }], { addresses: [DEST] }); // accepted
    const calls = stubRpc(() => NO_TX());
    await expect(releaseBroadcast(T)).resolves.toBe("unknown");
    expect(calls).toEqual([]);
    expect(pendingOutpoints().has(`${C1}:0`)).toBe(true);
  });
});

// ─── G5 ──────────────────────────────────────────────────────────────────

describe("G5 — the broadcast lock", () => {
  it("a suspended sender can't be overtaken: another tab's release waits for its outcome", async () => {
    useFakeLocks();
    const f = signedFixture(71);
    const answer = deferred<Response>();
    const calls = stubRpc((m) => {
      if (m === "sendrawtransaction") return answer.promise;
      if (m === "searchrawtransactions") return ok(history(DEST, DEST_SCRIPT, [f.ins[0]!.txid]));
      return NO_TX();
    });
    const sender = send(f);
    await flush();
    // The sender is stuck (suspended tab, slow network): its record says
    // "unknown" and the node doesn't have the tx yet.
    expect(unresolvedBroadcasts().map((r) => r.txid)).toEqual([f.txid]);
    const release = releaseBroadcast(f.txid);
    await flush();
    expect(calls.filter((c) => c === "getrawtransaction")).toEqual([]); // the release hasn't even checked
    answer.resolve(ok(f.txid)); // the sender resumes; its tx is accepted
    await expect(sender).resolves.toMatchObject({ txid: f.txid });
    await expect(release).resolves.toBe("unknown"); // no longer "unknown": nothing released
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid: f.txid, state: "accepted" })]);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("a second send waits for the first; a holder that never returns makes others give up unsent", async () => {
    const locks = useFakeLocks();
    const a = signedFixture(73);
    const b = signedFixture(75);
    const answer = deferred<Response>();
    const sent: string[] = [];
    stubRpc((m, p) => {
      if (m !== "sendrawtransaction") return NO_TX();
      sent.push(rawTxId(p[0] as string)!);
      return sent.length === 1 ? answer.promise : ok(rawTxId(p[0] as string));
    });
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValueOnce({ raw: a.raw } as never).mockResolvedValueOnce({ raw: b.raw } as never);
    const first = broadcastPearlPrecomposed({ composed: composedFrom(a.ins), composedAt: Date.now() }, "mainnet");
    await flush();
    const second = broadcastPearlPrecomposed({ composed: composedFrom(b.ins), composedAt: Date.now() }, "mainnet", Date.now(), [a.txid]);
    await flush();
    expect(sent).toEqual([a.txid]);
    const ran = vi.fn(async () => 1);
    await expect(withBroadcastLock(ran, { waitMs: 20 })).rejects.toMatchObject({ reason: "busy" });
    await expect(withBroadcastLock(ran, { ifAvailable: true })).rejects.toMatchObject({ reason: "busy" });
    expect(ran).not.toHaveBeenCalled();
    answer.resolve(ok(a.txid));
    await first;
    await second;
    expect(sent).toEqual([a.txid, b.txid]);
    expect(locks.isHeld("pearl-wallet-broadcast")).toBe(false);
  });

  it("without Web Locks: another listed wallet tab refuses broadcasting until the user says it's gone", async () => {
    const calls = stubRpc(ACCEPT);
    storage.setItem(WALLET_TABS_STORAGE_KEY, JSON.stringify(["another-tab"]));
    expect(otherWalletTabOpen()).toBe(true);
    const err = await offline(signedFixture(77).raw).catch((e: unknown) => e);
    expect(refusal(err)).toBe("second-tab");
    expect(refusalMessage(err)).toMatch(/can't coordinate tabs/);
    expect(calls).toEqual([]);
    claimOnlyWalletTab();
    expect(otherWalletTabOpen()).toBe(false);
    await expect(offline(signedFixture(77).raw)).resolves.toBe(signedFixture(77).txid);
    // Can't tell (no storage) → refused as well.
    vi.stubGlobal("localStorage", undefined);
    expect(otherWalletTabOpen()).toBe(true);
  });
});

// ─── G7 ──────────────────────────────────────────────────────────────────

describe("G7 — offline and vault broadcasts use the same record, with their destination", () => {
  it("records kind, destination and amount decoded from the raw tx", async () => {
    stubRpc(DROP);
    const o = signedFixture(81);
    await expect(offline(o.raw)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(storedRecords()).toEqual([
      expect.objectContaining({ txid: o.txid, kind: "offline", destination: DEST, amountGrains: "100000", addresses: [] }),
    ]);
    clearPendingSpends();
    const v = signedFixture(83);
    await expect(broadcastSignedPearlTx(v.raw, { kind: "vault", addresses: ["prl1pvault"] })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    expect(storedRecords()).toEqual([
      expect.objectContaining({ txid: v.txid, kind: "vault", destination: DEST, amountGrains: "100000", addresses: ["prl1pvault"] }),
    ]);
  });
});

// ─── Banner ──────────────────────────────────────────────────────────────

describe("banner", () => {
  const banner = () => renderToStaticMarkup(createElement(PendingBroadcasts));

  it("one banner per app shell: entries with Check status, Release only after a check", () => {
    expect(banner()).toBe("");
    seedRecords([rec({ txid: T, inputs: [`${C1}:0`], destination: DEST, amountGrains: "100000000", kind: "vault" })]);
    const html = banner();
    expect(html).toContain("A broadcast needs checking");
    expect(html).toContain("Vault payment of 1.0 PRL to prl1p");
    expect(html).toContain("Check status");
    expect(html).toContain(T);
    expect(html).not.toContain("Release");
  });

  it("an unreadable record is shown with an explicit reset", () => {
    storage.setItem(BROADCASTS_STORAGE_KEY, "{oops");
    expect(banner()).toContain("Reset the record");
  });

  it("every refusal has copy", () => {
    for (const reason of ["conflict", "unresolved", "storage", "busy", "second-tab"] as const) {
      expect(refusalMessage(new BroadcastRefusedError(reason, "x")), reason).toMatch(/^Not sent\./);
    }
    expect(refusalMessage(new Error("x"))).toBeNull();
  });
});
