// v0.7 review round 1 — regression tests for the confirmed findings:
//
//   S1  offline signer: real fee from inputs/outputs, untrusted meta fee,
//       signer-side fee bound
//   S2  freshness clocks start when the walk FINISHED; later consolidation
//       batches re-read only their own addresses
//   S3  (see tests/v019.test.ts) + cached live sets keep their warnings
//   S4  malformed / null HTTP-200 broadcast answers → status unknown
//   S5  edge-limit 503 is "not delivered"; a definitive rejection after a
//       maybe-delivered attempt is resolved by probing the txid
//   S6  (superseded: the broadcast record now fails closed instead of
//       keeping an in-memory copy — tests/v07-pending-spends.test.ts)
//   S7  one recorded path for Send, consolidation and offline broadcast
//   S15 price budget fits inside the client timeout
//   S16 lock / wipe / switch clears the RPC history cache and hooks

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { masterFromSeed, pearlBranchPath } from "../src/crypto/hd";
import { signPearlTxWithSeed, p2trScriptForInternalKey, type PearlUtxoSpec, type PearlTxRequest } from "../src/crypto/pearl-sign";
import { pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import * as workerClient from "../src/crypto/worker-client";
import * as pearlRpc from "../src/services/pearl-rpc";
import {
  BroadcastStatusUnknownError,
  broadcastPearlTx,
  probePearlTx,
  rawTxId,
  rawTxInputs,
  _addressHistorySizeForTests,
  fetchPrlUtxos,
} from "../src/services/pearl-rpc";
import {
  broadcastPearlPrecomposed,
  broadcastSignedPearlTx,
  composePearlSend,
  loadSpendableUtxos,
  type ComposedPearlTx,
} from "../src/services/pearl-tx";
import {
  broadcastRecords,
  clearPendingSpends,
  pendingOutpoints,
} from "../src/services/pending-spends";
import { addRecord, useMemoryStorage } from "./helpers/broadcast-env";
import {
  broadcastConsolidationBatch,
  composeConsolidation,
  recheckConsolidationBatch,
} from "../src/services/pearl-consolidate";
import { checkPearlUnsignedFee, type PearlUnsignedPayload } from "../src/lib/offline-signing/payload";
import { clearBalanceMemory, onBalanceMemoryClear } from "../src/state/balance-memory";
import { derivePrlState } from "../src/ui/hooks/useWalletBalances";
import { useUI } from "../src/state/ui-store";
import type { HdBranch } from "../src/crypto/hd";
import type { PrlPoolScan } from "../src/services/balances";

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
/** A signed tx through the one recorded broadcast path. */
const broadcastRecordingSpends = (raw: string, _ins?: unknown) => broadcastSignedPearlTx(raw, { kind: "offline" });
const NGINX_503 =
  "<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body>\r\n<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n<hr><center>nginx/1.24.0</center>\r\n</body>\r\n</html>\r\n";

// ─── S1 ──────────────────────────────────────────────────────────────────

describe("S1 — offline signer shows and binds the real fee", () => {
  const payload = (meta?: PearlUnsignedPayload["meta"]): PearlUnsignedPayload => ({
    v: 1,
    k: "pearl-unsigned",
    network: "mainnet",
    utxos: [
      { txid: "a".repeat(64), vout: 0, valueGrains: "100000000", scriptHex: "5120" + "00".repeat(32), poolIndex: 0 },
    ],
    outputs: [{ address: "prl1pdest", amountGrains: "50000000" }],
    ...(meta ? { meta } : {}),
  });

  it("metadata that understates the fee is flagged; the computed fee is what is shown and acknowledged", () => {
    // Watcher claims 1,000 grains; inputs − outputs is 0.5 PRL.
    const c = checkPearlUnsignedFee(payload({ feeGrains: "1000" }));
    expect(c.feeGrains).toBe(50_000_000n);
    expect(c.claimedFeeGrains).toBe(1_000n);
    expect(c.claimMismatch).toBe(true);
    expect(c.highFee).toBe(true);
    expect(c.needsAck).toBe(true);
  });

  it("an honest, small fee needs no acknowledgement", () => {
    const p = payload({ feeGrains: "10000" });
    p.outputs = [{ address: "prl1pdest", amountGrains: "99990000" }];
    const c = checkPearlUnsignedFee(p);
    expect(c).toMatchObject({ feeGrains: 10_000n, valid: true, claimMismatch: false, highFee: false, needsAck: false });
  });

  it("outputs ≥ inputs is invalid (and the signer refuses it)", () => {
    const p = payload();
    p.outputs = [{ address: "prl1pdest", amountGrains: "100000000" }];
    expect(checkPearlUnsignedFee(p).valid).toBe(false);
    const ins = [spec(0, 1, 50_000n, 1)];
    expect(() =>
      signPearlTxWithSeed(seed, { utxos: ins, outputs: [{ address: DEST, amountGrains: "50000" }], network: "mainnet" }),
    ).toThrow("E_PEARL_FEE");
  });

  it("the signer refuses a fee above the reviewed ceiling and signs at or below it", () => {
    const ins = [spec(0, 1, 60_000n, 1), spec(1, 2, 41_000n, 2)];
    const outputs = [{ address: DEST, amountGrains: "100000" }]; // fee 1,000
    expect(() => signPearlTxWithSeed(seed, { utxos: ins, outputs, network: "mainnet", maxFeeGrains: "999" })).toThrow(
      "E_PEARL_FEE_ABOVE_LIMIT",
    );
    expect(() => signPearlTxWithSeed(seed, { utxos: ins, outputs, network: "mainnet", maxFeeGrains: "-1" })).toThrow(
      "E_PEARL_FEE_LIMIT_SHAPE",
    );
    expect(signPearlTxWithSeed(seed, { utxos: ins, outputs, network: "mainnet", maxFeeGrains: "1000" }).raw).toMatch(/^[0-9a-f]+$/);
  });

  it("online Send passes the reviewed fee to the signer as its ceiling", async () => {
    let sent: PearlTxRequest | null = null;
    vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async (_cmd: string, args: { req: PearlTxRequest }) => {
      sent = args.req;
      return signPearlTxWithSeed(seed, args.req);
    }) as never);
    stubRpc((m, p) => (m === "sendrawtransaction" ? ok(rawTxId(p[0] as string)) : rpcErr(-32601, "nope")));
    const composed: ComposedPearlTx = {
      utxos: [{ txid: "01".padStart(64, "0"), vout: 0, valueGrains: 60_000n, scriptHex: scriptOf(0, 1), branch: 0, index: 1 }],
      outputs: [{ address: DEST, amountGrains: 59_000n }],
      amountGrains: 59_000n,
      feeGrains: 1_000n,
      tipGrains: 0n,
      changeGrains: 0n,
      degraded: false,
      historyIncomplete: 0,
      spendableGrains: 60_000n,
      spendableUtxoCount: 1,
    };
    await broadcastPearlPrecomposed({ composed, composedAt: Date.now() }, "mainnet");
    expect(sent!.maxFeeGrains).toBe("1000");
  });
});

// ─── S2 ──────────────────────────────────────────────────────────────────

describe("S2 — review clocks start when the walk finished", () => {
  it("loadSpendableUtxos stamps fetchedAt after the last address was read", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      clock += 60_000; // a paced walk: one minute per address
      return {
        utxos: addr === "a0" ? [{ txid: "c".repeat(64), vout: 0, valueGrains: 5_000_000n, scriptHex: "5120" + "00".repeat(32) }] : [],
        degraded: false,
        droppedNoScript: 0,
        used: addr === "a0",
      };
    });
    const start = clock;
    const live = await loadSpendableUtxos({ pool: ["a0", "a1", "a2"] });
    expect(live.fetchedAt).toBe(start + 180_000);
    expect(live.fetchedAt).toBe(clock);
  });

  it("a later consolidation batch re-reads only its own addresses; incomplete reads refuse", async () => {
    const coin = (n: number, branch: HdBranch, index: number) => ({
      txid: n.toString(16).padStart(64, "0"),
      vout: 0,
      valueGrains: 10_000_000n,
      scriptHex: "5120" + "00".repeat(32),
      branch,
      index,
    });
    const coins = [coin(1, 0, 3), coin(2, 1, 1), coin(3, 0, 3)];
    const plan = composeConsolidation({ utxos: coins, destination: { address: "e0", branch: 0, index: 0 } });
    expect(plan.batches).toHaveLength(1);
    const book = { external: ["e0", "e1", "e2", "e3"], internal: ["i0", "i1"] };
    const read: string[] = [];
    let capped = false;
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      read.push(addr);
      const mine = coins.filter((c) => (c.branch === 1 ? book.internal : book.external)[c.index] === addr);
      return {
        utxos: mine.map(({ txid, vout, valueGrains, scriptHex }) => ({ txid, vout, valueGrains, scriptHex })),
        degraded: capped,
        droppedNoScript: 0,
        used: true,
      };
    });
    const at = await recheckConsolidationBatch(plan.batches[0]!, book, { now: () => 42 });
    expect(at).toBe(42);
    expect(read.sort()).toEqual(["e3", "i1"]);
    capped = true;
    await expect(recheckConsolidationBatch(plan.batches[0]!, book)).rejects.toThrow("E_CONSOLIDATION_RECHECK_INCOMPLETE");
    capped = false;
    addRecord("f".repeat(64), [coins[1]!]);
    await expect(recheckConsolidationBatch(plan.batches[0]!, book)).rejects.toThrow("E_CONSOLIDATION_INPUTS_CHANGED");
  });

  it("the consolidation plan explains coins the snapshot already split off as pending", () => {
    const coins = [0, 1, 2].map((n) => ({
      txid: (n + 1).toString(16).padStart(64, "0"),
      vout: 0,
      valueGrains: 10_000_000n,
      scriptHex: "5120" + "00".repeat(32),
      branch: 0 as const,
      index: 0,
    }));
    const plan = composeConsolidation({
      utxos: coins,
      destination: { address: "e0", branch: 0, index: 0 },
      pendingAlreadyExcluded: 4,
    });
    expect(plan.pendingExcluded).toBe(4);
  });
});

// ─── S3 ──────────────────────────────────────────────────────────────────

describe("S3 — a live set passed back as cachedUtxos keeps its warnings", () => {
  it("cachedFrom carries degraded / historyIncomplete into the composed tx", async () => {
    const utxos = [
      { txid: "d".repeat(64), vout: 0, valueGrains: 900_000_000n, scriptHex: "5120" + "00".repeat(32), branch: 0 as const, index: 0 },
    ];
    const c = await composePearlSend({
      network: "mainnet",
      pool: ["a0"],
      destination: DEST,
      amountGrains: 100_000_000n,
      includeTip: false,
      cachedUtxos: utxos,
      cachedFrom: { degraded: true, historyIncomplete: 2 },
    });
    expect(c.degraded).toBe(true);
    expect(c.historyIncomplete).toBe(2);
  });
});

// ─── S4 / S5 ─────────────────────────────────────────────────────────────

describe("S4 — a 2xx with an unusable body is 'status unknown', never a plain failure", () => {
  const bodies: Array<[string, () => Response]> = [
    ["null JSON", () => new Response("null")],
    ["invalid JSON", () => new Response("<html>gateway</html>")],
    ["truncated body", () => new Response('{"result":"ab')],
    ["null result", () => new Response(JSON.stringify({ result: null, error: null }))],
  ];
  for (const [label, body] of bodies) {
    it(`${label} → BroadcastStatusUnknownError with the local txid; inputs stay reserved`, async () => {
      const { raw, ins, txid } = signedFixture();
      stubRpc((m) => (m === "sendrawtransaction" ? body() : rpcErr(-5, "No information available about transaction")));
      const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
      expect((err as BroadcastStatusUnknownError).txid).toBe(txid);
      expect(pendingOutpoints().size).toBe(2);
    });
  }

  it("a malformed 2xx whose txid the node then reports holding is a success", async () => {
    const { raw, txid } = signedFixture();
    stubRpc((m) => (m === "sendrawtransaction" ? new Response("null") : ok(raw)));
    await expect(broadcastPearlTx(raw)).resolves.toBe(txid);
  });

  it("reads keep the old 'rpc null result' message", async () => {
    stubRpc(() => new Response(JSON.stringify({ result: null, error: null })));
    await expect(pearlRpc.callPearlRpc("getblockcount", [])).rejects.toThrow("rpc null result");
  });
});

describe("S5 — edge 503s and definitive rejections after a maybe-delivered attempt", () => {
  // Final round (S3): a proxy's stock 503 page is no longer trusted as
  // "never forwarded" — a proxy that intercepts upstream errors serves the
  // same page after the node accepted the tx. It is "maybe delivered".
  it("nginx 503 page then -26 missingorspent, probe absent → status unknown, inputs stay reserved", async () => {
    const { raw, ins } = signedFixture();
    let n = 0;
    const calls = stubRpc((m) => {
      if (m === "getrawtransaction") return rpcErr(-5, "No information available about transaction");
      return ++n === 1 ? new Response(NGINX_503, { status: 503 }) : rpcErr(-26, "bad-txns-inputs-missingorspent");
    });
    const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
    expect(calls).toContain("getrawtransaction");
    expect(pendingOutpoints().size).toBe(2);
  });

  it("only nginx 503 pages until the retry budget ends → status unknown, never a plain failure", async () => {
    const { raw, ins } = signedFixture();
    stubRpc((m) => (m === "getrawtransaction" ? rpcErr(-5, "No information available about transaction") : new Response(NGINX_503, { status: 503 })));
    const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
    expect(pendingOutpoints().size).toBe(2);
  });

  // Round 2 (R2-1): a plain (non-nginx) 503 stays "maybe delivered". A
  // state-dependent rejection after it can be the echo of our own accepted
  // tx, so an "absent" probe never turns it into a plain failure; only a
  // content-deterministic reason confirmed absent twice does.
  it("plain 503 then -26 missingorspent, probe says absent → status unknown, inputs stay reserved", async () => {
    const { raw, ins } = signedFixture();
    let n = 0;
    const calls = stubRpc((m) => {
      if (m === "getrawtransaction") return rpcErr(-5, "No information available about transaction");
      return ++n === 1 ? new Response("busy", { status: 503 }) : rpcErr(-26, "bad-txns-inputs-missingorspent");
    });
    const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BroadcastStatusUnknownError);
    expect(calls).toContain("getrawtransaction");
    expect(pendingOutpoints().size).toBe(2);
  });

  it("plain 503 then -26 min relay fee, probe says absent twice → plain rejection, nothing recorded", async () => {
    const { raw, ins } = signedFixture();
    let n = 0;
    const calls = stubRpc((m) => {
      if (m === "getrawtransaction") return rpcErr(-5, "No information available about transaction");
      return ++n === 1 ? new Response("busy", { status: 503 }) : rpcErr(-26, "min relay fee not met");
    });
    const err = await broadcastRecordingSpends(raw, ins).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(calls.filter((c) => c === "getrawtransaction")).toHaveLength(2);
    expect(pendingOutpoints().size).toBe(0);
  });

  it("plain 503 then -26, probe finds the tx → success", async () => {
    const { raw, ins, txid } = signedFixture();
    let n = 0;
    stubRpc((m) => {
      if (m === "getrawtransaction") return ok(raw);
      return ++n === 1 ? new Response("busy", { status: 503 }) : rpcErr(-26, "bad-txns-inputs-missingorspent");
    });
    await expect(broadcastRecordingSpends(raw, ins)).resolves.toBe(txid);
    expect(broadcastRecords()).toEqual([expect.objectContaining({ txid, state: "accepted" })]);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("plain 503 then -26, probe can't tell → status unknown, inputs reserved", async () => {
    const { raw, ins } = signedFixture();
    let n = 0;
    stubRpc((m) => {
      if (m === "getrawtransaction") return new Response("", { status: 500 });
      return ++n === 1 ? new Response("busy", { status: 503 }) : rpcErr(-26, "bad-txns-inputs-missingorspent");
    });
    await expect(broadcastRecordingSpends(raw, ins)).rejects.toBeInstanceOf(BroadcastStatusUnknownError);
    expect(pendingOutpoints().size).toBe(2);
  });

  it("probe 'found' requires the returned raw tx to hash to the txid", async () => {
    const a = signedFixture(1);
    const b = signedFixture(5);
    stubRpc(() => ok(b.raw));
    expect(await probePearlTx(a.txid)).toBe("unknown");
    expect(await probePearlTx(b.txid)).toBe("found");
    expect(await probePearlTx(null)).toBe("unknown");
  });
});

// ─── S7 ──────────────────────────────────────────────────────────────────

describe("S7 — one recorded path for every broadcast", () => {
  it("Send: a frozen preview whose coin became pending is refused before signing", async () => {
    const call = vi.spyOn(workerClient.cryptoWorker, "call");
    const coin = { txid: "01".padStart(64, "0"), vout: 0, valueGrains: 60_000n, scriptHex: scriptOf(0, 1), branch: 0 as const, index: 1 };
    addRecord("e".repeat(64), [coin]);
    const composed: ComposedPearlTx = {
      utxos: [coin],
      outputs: [{ address: DEST, amountGrains: 59_000n }],
      amountGrains: 59_000n,
      feeGrains: 1_000n,
      tipGrains: 0n,
      changeGrains: 0n,
      degraded: false,
      historyIncomplete: 0,
      spendableGrains: 60_000n,
      spendableUtxoCount: 1,
    };
    await expect(broadcastPearlPrecomposed({ composed, composedAt: Date.now() }, "mainnet")).rejects.toThrow("E_INPUT_PENDING");
    expect(call).not.toHaveBeenCalled();
  });

  it("consolidation: a coin taken by another broadcast while signing is never submitted", async () => {
    const coins = [1, 2].map((n) => ({
      txid: n.toString(16).padStart(64, "0"),
      vout: 0,
      valueGrains: 10_000_000n,
      scriptHex: "5120" + "00".repeat(32),
      branch: 0 as const,
      index: 0,
    }));
    const plan = composeConsolidation({ utxos: coins, destination: { address: "e0", branch: 0, index: 0 } });
    const { raw } = signedFixture(7);
    vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async () => {
      // A record of coin 2 appears while we sign (written around the lock):
      // the check repeated before recording still refuses.
      addRecord("9".repeat(64), [coins[1]!]);
      return { raw };
    }) as never);
    const calls = stubRpc(() => ok("x"));
    await expect(
      broadcastConsolidationBatch({ batch: plan.batches[0]!, verifiedAt: Date.now() }, "mainnet"),
    ).rejects.toThrow("E_CONSOLIDATION_INPUT_PENDING");
    expect(calls).not.toContain("sendrawtransaction");
  });

  it("offline broadcast decodes the inputs from the raw tx and records them", async () => {
    const { raw, ins, txid } = signedFixture(11);
    expect(rawTxInputs(raw)).toEqual(ins.map((u) => ({ txid: u.txid, vout: u.vout })));
    stubRpc((m, p) => (m === "sendrawtransaction" ? ok(rawTxId(p[0] as string)) : rpcErr(-32601, "nope")));
    await expect(broadcastSignedPearlTx(raw, { kind: "offline" })).resolves.toBe(txid);
    expect(broadcastRecords()).toEqual([
      expect.objectContaining({ txid, kind: "offline", destination: DEST.toLowerCase(), amountGrains: "100000", state: "accepted" }),
    ]);
    expect(pendingOutpoints().size).toBe(2);
    // The same signed tx may be re-broadcast (idempotent)…
    await expect(broadcastSignedPearlTx(raw, { kind: "offline" })).resolves.toBe(txid);
    await expect(broadcastSignedPearlTx("zz", { kind: "offline" })).rejects.toThrow("E_RAW_TX_PARSE");
  });

  it("offline broadcast: a definite rejection records nothing", async () => {
    const { raw } = signedFixture(13);
    stubRpc(() => rpcErr(-26, "min relay fee not met"));
    await expect(broadcastSignedPearlTx(raw, { kind: "offline" })).rejects.toThrow(/rpc -26/);
    expect(pendingOutpoints().size).toBe(0);
  });
});

// ─── S13 ─────────────────────────────────────────────────────────────────

describe("S13 — scan-level incompleteness makes the dashboard PRL status partial", () => {
  it("every address ok but discovery incomplete → partial", () => {
    const scan = {
      pool: ["a"],
      refs: [{ address: "a", branch: 0, index: 0 }],
      perAddress: [{ status: "ok", grains: 5n, degraded: false, utxos: [], used: true }],
      grains: 5n,
      failures: 0,
      degraded: true,
      source: "partial",
      spendable: null,
      startedAt: 1,
      finishedAt: 2,
      discovery: { complete: false, lastUsed: [0, -1], reasons: ["cap"] },
    } as unknown as PrlPoolScan;
    expect(derivePrlState(scan, new Map()).status).toBe("partial");
    const done = { ...scan, degraded: false, discovery: { complete: true, lastUsed: [0, -1], reasons: [] } } as unknown as PrlPoolScan;
    expect(derivePrlState(done, new Map()).status).toBe("ok");
  });
});

// ─── S16 ─────────────────────────────────────────────────────────────────

describe("S16 — lock / wipe / switch clears the session caches", () => {
  it("clearBalanceMemory empties the RPC history cache and runs registered hooks", async () => {
    stubRpc(() => rpcErr(-5, "No information available about address"));
    await fetchPrlUtxos("prl1pnohistory");
    expect(_addressHistorySizeForTests()).toBe(1);
    const hook = vi.fn();
    const off = onBalanceMemoryClear(hook);
    clearBalanceMemory();
    off();
    expect(_addressHistorySizeForTests()).toBe(0);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

// ─── S15 ─────────────────────────────────────────────────────────────────

describe("S15 — the price function answers inside the client's timeout", () => {
  it("client timeout exceeds the function's end-to-end upstream budget with margin", async () => {
    const { PRICE_FETCH_TIMEOUT_MS } = await import("../src/services/prices");
    const fn = await import("../functions/api/prl-price");
    expect(fn.OTC_TIMEOUT_MS).toBeLessThan(fn.UPSTREAM_TOTAL_BUDGET_MS);
    expect(PRICE_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(fn.UPSTREAM_TOTAL_BUDGET_MS + 2_000);
  });

  it("a hanging OTC book still yields the CoinGecko price within the budget", async () => {
    vi.useFakeTimers();
    try {
      const fn = await import("../functions/api/prl-price");
      fn._resetPriceCacheForTests();
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          if (String(url).includes("pearl-otc")) {
            return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
          }
          return Promise.resolve(new Response(JSON.stringify({ "pearl-2": { usd: 1.23 } })));
        }),
      );
      const started = Date.now();
      const p = fn.onRequestGet();
      await vi.advanceTimersByTimeAsync(fn.OTC_TIMEOUT_MS + 10);
      const r = await p;
      expect(Date.now() - started).toBeLessThanOrEqual(fn.UPSTREAM_TOTAL_BUDGET_MS);
      expect(await r.json()).toMatchObject({ usd_per_prl: 1.23, source: "coingecko" });
    } finally {
      vi.useRealTimers();
    }
  });
});
