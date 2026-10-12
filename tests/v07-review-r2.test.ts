// v0.7 review round 2 — regression tests for the confirmed findings:
//
//   R2-1  rejection classes after a maybe-delivered attempt; re-probe
//         before "absent" (the manual release rules are now tested in
//         tests/v07-pending-spends.test.ts)
//   R2-2  broadcast acknowledgement must be this tx's txid; malformed
//         JSON-RPC error objects are "malformed", not chain rejections
//   R2-3  (superseded: no tombstones — one stored list, written only under
//         the broadcast lock)
//   R2-4  vault broadcasts go through the recorded path; vault coin
//         selection excludes pending coins and refuses capped history
//   R2-5  status-unknown payments persist and surface
//   R2-6  a body-read network drop on a read is retried
//   R2-8  every broadcast runs inside the cross-tab Web Lock
//   R2-9  overlapping submissions of the same tx are serialised
//   R2-10 consolidation re-check uses the plan's own address refs
//   R2-11 refresh window reaches the end of an inflated external list
//   R2-12 in-flight reads don't repopulate the history cache after clear
//   R2-13 a scan from before an address reset can't extend the lists

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { masterFromSeed, pearlBranchPath, pearlMultisigPath } from "../src/crypto/hd";
import { signPearlTxWithSeed, p2trScriptForInternalKey, type PearlUtxoSpec, type PearlTxRequest } from "../src/crypto/pearl-sign";
import { pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import { vaultDescriptorFromPubkeys } from "../src/chains/pearl/multisig";
import { bytesToHex } from "../src/crypto/descriptor";
import * as workerClient from "../src/crypto/worker-client";
import {
  BroadcastStatusUnknownError,
  PearlRpcMalformedResponseError,
  broadcastPearlTx,
  callPearlRpc,
  classifyBroadcastRejection,
  fetchPrlUtxos,
  rawTxId,
  _addressHistorySizeForTests,
} from "../src/services/pearl-rpc";
import {
  broadcastPearlPrecomposed,
  broadcastSignedPearlTx,
  loadSpendableUtxos,
  HistoryIncompleteError,
  type ComposedPearlTx,
} from "../src/services/pearl-tx";
import {
  broadcastRecords,
  clearPendingSpends,
  pendingOutpoints,
  unresolvedBroadcasts,
  withBroadcastLock,
  BroadcastRefusedError,
  PendingSpendConflictError,
} from "../src/services/pending-spends";
import { checkBroadcast } from "../src/services/broadcast-status";
import { addRecord, useFakeLocks, useMemoryStorage } from "./helpers/broadcast-env";
import { composeConsolidation, recheckConsolidationBatch } from "../src/services/pearl-consolidate";
import {
  broadcastPendingTx,
  broadcastVaultTx,
  composeVaultSend,
  descriptorFromRecord,
  finalizeVaultPsbt,
} from "../src/services/multisig";
import { db, type VaultPendingTxRecord, type VaultRecord } from "../src/storage/db";
import { clearBalanceMemory } from "../src/state/balance-memory";
import { planPrlScan, PRL_REFRESH_WINDOW, PRL_REFRESH_WINDOW_EXTERNAL } from "../src/ui/hooks/useWalletBalances";
import { useUI } from "../src/state/ui-store";
import { useWallet } from "../src/state/wallet-store";
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
  useMemoryStorage();
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
function spec(branch: HdBranch, index: number, value: bigint, n: number): PearlUtxoSpec {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, valueGrains: value.toString(), scriptHex: scriptOf(branch, index), branch, index };
}
/** A real signed raw tx: two inputs, one output, fee = 1,000 grains. */
function signedFixture(n0 = 1) {
  const ins = [spec(0, 1, 60_000n, n0), spec(1, 2, 41_000n, n0 + 1)];
  const req: PearlTxRequest = { utxos: ins, outputs: [{ address: DEST, amountGrains: "100000" }], network: "mainnet", maxFeeGrains: (ins.reduce((a, u) => a + BigInt(u.valueGrains), 0n) - 100_000n).toString() };
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

/** A signed tx through the one recorded broadcast path. */
const broadcastRecordingSpends = (raw: string, _ins?: unknown) => broadcastSignedPearlTx(raw, { kind: "offline" });

// ─── R2-1 ────────────────────────────────────────────────────────────────

describe("R2-1 — rejection classes after a possibly delivered attempt", () => {
  it("classifies content-deterministic vs state-dependent reasons (unrecognised = state-dependent)", () => {
    const det = [
      "rpc -26: min relay fee not met",
      "rpc -26: TX rejected: transaction abc has 100 fees which is under the required amount of 200",
      "rpc -26: TX rejected: transaction abc has insufficient priority",
      "rpc -26: dust",
      "rpc -26: TX rejected: transaction output 0: payment of 10 is dust",
      "rpc -26: non-mandatory-script-verify-flag (Invalid Schnorr signature)",
      "rpc -26: TX rejected: transaction abc is not standard: version",
      "rpc -26: bad-txns-in-belowout",
      "rpc -26: tx-size",
    ];
    const state = [
      "rpc -26: bad-txns-inputs-missingorspent",
      "rpc -25: missing-inputs",
      "rpc -26: TX rejected: output abc:0 already spent by transaction def in the memory pool",
      "rpc -25: TX rejected: orphan transaction abc references outputs of unknown or fully-spent transaction def",
      "rpc -26: txn-mempool-conflict",
      "rpc -26: insufficient fee, rejecting replacement",
      "rpc -26: non-final",
      "rpc -26: too-long-mempool-chain",
      "rpc -26: something nobody has seen before",
    ];
    for (const m of det) expect(classifyBroadcastRejection(new Error(m)), m).toBe("deterministic");
    for (const m of state) expect(classifyBroadcastRejection(new Error(m)), m).toBe("state-dependent");
  });

  const stateReasons = [
    "bad-txns-inputs-missingorspent",
    "missing-inputs",
    "TX rejected: output x:0 already spent by transaction y in the memory pool",
    "TX rejected: orphan transaction x references outputs of unknown or fully-spent transaction y",
    "txn-mempool-conflict",
    "an unrecognised reason",
  ];
  for (const reason of stateReasons) {
    it(`503 then "${reason}", node says absent twice → status unknown, inputs stay reserved`, async () => {
      const { raw, ins, txid } = signedFixture();
      let n = 0;
      const calls = stubRpc((m) => (m === "getrawtransaction" ? NO_TX() : ++n === 1 ? BUSY() : rpcErr(-26, reason)));
      const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
      expect((err as BroadcastStatusUnknownError).txid).toBe(txid);
      expect(calls.filter((c) => c === "getrawtransaction")).toHaveLength(2);
      expect(pendingOutpoints().size).toBe(2);
    });
  }

  for (const reason of ["min relay fee not met", "dust", "mandatory-script-verify-flag-failed"]) {
    it(`503 then deterministic "${reason}", absent on both probes → plain rejection, reservation released`, async () => {
      const { raw, ins } = signedFixture();
      let n = 0;
      const calls = stubRpc((m) => (m === "getrawtransaction" ? NO_TX() : ++n === 1 ? BUSY() : rpcErr(-26, reason)));
      const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(BroadcastStatusUnknownError);
      expect((err as Error).message).toContain(reason);
      expect(calls.filter((c) => c === "getrawtransaction")).toHaveLength(2);
      expect(pendingOutpoints().size).toBe(0);
    });
  }

  it("delayed found: absent on the first probe, found on the re-probe → success", async () => {
    const { raw, ins, txid } = signedFixture();
    let n = 0;
    let probes = 0;
    stubRpc((m) => {
      if (m === "getrawtransaction") return ++probes === 1 ? NO_TX() : ok(raw);
      return ++n === 1 ? BUSY() : rpcErr(-26, "min relay fee not met");
    });
    await expect(broadcastRecordingSpends(raw, ins)).resolves.toBe(txid);
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid, state: "accepted" })]);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("deterministic reason but the re-probe can't tell → status unknown", async () => {
    const { raw, ins } = signedFixture();
    let n = 0;
    let probes = 0;
    stubRpc((m) => {
      if (m === "getrawtransaction") return ++probes === 1 ? NO_TX() : new Response("", { status: 400 });
      return ++n === 1 ? BUSY() : rpcErr(-26, "dust");
    });
    await expect(broadcastRecordingSpends(raw, ins)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("first-contact rejection (nothing delivered before) stays a plain failure without probing", async () => {
    const { raw, ins } = signedFixture();
    const calls = stubRpc(() => rpcErr(-26, "bad-txns-inputs-missingorspent"));
    const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(calls).not.toContain("getrawtransaction");
    expect(pendingOutpoints().size).toBe(0);
  });
});

// ─── R2-2 ────────────────────────────────────────────────────────────────

describe("R2-2 — the broadcast acknowledgement must name this transaction", () => {
  const shapes: Array<[string, (txid: string) => unknown]> = [
    ["empty string", () => ""],
    ["true", () => true],
    ["object", () => ({})],
    ["another 64-hex txid", () => "cd".repeat(32)],
    ["a number", () => 7],
  ];
  for (const [label, result] of shapes) {
    it(`result = ${label}, node doesn't have the tx → status unknown, reserved`, async () => {
      const { raw, ins, txid } = signedFixture();
      stubRpc((m) => (m === "sendrawtransaction" ? ok(result(txid)) : NO_TX()));
      const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
      expect((err as BroadcastStatusUnknownError).txid).toBe(txid);
      expect(pendingOutpoints().size).toBe(2);
    });
    it(`result = ${label}, node holds the tx → success with the local txid`, async () => {
      const { raw, txid } = signedFixture();
      stubRpc((m) => (m === "sendrawtransaction" ? ok(result(txid)) : ok(raw)));
      await expect(broadcastPearlTx(raw)).resolves.toBe(txid);
    });
  }

  it("the tx's own txid (any case) is accepted without probing", async () => {
    const { raw, txid } = signedFixture();
    const calls = stubRpc((m) => (m === "sendrawtransaction" ? ok(txid.toUpperCase()) : NO_TX()));
    await expect(broadcastPearlTx(raw)).resolves.toBe(txid);
    expect(calls).not.toContain("getrawtransaction");
  });

  const errorShapes: Array<[string, unknown]> = [
    ["a bare string", "x"],
    ["code as string", { code: "-26", message: "x" }],
    ["no message", { code: -26 }],
    ["fractional code", { code: 1.5, message: "x" }],
    ["true", true],
  ];
  for (const [label, error] of errorShapes) {
    it(`HTTP 200 with error = ${label} → status unknown on broadcast (never released)`, async () => {
      const { raw, ins } = signedFixture();
      stubRpc((m) => (m === "sendrawtransaction" ? new Response(JSON.stringify({ result: null, error })) : NO_TX()));
      await expect(broadcastRecordingSpends(raw, ins)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
      expect(pendingOutpoints().size).toBe(2);
    });
    it(`HTTP 200 with error = ${label} → malformed response on a read`, async () => {
      stubRpc(() => new Response(JSON.stringify({ result: null, error })));
      await expect(callPearlRpc("getblockcount", [])).rejects.toBeInstanceOf(PearlRpcMalformedResponseError);
    });
  }
});

// ─── R2-4 ────────────────────────────────────────────────────────────────

interface Cosigner {
  xOnlyPubkey: Uint8Array;
  privateKey: Uint8Array;
  originPath: string;
}
function cosigners(): Cosigner[] {
  return [0, 1, 2].map((i) => {
    const path = pearlMultisigPath(0, i);
    const child = master.derive(path);
    return { xOnlyPubkey: child.publicKey!.slice(1), privateKey: child.privateKey!, originPath: path };
  });
}
function vaultRecord(cs: Cosigner[]): VaultRecord {
  const desc = vaultDescriptorFromPubkeys(2, cs.map((c) => c.xOnlyPubkey), params);
  return {
    id: "vault-r2",
    version: 1,
    label: "Vault",
    threshold: 2,
    total: cs.length,
    sortedPubkeysHex: desc.sortedPubkeys.map((p) => bytesToHex(p)),
    myPubkeyHex: bytesToHex(cs[0]!.xOnlyPubkey),
    myOriginPath: cs[0]!.originPath,
    myVaultAccount: 0,
    myKeyIndex: 0,
    pearlAddress: desc.address,
    network: "mainnet",
    createdAt: Date.now(),
  };
}
const PREV = new Uint8Array(32).fill(0x33);
function signedVaultPsbt(rec: VaultRecord, cs: Cosigner[], amount: bigint, sum: bigint): string {
  const desc = descriptorFromRecord(rec);
  const network = { bech32: params.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  tx.addInput({
    txid: PREV,
    index: 0,
    witnessUtxo: { amount: sum, script: desc.outputScript },
    tapInternalKey: desc.internalKey,
    tapLeafScript: desc.tapLeafScript,
  });
  tx.addOutputAddress(rec.pearlAddress, amount, network);
  for (const c of [cs[0]!, cs[2]!]) for (let i = 0; i < tx.inputsLength; i++) tx.signIdx(c.privateKey, i);
  return base64.encode(tx.toPSBT());
}
const PREV_OUTPOINT = { txid: hex(PREV), vout: 0 };

describe("R2-4 — vault broadcasts use the recorded path", () => {
  it("broadcastVaultTx records the decoded inputs; a coin pending for another tx is refused unsent", async () => {
    const cs = cosigners();
    const rec = vaultRecord(cs);
    const { rawHex } = finalizeVaultPsbt(signedVaultPsbt(rec, cs, 90_000n, 100_000n));
    const txid = rawTxId(rawHex)!;
    const calls = stubRpc((m, p) => (m === "sendrawtransaction" ? ok(rawTxId(p[0] as string)) : NO_TX()));
    await expect(broadcastVaultTx(rawHex, rec.pearlAddress)).resolves.toBe(txid);
    expect(broadcastRecords()).toEqual([
      expect.objectContaining({ txid, kind: "vault", addresses: [rec.pearlAddress], destination: rec.pearlAddress, state: "accepted" }),
    ]);
    expect(pendingOutpoints().has(`${PREV_OUTPOINT.txid}:0`)).toBe(true);

    clearPendingSpends();
    calls.length = 0;
    addRecord("e".repeat(64), [PREV_OUTPOINT]);
    await expect(broadcastVaultTx(rawHex, rec.pearlAddress)).rejects.toBeInstanceOf(PendingSpendConflictError);
    expect(calls).not.toContain("sendrawtransaction");
  });

  it("broadcastPendingTx goes through the recorded path; a conflict leaves the draft untouched", async () => {
    const cs = cosigners();
    const rec = vaultRecord(cs);
    const psbt = signedVaultPsbt(rec, cs, 90_000n, 100_000n);
    const pending: VaultPendingTxRecord = {
      id: "p1",
      vaultId: rec.id,
      psbtBase64: psbt,
      signersHex: [],
      createdAt: 1,
      updatedAt: 1,
      status: "ready",
      preview: { destination: rec.pearlAddress, amountGrains: "90000", feeGrains: "10000", changeGrains: "0", inputCount: 1 },
    };
    const put = vi.spyOn(db.vaultPendingTxs, "put").mockResolvedValue("p1" as never);
    addRecord("e".repeat(64), [PREV_OUTPOINT]);
    const calls = stubRpc((m, p) => (m === "sendrawtransaction" ? ok(rawTxId(p[0] as string)) : NO_TX()));
    await expect(broadcastPendingTx({ vault: rec, pending })).rejects.toBeInstanceOf(PendingSpendConflictError);
    expect(calls).not.toContain("sendrawtransaction");
    expect(put).not.toHaveBeenCalled();

    clearPendingSpends();
    const done = await broadcastPendingTx({ vault: rec, pending });
    expect(done.status).toBe("broadcast");
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid: done.txid, kind: "vault", state: "accepted" })]);
  });
});

describe("R2-4 — vault coin selection", () => {
  const SCRIPT = "5120" + "00".repeat(32);
  function credit(address: string, n: number, value = 1) {
    return { txid: n.toString(16).padStart(64, "0"), vin: [], vout: [{ value, n: 0, scriptPubKey: { address, hex: SCRIPT } }] };
  }
  function stubVault(address: string, txs: unknown[], pageSize = 100) {
    stubRpc((m, p) => {
      if (m !== "searchrawtransactions" || p[0] !== address) return rpcErr(-32601, "nope");
      const skip = p[2] as number;
      const page = txs.slice(skip, skip + pageSize);
      return page.length === 0 ? rpcErr(-5, "No information available about address") : ok(page);
    });
  }

  it("excludes coins a recent broadcast already spends", async () => {
    const rec = vaultRecord(cosigners());
    stubVault(rec.pearlAddress, [credit(rec.pearlAddress, 1, 5), credit(rec.pearlAddress, 2, 1)]);
    addRecord("e".repeat(64), [{ txid: (1).toString(16).padStart(64, "0"), vout: 0 }]);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ psbtBase64: "psbt" } as never);
    const c = await composeVaultSend({ vault: rec, destination: DEST, amountGrains: 50_000_000n });
    expect(c.utxos.map((u) => u.txid)).toEqual([(2).toString(16).padStart(64, "0")]);
    expect(c.pendingExcluded).toBe(1);
    // Every coin pending → nothing to spend.
    addRecord("d".repeat(64), [{ txid: (2).toString(16).padStart(64, "0"), vout: 0 }]);
    await expect(composeVaultSend({ vault: rec, destination: DEST, amountGrains: 1_000n })).rejects.toThrow(/E_NO_UTXOS/);
  });

  it("refuses a page-capped history instead of warning", async () => {
    const rec = vaultRecord(cosigners());
    // One oversized page (> MAX_RPC_PAGE_LENGTH) marks the walk capped.
    stubVault(rec.pearlAddress, Array.from({ length: 501 }, (_, i) => credit(rec.pearlAddress, i + 1)), 1_000);
    const call = vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ psbtBase64: "psbt" } as never);
    await expect(composeVaultSend({ vault: rec, destination: DEST, amountGrains: 1_000n })).rejects.toBeInstanceOf(
      HistoryIncompleteError,
    );
    expect(call).not.toHaveBeenCalled();
  });
});

// ─── R2-5 ────────────────────────────────────────────────────────────────

describe("R2-5 — status-unknown payments stay visible after leaving Send", () => {
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

  it("records {txid, destination, amount, kind} before submission; a found check resolves it", async () => {
    const { raw, ins, txid } = signedFixture(21);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw } as never);
    stubRpc(() => {
      throw new TypeError("network connection lost");
    });
    await expect(
      broadcastPearlPrecomposed({ composed: composedFrom(ins), composedAt: Date.now() }, "mainnet"),
    ).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    // Stored (a reload reads the same list — there is no other copy).
    expect(unresolvedBroadcasts()).toEqual([
      expect.objectContaining({ txid, kind: "payment", destination: DEST.toLowerCase(), amountGrains: "100000", state: "unknown" }),
    ]);
    expect(pendingOutpoints().size).toBe(2);

    // The node turns out to hold it: accepted, coins stay reserved.
    stubRpc((m) => (m === "getrawtransaction" ? ok(raw) : NO_TX()));
    await expect(checkBroadcast(txid)).resolves.toBe("found");
    expect(unresolvedBroadcasts()).toEqual([]);
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid, state: "accepted" })]);
    expect(pendingOutpoints().size).toBe(2);
  });
});

// ─── R2-6 ────────────────────────────────────────────────────────────────

describe("R2-6 — a network drop while reading a 2xx body is transient for reads", () => {
  function droppedBody(): Response {
    return new Response(
      new ReadableStream({
        start(c) {
          c.error(new TypeError("terminated"));
        },
      }),
    );
  }

  it("is retried on the same endpoint", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => (++n === 1 ? droppedBody() : ok(123)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callPearlRpc("getblockcount", [])).resolves.toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a cut response during an address walk no longer fails the address", async () => {
    let n = 0;
    stubRpc(() => (++n === 1 ? droppedBody() : rpcErr(-5, "No information available about address")));
    await expect(fetchPrlUtxos("prl1paddr")).resolves.toMatchObject({ used: false });
  });

  it("a broadcast still treats it as possibly delivered (status unknown, never a plain failure)", async () => {
    const { raw, ins } = signedFixture(31);
    stubRpc((m) => (m === "sendrawtransaction" ? droppedBody() : NO_TX()));
    await expect(broadcastRecordingSpends(raw, ins)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(pendingOutpoints().size).toBe(2);
  });
});

// ─── R2-8 ────────────────────────────────────────────────────────────────

describe("R2-8 — every broadcast runs inside the cross-tab lock", () => {
  it("one 'pearl-wallet-broadcast' lock per broadcast, held until the outcome is saved", async () => {
    const locks = useFakeLocks();
    const { raw, ins } = signedFixture(41);
    let heldDuringSend = false;
    stubRpc(() => {
      heldDuringSend = locks.isHeld("pearl-wallet-broadcast");
      return rpcErr(-26, "min relay fee not met");
    });
    await expect(broadcastRecordingSpends(raw, ins)).rejects.toThrow(/min relay fee/);
    expect(locks.requests).toEqual(["pearl-wallet-broadcast"]);
    expect(heldDuringSend).toBe(true);
    expect(pendingOutpoints().size).toBe(0);
  });

  it("a lock that can't be granted refuses; nothing runs (fail closed)", async () => {
    vi.stubGlobal("navigator", { locks: { request: async () => Promise.reject(new Error("SecurityError")) } });
    const ran = vi.fn(async () => 1);
    await expect(withBroadcastLock(ran)).rejects.toMatchObject({ reason: "busy" });
    await expect(withBroadcastLock(ran)).rejects.toBeInstanceOf(BroadcastRefusedError);
    expect(ran).not.toHaveBeenCalled();
  });
});

// ─── R2-9 ────────────────────────────────────────────────────────────────

describe("R2-9 — overlapping submissions of the same transaction are serialised", () => {
  function controlled(raw: string) {
    const answers = [deferred<Response>(), deferred<Response>()];
    let n = 0;
    stubRpc((m) => (m === "sendrawtransaction" ? answers[n++]!.promise : NO_TX()));
    return { answers, txid: rawTxId(raw)! };
  }

  it("rejection first, then success: the coins stay reserved", async () => {
    const { raw, ins } = signedFixture(51);
    const { answers, txid } = controlled(raw);
    const a = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    const b = broadcastRecordingSpends(raw, ins);
    await flush();
    answers[0]!.resolve(rpcErr(-26, "min relay fee not met"));
    expect(await a).toBeInstanceOf(Error);
    expect(pendingOutpoints().size).toBe(2); // b still in flight
    answers[1]!.resolve(ok(txid));
    await expect(b).resolves.toBe(txid);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("success first, then rejection: the coins stay reserved", async () => {
    const { raw, ins } = signedFixture(53);
    const { answers, txid } = controlled(raw);
    const a = broadcastRecordingSpends(raw, ins);
    const b = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    await flush();
    answers[0]!.resolve(ok(txid));
    await expect(a).resolves.toBe(txid);
    answers[1]!.resolve(rpcErr(-26, "min relay fee not met"));
    expect(await b).toBeInstanceOf(Error);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("the second waits for the first; both rejected → released", async () => {
    const { raw, ins } = signedFixture(55);
    const { answers } = controlled(raw);
    const a = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    const b = broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    await flush();
    // Only the first has been submitted.
    answers[1]!.resolve(rpcErr(-26, "min relay fee not met"));
    await flush();
    expect(pendingOutpoints().size).toBe(2);
    answers[0]!.resolve(rpcErr(-26, "min relay fee not met"));
    await a;
    await b;
    expect(pendingOutpoints().size).toBe(0);
  });
});

// ─── R2-10 ───────────────────────────────────────────────────────────────

describe("R2-10 — later consolidation batches don't depend on persisted discovery", () => {
  it("re-checks with the plan's own refs when persisting discovered addresses failed", async () => {
    const SCRIPT = "5120" + "00".repeat(32);
    const addr = (b: number, i: number) => `addr-${b}-${i}`;
    const fund = (a: string, n: number) => ({
      txid: n.toString(16).padStart(64, "0"),
      vin: [],
      vout: [{ value: 10, n: 0, scriptPubKey: { address: a, hex: SCRIPT } }],
    });
    const history: Record<string, unknown[]> = { [addr(0, 5)]: [fund(addr(0, 5), 1)], [addr(0, 25)]: [fund(addr(0, 25), 2)] };
    stubRpc((m, p) => {
      const list = history[p[0] as string] ?? [];
      const page = list.slice(p[2] as number, (p[2] as number) + 100);
      return page.length === 0 ? rpcErr(-5, "No information available about address") : ok(page);
    });
    const ext = Array.from({ length: 20 }, (_, i) => addr(0, i));
    const int = Array.from({ length: 20 }, (_, i) => addr(1, i));
    const live = await loadSpendableUtxos({
      pool: ext,
      changePool: int,
      deriveMore: async (b, start, count) => Array.from({ length: count }, (_, i) => addr(b, start + i)),
      onDiscovered: async () => {
        throw new Error("keystore write failed");
      },
    });
    expect(live.utxos.map((u) => u.index).sort((a, b) => a - b)).toEqual([5, 25]);
    expect(live.refs.some((r) => r.address === addr(0, 25) && r.branch === 0 && r.index === 25)).toBe(true);
    const plan = composeConsolidation({ utxos: live.utxos, destination: { address: ext[0]!, branch: 0, index: 0 } });
    const batch = plan.batches[0]!;
    // The store still holds only the first 20 addresses of each branch.
    await expect(recheckConsolidationBatch(batch, { external: ext, internal: int })).rejects.toThrow(
      "E_CONSOLIDATION_RECHECK_INCOMPLETE",
    );
    await expect(recheckConsolidationBatch(batch, { external: ext, internal: int, refs: live.refs })).resolves.toEqual(
      expect.any(Number),
    );
  });
});

// ─── R2-11 ───────────────────────────────────────────────────────────────

describe("R2-11 — refresh walks every external address Receive may offer", () => {
  const base = { fullAt: 1_000_000, lastUsed: [5, 2] as [number, number], knownUnused: new Set<string>() };
  it("window reaches the end of an inflated persisted list", () => {
    expect(planPrlScan(base, base.fullAt + 1, false, 60)?.window).toEqual([54, PRL_REFRESH_WINDOW]);
    // max index 59 = lastUsed 5 + 54: not skippable.
  });
  it("never narrower than the gap limit", () => {
    expect(planPrlScan(base, base.fullAt + 1, false, 20)?.window).toEqual([PRL_REFRESH_WINDOW_EXTERNAL, PRL_REFRESH_WINDOW]);
    expect(planPrlScan(base, base.fullAt + 1, false)?.window).toEqual([PRL_REFRESH_WINDOW_EXTERNAL, PRL_REFRESH_WINDOW]);
  });
});

// ─── R2-12 ───────────────────────────────────────────────────────────────

describe("R2-12 — an in-flight read can't refill the history cache after a clear", () => {
  it("drops the write from a walk that started before lock / wipe / switch", async () => {
    const gate = deferred<Response>();
    stubRpc(() => gate.promise);
    const walk = fetchPrlUtxos("prl1pwalk");
    await flush();
    clearBalanceMemory();
    gate.resolve(ok([]));
    await walk;
    expect(_addressHistorySizeForTests()).toBe(0);
    // A walk that starts after the clear caches normally.
    stubRpc(() => ok([]));
    await fetchPrlUtxos("prl1pwalk");
    expect(_addressHistorySizeForTests()).toBe(1);
  });
});

// ─── R2-13 ───────────────────────────────────────────────────────────────

describe("R2-13 — a scan from before an address reset can't undo it", () => {
  afterEach(() => {
    useWallet.setState({ status: "locked", addresses: null });
  });

  it("a discovery handler bound before the reset is refused", async () => {
    useWallet.setState({
      status: "unlocked",
      addresses: { pearl: "e0", pearlPool: ["e0", "e1"], pearlChange: ["i0"], eth: "0x0" } as never,
    });
    const stale = useWallet.getState().pearlDiscoveryHandler();
    const before = useWallet.getState().pearlAddressGeneration;
    // resetPearlAddresses bumps the generation before anything else.
    await useWallet
      .getState()
      .resetPearlAddresses()
      .catch(() => false);
    expect(useWallet.getState().pearlAddressGeneration).toBe(before + 1);
    await expect(stale({ external: ["e0", "e1", "e2"], internal: ["i0"] })).resolves.toBe(false);
    expect(useWallet.getState().addresses?.pearlPool ?? []).not.toContain("e2");
    await expect(
      useWallet.getState().extendPearlAddresses({ external: ["e0", "e1", "e2"], internal: ["i0"] }, before),
    ).resolves.toBe(false);
  });
});
