// v0.7 review round 3 — regression tests for the confirmed findings:
//
//   R3-1  the broadcast is recorded before submission: a reload mid-broadcast
//         still shows it (write failures: tests/v07-pending-spends.test.ts)
//   R3-2  an HTTP refusal after a possibly delivered attempt is "unknown"
//   R3-3  destinations are recorded in one letter case
//   R3-4  an accepted re-broadcast resolves the record
//   R3-5…R3-9, R3-13  (superseded: attempts, leases, tombstones and memory
//         copies are gone; the lock and the single stored list replace
//         them — tests/v07-pending-spends.test.ts)
//   R3-10 one session epoch per scan; a cleared session launches no reads
//   R3-11 a scan begun during an address reset can't undo it
//   R3-12 vault compose offers one bounded deeper walk

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
import { broadcastRecorded, broadcastSignedPearlTx, HistoryIncompleteError } from "../src/services/pearl-tx";
import { broadcastRecords, clearPendingSpends, pendingOutpoints, unresolvedBroadcasts } from "../src/services/pending-spends";
import { useMemoryStorage } from "./helpers/broadcast-env";
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

/** A signed payment through the one recorded broadcast path. */
function broadcastRecordingSpends(raw: string, ins: { txid: string; vout: number }[], intent?: { destination: string; amountGrains: bigint }) {
  return broadcastRecorded(
    { kind: "payment", inputs: ins, destination: intent?.destination ?? null, amountGrains: intent?.amountGrains ?? null },
    raw,
  );
}
const banner = () => renderToStaticMarkup(createElement(PendingBroadcasts));

// ─── R3-1 ────────────────────────────────────────────────────────────────

describe("R3-1 — the broadcast is recorded before submission", () => {
  afterEach(() => {
    useWallet.setState({ status: "locked" });
  });

  it("reload during an in-flight submission: stored, shown in the banner, coins reserved", async () => {
    useWallet.setState({ status: "unlocked" });
    const { raw, ins, txid } = signedFixture(101);
    const answer = deferred<Response>();
    stubRpc((m) => (m === "sendrawtransaction" ? answer.promise : NO_TX()));
    const tabA = broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 100_000n }).catch((e: unknown) => e);
    await flush();
    // Storage is the only copy: what a reloaded tab reads.
    expect(unresolvedBroadcasts()).toEqual([
      expect.objectContaining({ txid, destination: DEST, amountGrains: "100000", state: "unknown" }),
    ]);
    expect(pendingOutpoints().size).toBe(2);
    expect(banner()).toContain("A broadcast needs checking");
    expect(banner()).toContain(txid);
    answer.resolve(ok(txid));
    await tabA;
    expect(unresolvedBroadcasts()).toEqual([]);
    expect(banner()).toBe("");
  });

  it("an accepted broadcast is kept as accepted; coins stay reserved", async () => {
    const { raw, ins, txid } = signedFixture(105);
    stubRpc(() => ok(txid));
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).resolves.toBe(txid);
    expect(unresolvedBroadcasts()).toEqual([]);
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid, state: "accepted" })]);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("a definite first-contact rejection removes the record", async () => {
    const { raw, ins } = signedFixture(107);
    stubRpc(() => rpcErr(-26, "min relay fee not met"));
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toThrow(/min relay fee/);
    expect(pendingOutpoints().size).toBe(0);
    expect(broadcastRecords()).toEqual([]);
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
    it(`transient → HTTP ${status} → absent twice ⇒ status unknown, record kept`, async () => {
      const { raw, ins, txid } = signedFixture(111);
      let n = 0;
      const calls = stubRpc((m) =>
        m === "getrawtransaction" ? NO_TX() : ++n === 1 ? BUSY() : new Response("refused", { status }),
      );
      const err = await broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
      expect(calls.filter((c) => c === "getrawtransaction")).toHaveLength(2);
      expect(pendingOutpoints().size).toBe(2);
      expect(unresolvedBroadcasts()).toEqual([expect.objectContaining({ txid, destination: DEST })]);
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

describe("R3-3 — destinations are recorded in one letter case", () => {
  it("the validator accepts both encodings", () => {
    expect(validPearl(DEST, "mainnet")).toBe(true);
    expect(validPearl(DEST.toUpperCase(), "mainnet")).toBe(true);
  });

  it("recorded upper-case (QR) is stored lower-case", async () => {
    const { raw, ins, txid } = signedFixture(123);
    stubRpc(DROP);
    await expect(
      broadcastRecordingSpends(raw, ins, { destination: ` ${DEST.toUpperCase()} `, amountGrains: 5n }),
    ).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(unresolvedBroadcasts()).toEqual([expect.objectContaining({ txid, destination: DEST })]);
  });
});

// ─── R3-4 ────────────────────────────────────────────────────────────────

describe("R3-4 — an accepted re-broadcast resolves the record", () => {
  it("unknown → re-broadcast of the same bytes (no acknowledgement needed) accepted → no unresolved entry", async () => {
    const { raw, ins, txid } = signedFixture(131);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    expect(unresolvedBroadcasts()).toHaveLength(1);
    // The vault / offline path re-broadcasts the same bytes.
    stubRpc(() => ok(txid));
    await expect(broadcastSignedPearlTx(raw, { kind: "offline" })).resolves.toBe(txid);
    expect(unresolvedBroadcasts()).toEqual([]);
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid, state: "accepted", destination: DEST })]);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("re-broadcast rejected after an unknown attempt: nothing released, record stays unknown", async () => {
    const { raw, ins } = signedFixture(133);
    stubRpc(DROP);
    await expect(broadcastRecordingSpends(raw, ins, { destination: DEST, amountGrains: 5n })).rejects.toBeInstanceOf(
      BroadcastStatusUnknownError,
    );
    stubRpc(() => rpcErr(-26, "min relay fee not met"));
    await expect(broadcastSignedPearlTx(raw, { kind: "offline" })).rejects.toThrow(/min relay fee/);
    expect(pendingOutpoints().size).toBe(2);
    expect(unresolvedBroadcasts()).toHaveLength(1);
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

