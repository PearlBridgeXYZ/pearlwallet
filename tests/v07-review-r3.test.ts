// v0.7 review round 3 — regression tests for the confirmed findings:
//
//   R3-1  intent + attempt recorded with the reservation, before submission:
//         a reload mid-broadcast still shows it; a failed write is surfaced
//   R3-2  an HTTP refusal after a possibly delivered attempt is "unknown"
//   R3-3  destination matching ignores bech32m letter case
//   R3-4  an accepted re-broadcast resolves the open intent
//   R3-5  submission attempts are stored and the release is decided in the
//         same locked step (queued lock, second tab, manual release)
//   R3-6  tombstones apply to each source before the per-outpoint merge
//   R3-7  a tombstone always covers the record it releases
//   R3-8  wipe clears pending-spend memory as well as storage
//   R3-9  a non-durable release warning outlives the banner row
//   R3-10 one session epoch per scan; a cleared session launches no reads
//   R3-11 a scan begun during an address reset can't undo it
//   R3-12 vault compose offers one bounded deeper walk
//   R3-13 tombstones received by a passive tab are pruned and bounded

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as bip39 from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { masterFromSeed, pearlBranchPath } from "../src/crypto/hd";
import { signPearlTxWithSeed, p2trScriptForInternalKey, type PearlUtxoSpec, type PearlTxRequest } from "../src/crypto/pearl-sign";
import { pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import { vaultDescriptorFromPubkeys } from "../src/chains/pearl/multisig";
import { pearlMultisigPath } from "../src/crypto/hd";
import { bytesToHex } from "../src/crypto/descriptor";
import * as workerClient from "../src/crypto/worker-client";
import { validPearl } from "../src/lib/validate";
import {
  BroadcastStatusUnknownError,
  PearlRpcHttpError,
  MAX_UTXO_WALK_PAGES_HARD,
  classifyBroadcastRejection,
  rawTxId,
  _addressHistorySizeForTests,
} from "../src/services/pearl-rpc";
import { broadcastRecordingSpends, broadcastSignedPearlTx, HistoryIncompleteError } from "../src/services/pearl-tx";
import {
  beginSubmission,
  clearPendingSpends,
  clearPendingSpendsMemory,
  finishSubmission,
  forgetPendingTransaction,
  isSubmissionInFlight,
  manualReleaseState,
  needsPayTwiceAck,
  notePendingTxProbe,
  pendingOutpoints,
  pendingPersistenceIssue,
  recordPendingIntent,
  releasePendingSpends,
  renewSubmissionLease,
  reservePendingSpends,
  subscribePendingSpends,
  unresolvedIntentsTo,
  unresolvedPendingTransactions,
  PendingSpendConflictError,
  SubmissionInFlightError,
  PENDING_ATTEMPTS_STORAGE_KEY,
  PENDING_INTENTS_STORAGE_KEY,
  PENDING_RELEASES_STORAGE_KEY,
  PENDING_SPENDS_STORAGE_KEY,
  PENDING_SPEND_TTL_MS,
  SUBMISSION_LEASE_MS,
  _pendingMemorySnapshotForTests,
  _resetPendingMemoryForTests,
  _restorePendingMemoryForTests,
} from "../src/services/pending-spends";
import { walkPoolAddresses } from "../src/services/balances";
import { composeVaultSend } from "../src/services/multisig";
import { db, type VaultRecord } from "../src/storage/db";
import { clearBalanceMemory } from "../src/state/balance-memory";
import { useUI } from "../src/state/ui-store";
import { useWallet } from "../src/state/wallet-store";
import PendingBroadcasts from "../src/ui/components/PendingBroadcasts";
import { vaultHistoryCapMessage } from "../src/ui/pages/SendFromVault";
import type { HdBranch } from "../src/crypto/hd";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
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
  clearPendingSpends();
});
afterEach(() => {
  clearPendingSpends();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function scriptOf(branch: HdBranch, index: number): string {
  return hex(p2trScriptForInternalKey(master.derive(pearlBranchPath(branch, index)).publicKey!.slice(1)));
}
const DEST = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/86'/808276'/0'/0/0");
  return pearlAddressFromInternalKey(k.publicKey!.slice(1), params);
})();
const OTHER = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive("m/86'/808276'/0'/0/0");
  return pearlAddressFromInternalKey(k.publicKey!.slice(1), params);
})();
function spec(branch: HdBranch, index: number, value: bigint, n: number): PearlUtxoSpec {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, valueGrains: value.toString(), scriptHex: scriptOf(branch, index), branch, index };
}
/** A real signed raw tx: two inputs, one output, fee = 1,000 grains. */
function signedFixture(n0 = 1) {
  const ins = [spec(0, 1, 60_000n, n0), spec(1, 2, 41_000n, n0 + 1)];
  const req: PearlTxRequest = { utxos: ins, outputs: [{ address: DEST, amountGrains: "100000" }], network: "mainnet" };
  const { raw } = signPearlTxWithSeed(seed, req);
  return { raw, ins, txid: rawTxId(raw)! };
}

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
const BUSY = () => new Response("busy", { status: 503 });
const DROP = () => {
  throw new TypeError("network connection lost");
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

function installStorage(opts: { failKeys?: string[] } = {}) {
  const map = new Map<string, string>();
  const state = { failSet: false, failKeys: new Set(opts.failKeys ?? []) };
  const storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (state.failSet || state.failKeys.has(k)) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  } as Storage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  return { map, state };
}
const OP = (n: number) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0 });
const key = (n: number) => `${OP(n).txid}:0`;
const banner = () => renderToStaticMarkup(createElement(PendingBroadcasts, { network: "mainnet" }));

// ─── R3-1 ────────────────────────────────────────────────────────────────

describe("R3-1 — the intent is recorded with the reservation, before submission", () => {
  it("reload during an in-flight submission: one banner entry, the destination still matches", async () => {
    const { map } = installStorage();
    const { raw, ins, txid } = signedFixture(101);
    const answer = deferred<Response>();
    stubRpc((m) => (m === "sendrawtransaction" ? answer.promise : NO_TX()));
    const tabA = broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 100_000n }).catch((e: unknown) => e);
    await flush();
    expect(map.get(PENDING_INTENTS_STORAGE_KEY)).toContain(txid);
    expect(map.get(PENDING_ATTEMPTS_STORAGE_KEY)).toContain(txid);

    // The page reloads: only storage is left.
    _resetPendingMemoryForTests();
    const now = Date.now();
    expect(unresolvedPendingTransactions(now)).toEqual([
      expect.objectContaining({
        spentBy: txid,
        coins: 2,
        inFlight: true,
        metadataMissing: false,
        intent: expect.objectContaining({ destination: DEST, amountGrains: "100000", resolvedAt: null }),
      }),
    ]);
    expect(unresolvedIntentsTo(DEST)).toHaveLength(1);
    expect(needsPayTwiceAck(DEST)).toBe(true);
    expect(manualReleaseState(txid, true, now)).toEqual({ state: "in-flight" });
    expect(banner()).toContain("A broadcast is in progress");

    // The reloaded tab never renews the lease: once it runs out the entry
    // is "needs checking" and can be checked / released by hand.
    const later = now + SUBMISSION_LEASE_MS + 1;
    expect(unresolvedPendingTransactions(later)).toEqual([expect.objectContaining({ spentBy: txid, inFlight: false })]);
    expect(manualReleaseState(txid, true, later)).toEqual({ state: "check" });

    answer.resolve(ok(txid));
    await tabA;
  });

  it("an intent-key write failure is surfaced, and after a reload the reservation is still shown and gates Send", async () => {
    installStorage({ failKeys: [PENDING_INTENTS_STORAGE_KEY] });
    const { raw, ins, txid } = signedFixture(103);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    expect(pendingPersistenceIssue()).toEqual({ records: true, releases: false });
    expect(banner()).toContain("couldn&#x27;t save the wallet&#x27;s record of a recent broadcast");
    // This tab still has the intent in memory.
    expect(unresolvedIntentsTo(DEST)).toHaveLength(1);

    _resetPendingMemoryForTests();
    const open = unresolvedPendingTransactions();
    expect(open).toEqual([expect.objectContaining({ spentBy: txid, intent: null, metadataMissing: true })]);
    // Unknown destination: it could be paying any address.
    expect(needsPayTwiceAck(DEST)).toBe(true);
    expect(needsPayTwiceAck(OTHER)).toBe(true);
    expect(banner()).toContain("Destination not recorded.");
  });

  it("an accepted broadcast resolves its intent; coins stay reserved", async () => {
    installStorage();
    const { raw, ins, txid } = signedFixture(105);
    stubRpc(() => ok(txid));
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).resolves.toBe(txid);
    expect(unresolvedPendingTransactions()).toEqual([]);
    expect(needsPayTwiceAck(DEST)).toBe(false);
    expect(pendingOutpoints().size).toBe(2);
    _resetPendingMemoryForTests();
    expect(unresolvedPendingTransactions()).toEqual([]);
    expect(pendingPersistenceIssue()).toBeNull();
  });

  it("a definite first-contact rejection releases the coins and resolves the intent", async () => {
    installStorage();
    const { raw, ins } = signedFixture(107);
    stubRpc(() => rpcErr(-26, "min relay fee not met"));
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toThrow(/min relay fee/);
    expect(pendingOutpoints().size).toBe(0);
    expect(unresolvedPendingTransactions()).toEqual([]);
    expect(needsPayTwiceAck(DEST)).toBe(false);
  });
});

// ─── R3-2 ────────────────────────────────────────────────────────────────

describe("R3-2 — an HTTP refusal says nothing about an earlier, possibly delivered attempt", () => {
  it("non-transient HTTP statuses are never 'deterministic'", () => {
    for (const status of [400, 401, 403, 404, 413]) {
      expect(classifyBroadcastRejection(new PearlRpcHttpError(status, null)), String(status)).toBe("state-dependent");
    }
  });

  for (const status of [401, 403, 413]) {
    it(`transient → HTTP ${status} → absent twice ⇒ status unknown, reservation and intent kept`, async () => {
      const { raw, ins, txid } = signedFixture(111);
      let n = 0;
      const calls = stubRpc((m) =>
        m === "getrawtransaction" ? NO_TX() : ++n === 1 ? BUSY() : new Response("refused", { status }),
      );
      const err = await broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
      expect(calls.filter((c) => c === "getrawtransaction")).toHaveLength(2);
      expect(pendingOutpoints().size).toBe(2);
      expect(unresolvedIntentsTo(DEST)).toEqual([expect.objectContaining({ txid })]);
    });
  }

  it("transient → HTTP 403 → found on the probe ⇒ success", async () => {
    const { raw, ins, txid } = signedFixture(113);
    let n = 0;
    stubRpc((m) => (m === "getrawtransaction" ? ok(raw) : ++n === 1 ? BUSY() : new Response("", { status: 403 })));
    await expect(broadcastRecordingSpends(raw, ins)).resolves.toBe(txid);
  });

  it("first-contact HTTP 403 (nothing delivered before) stays a plain failure and releases", async () => {
    const { raw, ins } = signedFixture(115);
    const calls = stubRpc(() => new Response("", { status: 403 }));
    const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PearlRpcHttpError);
    expect(calls).not.toContain("getrawtransaction");
    expect(pendingOutpoints().size).toBe(0);
  });

  it("429 (refused before forwarding) then 403 stays a plain failure", async () => {
    const { raw, ins } = signedFixture(117);
    let n = 0;
    const calls = stubRpc(() => (++n === 1 ? new Response("", { status: 429 }) : new Response("", { status: 403 })));
    const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PearlRpcHttpError);
    expect(calls).not.toContain("getrawtransaction");
    expect(pendingOutpoints().size).toBe(0);
  });
});

// ─── R3-3 ────────────────────────────────────────────────────────────────

describe("R3-3 — the same address in upper case is the same destination", () => {
  it("the validator accepts both encodings", () => {
    expect(validPearl(DEST, "mainnet")).toBe(true);
    expect(validPearl(DEST.toUpperCase(), "mainnet")).toBe(true);
  });

  it("recorded lower-case, looked up upper-case (compose and click-time guards)", async () => {
    const { raw, ins, txid } = signedFixture(121);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    for (const d of [DEST, DEST.toUpperCase(), ` ${DEST.toUpperCase()} `]) {
      expect(unresolvedIntentsTo(d), d).toEqual([expect.objectContaining({ txid })]);
      expect(needsPayTwiceAck(d), d).toBe(true);
    }
    expect(needsPayTwiceAck(OTHER)).toBe(false);
  });

  it("recorded upper-case (QR), looked up lower-case", async () => {
    const { raw, ins } = signedFixture(123);
    stubRpc(DROP);
    await expect(
      broadcastRecordingSpends(raw, ins, { destination: DEST.toUpperCase(), amountGrains: 5n }),
    ).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(unresolvedIntentsTo(DEST)).toHaveLength(1);
    expect(unresolvedIntentsTo(DEST)[0]!.destination).toBe(DEST);
  });

  it("intents persisted by an earlier version in upper case are normalised on read", () => {
    const { map } = installStorage();
    const T = "c".repeat(64);
    reservePendingSpends(T, [OP(1)]);
    map.set(
      PENDING_INTENTS_STORAGE_KEY,
      JSON.stringify([{ txid: T, destination: DEST.toUpperCase(), amountGrains: "5", at: Date.now(), resolvedAt: null }]),
    );
    _resetPendingMemoryForTests();
    expect(unresolvedIntentsTo(DEST)).toHaveLength(1);
    expect(needsPayTwiceAck(DEST)).toBe(true);
  });
});

// ─── R3-4 ────────────────────────────────────────────────────────────────

describe("R3-4 — an accepted re-broadcast resolves the open intent", () => {
  it("unknown → re-broadcast accepted → no unresolved entry", async () => {
    installStorage();
    const { raw, ins, txid } = signedFixture(131);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    expect(unresolvedPendingTransactions()).toHaveLength(1);
    // The vault / offline path re-broadcasts the same bytes.
    stubRpc(() => ok(txid));
    await expect(broadcastSignedPearlTx(raw)).resolves.toBe(txid);
    expect(unresolvedPendingTransactions()).toEqual([]);
    expect(needsPayTwiceAck(DEST)).toBe(false);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("re-broadcast rejected after an unknown attempt: nothing released, intent stays open", async () => {
    const { raw, ins } = signedFixture(133);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    stubRpc(() => rpcErr(-26, "min relay fee not met"));
    await expect(broadcastSignedPearlTx(raw)).rejects.toThrow(/min relay fee/);
    expect(pendingOutpoints().size).toBe(2);
    expect(unresolvedIntentsTo(DEST)).toHaveLength(1);
  });
});

// ─── R3-5 ────────────────────────────────────────────────────────────────

describe("R3-5 — submissions are coordinated through stored attempts, under the lock", () => {
  it("queued lock: a rejection can't release a reservation another attempt just took over", async () => {
    let tail: Promise<unknown> = Promise.resolve();
    vi.stubGlobal("navigator", {
      locks: {
        request: (_n: string, _o: unknown, cb: () => unknown) => {
          const run = tail.then(() => cb());
          tail = run.catch(() => undefined);
          return run;
        },
      },
    });
    const { raw, ins, txid } = signedFixture(141);
    const answers = [deferred<Response>(), deferred<Response>()];
    let n = 0;
    stubRpc((m) => (m === "sendrawtransaction" ? answers[n++]!.promise : NO_TX()));
    const a = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    await flush();
    // Something else holds the lock; B's reservation queues behind it.
    const held = deferred<void>();
    const blocker = (navigator as unknown as { locks: { request: (...x: unknown[]) => Promise<unknown> } }).locks.request(
      "pearl-pending-spends",
      { mode: "exclusive" },
      () => held.promise,
    );
    const b = broadcastRecordingSpends(raw, ins);
    await flush();
    // A is rejected; its finishing step queues after B's reservation.
    answers[0]!.resolve(rpcErr(-26, "min relay fee not met"));
    await flush();
    held.resolve();
    await blocker;
    expect(await a).toBeInstanceOf(Error);
    expect(pendingOutpoints().size).toBe(2); // B is in flight
    expect(isSubmissionInFlight(txid)).toBe(true);
    answers[1]!.resolve(ok(txid));
    await expect(b).resolves.toBe(txid);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("two module instances (tabs) sharing storage: A's rejection doesn't release B's in-flight submission", async () => {
    installStorage();
    const { raw, ins, txid } = signedFixture(143);
    const answers = [deferred<Response>(), deferred<Response>()];
    let n = 0;
    stubRpc((m) => (m === "sendrawtransaction" ? answers[n++]!.promise : NO_TX()));
    vi.resetModules();
    const txB = await import("../src/services/pearl-tx");
    const psB = await import("../src/services/pending-spends");

    const a = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    await flush();
    const b = txB.broadcastRecordingSpends(raw, ins);
    await flush();
    expect(psB.isSubmissionInFlight(txid)).toBe(true);
    answers[0]!.resolve(rpcErr(-26, "min relay fee not met"));
    expect(await a).toBeInstanceOf(Error);
    expect(pendingOutpoints().size).toBe(2);
    expect(psB.pendingOutpoints().size).toBe(2);
    answers[1]!.resolve(ok(txid));
    await expect(b).resolves.toBe(txid);
    expect(pendingOutpoints().size).toBe(2);
    expect(unresolvedPendingTransactions()).toEqual([]);
  });

  it("manual release from another tab is refused while the submission is in flight", async () => {
    installStorage();
    const { raw, ins, txid } = signedFixture(145);
    const answer = deferred<Response>();
    stubRpc((m) => (m === "sendrawtransaction" ? answer.promise : NO_TX()));
    vi.resetModules();
    const psB = await import("../src/services/pending-spends");
    const a = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    await flush();
    psB.notePendingTxProbe(txid, "absent");
    expect(psB.manualReleaseState(txid, true)).toEqual({ state: "in-flight" });
    expect(() => psB.forgetPendingTransaction(txid)).toThrow(psB.SubmissionInFlightError);
    expect(psB.pendingOutpoints().size).toBe(2);
    answer.resolve(ok(txid));
    await expect(a).resolves.toBe(txid);
    expect(psB.manualReleaseState(txid, true)).toEqual({ state: "ready" });
  });

  it("a lease runs out unless renewed; an abandoned attempt blocks automatic release", () => {
    installStorage();
    const T = "d".repeat(64);
    const t0 = Date.now();
    const added = reservePendingSpends(T, [OP(1)], t0);
    const abandoned = beginSubmission(T, added, t0, 1_000);
    expect(isSubmissionInFlight(T, t0 + 500)).toBe(true);
    expect(renewSubmissionLease(abandoned, t0 + 900, 1_000)).toBe(true);
    expect(isSubmissionInFlight(T, t0 + 1_500)).toBe(true);
    expect(isSubmissionInFlight(T, t0 + 2_000)).toBe(false);
    // Its tab is gone (lease expired, outcome unknown). A later attempt of
    // the same tx is rejected: the coins stay reserved.
    const later = beginSubmission(T, [], t0 + 3_000);
    expect(finishSubmission(later, "rejected", t0 + 3_001)).toEqual({ released: [], durable: true });
    expect(pendingOutpoints(t0 + 3_001).has(key(1))).toBe(true);
    // A finished attempt can't be renewed or finished again.
    expect(renewSubmissionLease(later, t0 + 3_002)).toBe(false);
    expect(finishSubmission(later, "accepted", t0 + 3_002)).toEqual({ released: [], durable: true });
  });

  it("every attempt rejected: the last one to finish releases everything any of them reserved", () => {
    const T = "e".repeat(64);
    const t0 = Date.now();
    const first = beginSubmission(T, reservePendingSpends(T, [OP(1), OP(2)], t0), t0);
    const second = beginSubmission(T, reservePendingSpends(T, [OP(1), OP(2)], t0), t0);
    expect(finishSubmission(first, "rejected", t0 + 1).released).toEqual([]);
    expect(pendingOutpoints(t0 + 1).size).toBe(2);
    expect(finishSubmission(second, "rejected", t0 + 2).released.sort()).toEqual([key(1), key(2)]);
    expect(pendingOutpoints(t0 + 2).size).toBe(0);
  });
});

// ─── R3-6 ────────────────────────────────────────────────────────────────

describe("R3-6 — a released record never shadows another tx's live reservation", () => {
  const TX = "a".repeat(64);
  const TY = "b".repeat(64);
  const TZ = "c".repeat(64);

  it("clock rollback: stale X (later timestamp) in memory, live Y in storage", () => {
    installStorage();
    reservePendingSpends(TX, [OP(1)], 100_000);
    const staleTab = _pendingMemorySnapshotForTests();
    releasePendingSpends([key(1)], TX, 100_100);
    // The clock stepped back; another tab reserves the coin for Y.
    expect(reservePendingSpends(TY, [OP(1)], 90_000)).toEqual([key(1)]);
    _restorePendingMemoryForTests(staleTab);
    expect(pendingOutpoints(90_001).has(key(1))).toBe(true);
    expect(() => reservePendingSpends(TZ, [OP(1)], 90_002)).toThrow(PendingSpendConflictError);
  });

  it("same-millisecond tie with different spending txids", () => {
    installStorage();
    const t = 200_000;
    reservePendingSpends(TX, [OP(1)], t);
    const staleTab = _pendingMemorySnapshotForTests();
    releasePendingSpends([key(1)], TX, t);
    reservePendingSpends(TY, [OP(1)], t);
    _restorePendingMemoryForTests(staleTab);
    expect(pendingOutpoints(t).has(key(1))).toBe(true);
    expect(() => reservePendingSpends(TZ, [OP(1)], t)).toThrow(PendingSpendConflictError);
  });
});

// ─── R3-7 ────────────────────────────────────────────────────────────────

describe("R3-7 — a release always covers the record it targets", () => {
  const T = "a".repeat(64);

  it("re-reservation in the same millisecond (recordedAt = release + 1) can be released", () => {
    installStorage();
    const t = 300_000;
    reservePendingSpends(T, [OP(1)], t);
    expect(forgetPendingTransaction(T, t)).toBe(true);
    reservePendingSpends(T, [OP(1)], t);
    expect(pendingOutpoints(t).has(key(1))).toBe(true);
    expect(forgetPendingTransaction(T, t)).toBe(true);
    expect(pendingOutpoints(t).has(key(1))).toBe(false);
  });

  it("after a 60 s clock rollback the re-reservation is still released, and reported truthfully", () => {
    installStorage();
    const t = 400_000;
    reservePendingSpends(T, [OP(1)], t);
    expect(forgetPendingTransaction(T, t)).toBe(true);
    reservePendingSpends(T, [OP(1)], t - 60_000);
    expect(pendingOutpoints(t - 60_000).has(key(1))).toBe(true);
    expect(releasePendingSpends([key(1)], T, t - 59_000)).toBe(true);
    expect(pendingOutpoints(t - 59_000).has(key(1))).toBe(false);
    // Also survives a reload.
    _resetPendingMemoryForTests();
    expect(pendingOutpoints(t - 59_000).has(key(1))).toBe(false);
  });

  it("the intent is resolved only once the coins are actually gone", async () => {
    const { raw, ins, txid } = signedFixture(171);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    expect(forgetPendingTransaction(txid)).toBe(true);
    expect(pendingOutpoints().size).toBe(0);
    expect(unresolvedIntentsTo(DEST)).toHaveLength(0);
  });
});

// ─── R3-8 ────────────────────────────────────────────────────────────────

describe("R3-8 — wipe clears pending-spend memory, not just storage", () => {
  afterEach(() => {
    useWallet.setState({ status: "locked", addresses: null, blob: null });
  });

  it("wipe → reserve: storage holds only the new record; no old intent survives", async () => {
    const { map } = installStorage();
    const { raw, ins, txid } = signedFixture(181);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    expect(unresolvedPendingTransactions()).toHaveLength(1);

    for (const t of ["keystore", "addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
      const tbl = db[t] as unknown as { clear?: () => Promise<void>; delete?: () => Promise<void> };
      if (tbl.clear) vi.spyOn(tbl, "clear").mockResolvedValue(undefined as never);
      if (tbl.delete) vi.spyOn(tbl, "delete").mockResolvedValue(undefined as never);
    }
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ mnemonic: MNEMONIC } as never);
    vi.spyOn(workerClient.cryptoWorker, "reset").mockImplementation(() => undefined);
    useWallet.setState({ status: "unlocked", blob: {} as never });
    await useWallet.getState().wipe("pw");

    for (const k of [PENDING_SPENDS_STORAGE_KEY, PENDING_RELEASES_STORAGE_KEY, PENDING_INTENTS_STORAGE_KEY, PENDING_ATTEMPTS_STORAGE_KEY]) {
      expect(map.has(k), k).toBe(false);
    }
    expect(unresolvedPendingTransactions()).toEqual([]);
    reservePendingSpends("f".repeat(64), [OP(9)]);
    expect(JSON.parse(map.get(PENDING_SPENDS_STORAGE_KEY)!)).toEqual([expect.objectContaining({ outpoint: key(9) })]);
    expect(map.get(PENDING_SPENDS_STORAGE_KEY)).not.toContain(txid);
    expect(map.has(PENDING_INTENTS_STORAGE_KEY)).toBe(false);
  });

  it("a peer tab's 'wiped' handling drops its memory copies (storage already removed by the wiping tab)", () => {
    const { map } = installStorage();
    reservePendingSpends("a".repeat(64), [OP(1)]);
    recordPendingIntent({ txid: "a".repeat(64), destination: DEST, amountGrains: 5n });
    map.clear(); // the wiping tab removed the keys
    clearPendingSpendsMemory();
    reservePendingSpends("f".repeat(64), [OP(9)]);
    expect(JSON.parse(map.get(PENDING_SPENDS_STORAGE_KEY)!)).toEqual([expect.objectContaining({ outpoint: key(9) })]);
    expect(unresolvedIntentsTo(DEST)).toEqual([]);
  });

  it("a broadcast that finishes after the wipe writes nothing back", async () => {
    const { map } = installStorage();
    const { raw, ins } = signedFixture(183);
    const answer = deferred<Response>();
    stubRpc((m) => (m === "sendrawtransaction" ? answer.promise : NO_TX()));
    const p = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    await flush();
    clearPendingSpends();
    answer.resolve(rpcErr(-26, "min relay fee not met"));
    await p;
    expect(map.has(PENDING_ATTEMPTS_STORAGE_KEY)).toBe(false);
    expect(map.has(PENDING_RELEASES_STORAGE_KEY)).toBe(false);
  });
});

// ─── R3-9 ────────────────────────────────────────────────────────────────

describe("R3-9 — the non-durable release warning outlives the banner row", () => {
  it("rendered: release with failing setItem → row gone, warning still shown", async () => {
    const { state } = installStorage();
    const { raw, ins, txid } = signedFixture(191);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    expect(banner()).toContain("A broadcast needs checking");
    state.failSet = true;
    notePendingTxProbe(txid, "absent");
    expect(manualReleaseState(txid, true)).toEqual({ state: "ready" });
    expect(forgetPendingTransaction(txid)).toBe(false);
    const html = banner();
    expect(html).not.toContain("needs checking");
    expect(html).toContain("Released in this tab, but the browser couldn&#x27;t save that.");
    // Once a later release write succeeds, every release this tab held is
    // saved (each write stores the whole merged list).
    state.failSet = false;
    expect(releasePendingSpends([key(500)], "9".repeat(64))).toBe(true);
    expect(pendingPersistenceIssue()?.releases).toBe(false);
    expect(banner()).not.toContain("Released in this tab");
    _resetPendingMemoryForTests();
    expect(pendingOutpoints().size).toBe(0);
  });
});

// ─── R3-10 ───────────────────────────────────────────────────────────────

describe("R3-10 — one session epoch per scan", () => {
  it("a two-address scan at concurrency 1 launches no read after the session is cleared", async () => {
    const gate = deferred<Response>();
    const calls = stubRpc(() => gate.promise);
    const refs = [
      { address: "prl1pscanone", branch: 0 as const, index: 0 },
      { address: "prl1pscantwo", branch: 0 as const, index: 1 },
    ];
    const walk = walkPoolAddresses(refs, { concurrency: 1 });
    await flush();
    clearBalanceMemory();
    gate.resolve(rpcErr(-5, "No information available about address"));
    const results = await walk;
    expect(calls).toHaveLength(1);
    expect(results[1]).toMatchObject({ status: "error", error: expect.stringContaining("E_SESSION_CLEARED") });
    expect(_addressHistorySizeForTests()).toBe(0);
  });
});

// ─── R3-11 ───────────────────────────────────────────────────────────────

describe("R3-11 — a scan begun while a reset waits can't undo it", () => {
  afterEach(() => {
    useWallet.setState({ status: "locked", addresses: null });
  });

  it("reset completes to 20; the handler bound mid-reset can't extend to 61", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `e${i}`);
    useWallet.setState({
      status: "unlocked",
      addresses: { pearl: "e0", pearlPool: long, pearlChange: ["i0"], eth: "0x0" } as never,
    });
    const rec = () => ({ id: "primary", publicData: { pearlAddress: "e0", pearlAddressPool: [...long], pearlChangePool: ["i0"] } });
    const held = deferred<unknown>();
    vi.spyOn(db.keystore, "get")
      .mockImplementationOnce(() => held.promise as never)
      .mockImplementation(async () => rec() as never);
    const put = vi.spyOn(db.keystore, "put").mockResolvedValue("primary" as never);

    const reset = useWallet.getState().resetPearlAddresses();
    await flush();
    // A scan starts now: it binds the bumped generation but copies the
    // long list.
    const midReset = useWallet.getState().pearlDiscoveryHandler();
    const snapshot = useWallet.getState().addresses!.pearlPool;
    expect(snapshot).toHaveLength(60);
    held.resolve(rec());
    await expect(reset).resolves.toBe(true);
    expect(useWallet.getState().addresses!.pearlPool).toHaveLength(20);
    await expect(midReset({ external: [...snapshot, "e60"], internal: ["i0"] })).resolves.toBe(false);
    expect(useWallet.getState().addresses!.pearlPool).toHaveLength(20);
    expect(put).toHaveBeenCalledTimes(1);
    // A scan bound after the reset still works.
    await expect(
      useWallet.getState().pearlDiscoveryHandler()({ external: [...long.slice(0, 20), "e20"], internal: ["i0"] }),
    ).resolves.toBe(true);
    expect(useWallet.getState().addresses!.pearlPool).toHaveLength(21);
  });
});

// ─── R3-12 ───────────────────────────────────────────────────────────────

describe("R3-12 — vault compose: one bounded deeper walk", () => {
  const SCRIPT = "5120" + "00".repeat(32);
  function vaultRecord(): VaultRecord {
    const cs = [0, 1, 2].map((i) => master.derive(pearlMultisigPath(0, i)).publicKey!.slice(1));
    const desc = vaultDescriptorFromPubkeys(2, cs, params);
    return {
      id: "vault-r3",
      version: 1,
      label: "Vault",
      threshold: 2,
      total: 3,
      sortedPubkeysHex: desc.sortedPubkeys.map((p) => bytesToHex(p)),
      myPubkeyHex: bytesToHex(cs[0]!),
      myOriginPath: pearlMultisigPath(0, 0),
      myVaultAccount: 0,
      myKeyIndex: 0,
      pearlAddress: desc.address,
      network: "mainnet",
      createdAt: Date.now(),
    };
  }
  function stubHistory(address: string, count: number) {
    return stubRpc((m, p) => {
      if (m !== "searchrawtransactions" || p[0] !== address) return rpcErr(-32601, "nope");
      const skip = p[2] as number;
      const n = Math.max(0, Math.min(100, count - skip));
      if (n === 0) return rpcErr(-5, "No information available about address");
      return ok(
        Array.from({ length: n }, (_, i) => ({
          txid: (skip + i + 1).toString(16).padStart(64, "0"),
          vin: [],
          vout: [{ value: 1, n: 0, scriptPubKey: { address, hex: SCRIPT } }],
        })),
      );
    });
  }

  it("default depth refuses 6,001 txs; the deeper walk reads them all and composes", async () => {
    const rec = vaultRecord();
    stubHistory(rec.pearlAddress, 6_001);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ psbtBase64: "psbt" } as never);
    await expect(composeVaultSend({ vault: rec, destination: DEST, amountGrains: 1_000n })).rejects.toBeInstanceOf(
      HistoryIncompleteError,
    );
    const c = await composeVaultSend({
      vault: rec,
      destination: DEST,
      amountGrains: 1_000n,
      maxPages: MAX_UTXO_WALK_PAGES_HARD,
    });
    expect(c.utxos.length).toBeGreaterThan(0);
  });

  it("past the hard cap the refusal stands, with copy that says waiting won't help", async () => {
    const rec = vaultRecord();
    stubHistory(rec.pearlAddress, MAX_UTXO_WALK_PAGES_HARD * 100 + 1);
    const call = vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ psbtBase64: "psbt" } as never);
    await expect(
      composeVaultSend({ vault: rec, destination: DEST, amountGrains: 1_000n, maxPages: MAX_UTXO_WALK_PAGES_HARD * 10 }),
    ).rejects.toBeInstanceOf(HistoryIncompleteError);
    expect(call).not.toHaveBeenCalled();
    expect(vaultHistoryCapMessage(false)).toContain("Search deeper");
    expect(vaultHistoryCapMessage(true)).toContain("Waiting won't change this");
    expect(vaultHistoryCapMessage(true)).not.toContain("Search deeper");
  });
});

// ─── R3-13 ───────────────────────────────────────────────────────────────

describe("R3-13 — a passive tab prunes and bounds received tombstones", () => {
  const rel = (n: number, releasedAt: number) => ({
    outpoint: `${n.toString(16).padStart(64, "0")}:0`,
    spentBy: "a".repeat(64),
    releasedAt,
  });

  it("expired tombstones from the channel are dropped on receipt", async () => {
    const unsub = subscribePendingSpends(() => {});
    const other = new BroadcastChannel("pearl-pending-spends");
    const old = Date.now() - PENDING_SPEND_TTL_MS - 1;
    other.postMessage({ releases: Array.from({ length: 250 }, (_, i) => rel(i + 1, old)) });
    other.postMessage({ releases: [rel(9_999, Date.now())] });
    for (let i = 0; i < 50 && _pendingMemorySnapshotForTests().releases.length === 0; i++) await flush();
    expect(_pendingMemorySnapshotForTests().releases.map((r) => r.outpoint)).toEqual([rel(9_999, 0).outpoint]);
    other.close();
    unsub();
  });

  it("in-memory tombstones are pruned on read and bounded", () => {
    const now = Date.now();
    const old = now - PENDING_SPEND_TTL_MS - 1;
    _restorePendingMemoryForTests({
      memory: [],
      releases: [...Array.from({ length: 25_000 }, (_, i) => rel(i + 1, old)), rel(30_000, now)],
      intents: [],
    });
    pendingOutpoints(now);
    expect(_pendingMemorySnapshotForTests().releases).toHaveLength(1);
    _restorePendingMemoryForTests({
      memory: [],
      releases: Array.from({ length: 20_500 }, (_, i) => rel(i + 1, now)),
      intents: [],
    });
    pendingOutpoints(now);
    expect(_pendingMemorySnapshotForTests().releases.length).toBeLessThanOrEqual(20_000);
  });
});

// Kept to show nothing else changed: SubmissionInFlightError is the same
// error the UI handles.
describe("R3-5 — in-flight refusal keeps its error type", () => {
  it("forget refuses with SubmissionInFlightError", () => {
    const T = "1".repeat(64);
    reservePendingSpends(T, [OP(1)]);
    beginSubmission(T, []);
    expect(() => forgetPendingTransaction(T)).toThrow(SubmissionInFlightError);
  });
});
