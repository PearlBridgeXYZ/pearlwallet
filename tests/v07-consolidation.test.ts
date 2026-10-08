// v0.7 B3 — UTXO consolidation: exact vsize, batch planning (smallest
// first, ≤ 500 inputs, < 100 kvB), dust and 2 %-fee skipping, money
// invariants, pending-spend exclusion, the worker's refusal of any
// non-own / multi-output / over-fee consolidation, and an end-to-end
// 300-input consolidation signed and verified with @scure/btc-signer.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { masterFromSeed, pearlAccountPath, pearlBranchPath, publicAccountNode, type HdBranch } from "../src/crypto/hd";
import { pearlBranchAddressRange } from "../src/crypto/pearl-addresses";
import {
  signPearlConsolidationWithSeed,
  p2trScriptForInternalKey,
  MAX_PEARL_SIGN_INPUTS,
  CONSOLIDATION_MAX_FEE_NUM as SIGNER_FEE_NUM,
  CONSOLIDATION_MAX_FEE_DEN as SIGNER_FEE_DEN,
  type PearlConsolidationRequest,
  type PearlUtxoSpec,
} from "../src/crypto/pearl-sign";
import { decodeTaprootAddress, pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import { tipAddressFor } from "../src/chains/pearl/tip";
import * as workerClient from "../src/crypto/worker-client";
import { rawTxId } from "../src/services/pearl-rpc";
import { p2trKeyPathVsize, STANDARD_TX_MAX_VBYTES, PEARL_PREVIEW_FRESHNESS_MS, type PoolUtxo } from "../src/services/pearl-tx";
import {
  assertConsolidationBatch,
  broadcastConsolidationBatch,
  composeConsolidation,
  marginalInputFee,
  verifyBatchStillSpendable,
  CONSOLIDATION_MAX_FEE_DEN,
  CONSOLIDATION_MAX_FEE_NUM,
  CONSOLIDATION_MAX_INPUTS,
  CONSOLIDATION_MAX_VBYTES,
  type ConsolidationBatch,
  type ConsolidationDestination,
  type ConsolidationPlan,
} from "../src/services/pearl-consolidate";
import { clearPendingSpends, pendingOutpoints } from "../src/services/pending-spends";
import { addRecord, useMemoryStorage } from "./helpers/broadcast-env";
import { useUI } from "../src/state/ui-store";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const params = pearlParams("mainnet");
const PRL = 100_000_000n;
let seed: Uint8Array;
let master: HDKey;
let acct: HDKey;
let ext: string[];
let int: string[];
let DEST: ConsolidationDestination;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const scriptForAddress = (addr: string) => "5120" + hex(decodeTaprootAddress(addr, params));
const OTHER_DEST = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/86'/808276'/0'/0/0");
  return pearlAddressFromInternalKey(k.publicKey!.slice(1), params);
})();

beforeAll(async () => {
  seed = await bip39.mnemonicToSeed(MNEMONIC);
  master = masterFromSeed(seed);
  acct = publicAccountNode(master, pearlAccountPath());
  ext = pearlBranchAddressRange(acct, "mainnet", 0, 0, 20);
  int = pearlBranchAddressRange(acct, "mainnet", 1, 0, 20);
  DEST = { address: ext[0]!, branch: 0, index: 0 };
});
beforeEach(() => {
  vi.restoreAllMocks();
  clearPendingSpends();
  useMemoryStorage();
  useUI.getState().setPearlRpcOverride("");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearPendingSpends();
});

/** Planning-only coins (script irrelevant). */
function coins(values: bigint[], tag = 0): PoolUtxo[] {
  return values.map((v, i) => ({
    txid: (tag * 1_000_000 + i + 1).toString(16).padStart(64, "0"),
    vout: i % 4,
    valueGrains: v,
    scriptHex: "5120" + "00".repeat(32),
    branch: 0,
    index: 0,
  }));
}

function scriptOf(branch: HdBranch, index: number): string {
  return hex(p2trScriptForInternalKey(master.derive(pearlBranchPath(branch, index)).publicKey!.slice(1)));
}

/** Coins really controlled by the test seed: branch alternates, index cycles. */
function ownCoins(n: number, value: (i: number) => bigint): PoolUtxo[] {
  const scripts = new Map<string, string>();
  return Array.from({ length: n }, (_, i) => {
    const branch = (i % 2) as HdBranch;
    const index = i % 15;
    const k = `${branch}/${index}`;
    if (!scripts.has(k)) scripts.set(k, scriptOf(branch, index));
    return {
      txid: (0xabc000 + i).toString(16).padStart(64, "0"),
      vout: i % 3,
      valueGrains: value(i),
      scriptHex: scripts.get(k)!,
      branch,
      index,
    };
  });
}

function checkPlanInvariants(plan: ConsolidationPlan, maxInputs = 500) {
  const seen = new Set<string>();
  for (const b of plan.batches) {
    const ins = b.utxos.reduce((a, u) => a + u.valueGrains, 0n);
    expect(ins).toBe(b.inputGrains);
    expect(ins).toBe(b.output.amountGrains + b.feeGrains); // inputs = output + fee, exactly
    expect(b.output.address).toBe(plan.destination.address); // single own output
    expect(b.output.address).not.toBe(tipAddressFor("mainnet")); // no tip
    expect(b.utxos.length).toBeGreaterThanOrEqual(2);
    expect(b.utxos.length).toBeLessThanOrEqual(maxInputs); // cap
    expect(b.vbytes).toBe(p2trKeyPathVsize(b.utxos.length, 1));
    expect(b.vbytes < STANDARD_TX_MAX_VBYTES).toBe(true); // < 100 kvB
    expect(b.vbytes <= CONSOLIDATION_MAX_VBYTES).toBe(true);
    expect(b.feeGrains).toBe(b.vbytes * plan.feerate);
    expect(b.feeGrains * 50n <= b.inputGrains).toBe(true); // ≤ 2 %
    for (const u of b.utxos) {
      const k = `${u.txid}:${u.vout}`;
      expect(seen.has(k)).toBe(false); // no coin in two batches
      seen.add(k);
    }
    expect(() => assertConsolidationBatch(b)).not.toThrow();
  }
}

describe("constants", () => {
  it("caps agree with the signer", () => {
    expect(CONSOLIDATION_MAX_INPUTS).toBe(MAX_PEARL_SIGN_INPUTS);
    expect(CONSOLIDATION_MAX_FEE_NUM).toBe(SIGNER_FEE_NUM);
    expect(CONSOLIDATION_MAX_FEE_DEN).toBe(SIGNER_FEE_DEN);
    expect(CONSOLIDATION_MAX_VBYTES).toBe(90_000n);
  });
});

describe("p2trKeyPathVsize", () => {
  it("matches known sizes", () => {
    expect(p2trKeyPathVsize(1, 1)).toBe(111n);
    expect(p2trKeyPathVsize(1, 2)).toBe(154n);
    expect(p2trKeyPathVsize(2, 1)).toBe(169n);
    // 253 inputs: the input count varint grows from 1 to 3 bytes
    // (+57.5 vB for the input, +2 vB for the varint, then rounding).
    expect(p2trKeyPathVsize(252, 1)).toBe(14_544n);
    expect(p2trKeyPathVsize(253, 1)).toBe(14_603n);
    expect(p2trKeyPathVsize(500, 1)).toBe(28_806n);
    expect(p2trKeyPathVsize(500, 1) < STANDARD_TX_MAX_VBYTES).toBe(true);
    expect(() => p2trKeyPathVsize(0, 1)).toThrow();
  });
});

describe("composeConsolidation — batch planning", () => {
  it("2,345 coins → 5 batches (4 × 500 + 345), smallest first", () => {
    const values = Array.from({ length: 2345 }, (_, i) => 1_000_000n + BigInt((i * 7919) % 2345) * 10_000n);
    const plan = composeConsolidation({ utxos: coins(values), destination: DEST, feerateSatPerVbyte: 2n });
    expect(plan.batches.map((b) => b.utxos.length)).toEqual([500, 500, 500, 500, 345]);
    checkPlanInvariants(plan);
    // Smallest first: every coin of batch i ≤ every coin of batch i+1.
    for (let i = 0; i + 1 < plan.batches.length; i++) {
      const maxHere = plan.batches[i]!.utxos.reduce((m, u) => (u.valueGrains > m ? u.valueGrains : m), 0n);
      const minNext = plan.batches[i + 1]!.utxos.reduce((m, u) => (u.valueGrains < m ? u.valueGrains : m), 1n << 62n);
      expect(maxHere <= minNext).toBe(true);
    }
    const total = values.reduce((a, b) => a + b, 0n);
    expect(plan.utxoCount).toBe(2345);
    expect(plan.totalGrains).toBe(total);
    expect(plan.totalInputGrains).toBe(total);
    expect(plan.totalReceiveGrains + plan.totalFeeGrains).toBe(total);
    expect([plan.dust.count, plan.uneconomic.count, plan.leftover.count]).toEqual([0, 0, 0]);
  });

  it("respects a lower maxInputs and rejects caps above 500", () => {
    const values = Array.from({ length: 95 }, () => PRL);
    const plan = composeConsolidation({ utxos: coins(values), destination: DEST, maxInputs: 20 });
    expect(plan.batches.map((b) => b.utxos.length)).toEqual([20, 20, 20, 20, 15]);
    checkPlanInvariants(plan, 20);
    expect(() => composeConsolidation({ utxos: coins(values), destination: DEST, maxInputs: 501 })).toThrow("E_MAX_INPUTS");
    expect(() => composeConsolidation({ utxos: coins(values), destination: DEST, maxInputs: 1 })).toThrow("E_MAX_INPUTS");
  });

  it("a lone remaining coin is left as is", () => {
    const plan = composeConsolidation({ utxos: coins(Array.from({ length: 501 }, () => PRL)), destination: DEST });
    expect(plan.batches.map((b) => b.utxos.length)).toEqual([500]);
    expect(plan.leftover).toEqual({ count: 1, grains: PRL });
    const one = composeConsolidation({ utxos: coins([PRL]), destination: DEST });
    expect(one.batches).toHaveLength(0);
    expect(one.leftover.count).toBe(1);
  });

  it("skips coins not worth their own input fee and reports them", () => {
    const feerate = 4n;
    const m = marginalInputFee(feerate); // ceil(57.5 × 4) = 230
    expect(m).toBe(230n);
    const plan = composeConsolidation({
      utxos: coins([m - 1n, m, m + 1n, PRL, 2n * PRL, 3n * PRL]),
      destination: DEST,
      feerateSatPerVbyte: feerate,
    });
    expect(plan.dust).toEqual({ count: 2, grains: 2n * m - 1n });
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]!.utxos.map((u) => u.valueGrains)).toEqual([m + 1n, PRL, 2n * PRL, 3n * PRL]);
    checkPlanInvariants(plan);
  });

  it("refuses a batch whose fee exceeds 2 % and reports it as uneconomic", () => {
    // 10 coins of 2,000 grains at 10 sat/vB: fee 6,290 on 20,000 (31 %).
    const small = coins(Array.from({ length: 10 }, () => 2_000n), 1);
    const big = coins(Array.from({ length: 10 }, () => PRL), 2);
    const plan = composeConsolidation({ utxos: [...big, ...small], destination: DEST, feerateSatPerVbyte: 10n, maxInputs: 10 });
    expect(plan.uneconomic).toEqual({ count: 10, grains: 20_000n, batches: 1 });
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]!.inputGrains).toBe(10n * PRL);
    checkPlanInvariants(plan, 10);
    // The 2 % boundary itself: fee exactly 2 % passes, one grain less value fails.
    const vb = p2trKeyPathVsize(2, 1); // 169
    const exact = (vb * 50n) / 2n; // two coins summing to fee × 50
    const ok = composeConsolidation({ utxos: coins([exact, exact]), destination: DEST, feerateSatPerVbyte: 1n });
    expect(ok.batches).toHaveLength(1);
    expect(ok.batches[0]!.feeGrains * 50n).toBe(ok.batches[0]!.inputGrains);
    const no = composeConsolidation({ utxos: coins([exact, exact - 1n]), destination: DEST, feerateSatPerVbyte: 1n });
    expect(no.batches).toHaveLength(0);
    expect(no.uneconomic.batches).toBe(1);
  });

  it("excludes coins of pending broadcasts and duplicates", () => {
    const utxos = coins(Array.from({ length: 10 }, () => PRL));
    addRecord("d".repeat(64), utxos.slice(0, 4));
    const plan = composeConsolidation({ utxos: [...utxos, { ...utxos[5]! }], destination: DEST });
    expect(plan.pendingExcluded).toBe(4);
    expect(plan.utxoCount).toBe(6);
    expect(plan.batches[0]!.utxos).toHaveLength(6);
    const planned = new Set(plan.batches[0]!.utxos.map((u) => `${u.txid}:${u.vout}`));
    for (const u of utxos.slice(0, 4)) expect(planned.has(`${u.txid}:${u.vout}`)).toBe(false);
  });
});

describe("assertConsolidationBatch — tampering is caught", () => {
  let b: ConsolidationBatch;
  beforeAll(() => {
    b = composeConsolidation({ utxos: coins([PRL, 2n * PRL, 3n * PRL]), destination: DEST, feerateSatPerVbyte: 2n }).batches[0]!;
  });
  const bad = (mut: (x: ConsolidationBatch) => ConsolidationBatch, rule: string) =>
    expect(() => assertConsolidationBatch(mut(structuredClone(b)))).toThrow(`E_CONSOLIDATION_INVARIANT:${rule}`);

  it("rejects each broken invariant", () => {
    bad((x) => ({ ...x, output: { ...x.output, amountGrains: x.output.amountGrains + 1n } }), "balance");
    bad((x) => ({ ...x, feeGrains: x.feeGrains + 1n, output: { ...x.output, amountGrains: x.output.amountGrains - 1n } }), "fee");
    bad((x) => ({ ...x, output: { ...x.output, address: OTHER_DEST } }), "destination");
    bad((x) => ({ ...x, utxos: [...x.utxos, x.utxos[0]!] }), "duplicate-input");
    bad((x) => ({ ...x, utxos: x.utxos.slice(0, 1) }), "input-count");
    bad((x) => ({ ...x, inputGrains: x.inputGrains + 1n }), "input-sum");
    bad((x) => ({ ...x, vbytes: x.vbytes - 1n }), "vsize");
  });

  it("verifyBatchStillSpendable needs every input unchanged and not pending", () => {
    const fresh = coins([PRL, 2n * PRL, 3n * PRL]);
    expect(() => verifyBatchStillSpendable(b, fresh)).not.toThrow();
    expect(() => verifyBatchStillSpendable(b, fresh.slice(1))).toThrow("E_CONSOLIDATION_INPUTS_CHANGED");
    expect(() =>
      verifyBatchStillSpendable(b, fresh.map((u, i) => (i === 0 ? { ...u, valueGrains: u.valueGrains + 1n } : u))),
    ).toThrow("E_CONSOLIDATION_INPUTS_CHANGED");
    addRecord("c".repeat(64), [fresh[2]!]);
    expect(() => verifyBatchStillSpendable(b, fresh)).toThrow("E_CONSOLIDATION_INPUTS_CHANGED");
  });
});

describe("signPearlConsolidationWithSeed — worker-side refusals", () => {
  const ins = (): PearlUtxoSpec[] =>
    ownCoins(3, () => PRL).map((u) => ({ ...u, valueGrains: u.valueGrains.toString() }));
  const req = (over: Partial<PearlConsolidationRequest>): PearlConsolidationRequest => ({
    utxos: ins(),
    outputs: [{ address: ext[0]!, amountGrains: (3n * PRL - 1000n).toString() }],
    destination: { branch: 0, index: 0 },
    network: "mainnet",
    ...over,
  });

  it("signs a genuine self-transfer", () => {
    expect(() => signPearlConsolidationWithSeed(seed, req({}))).not.toThrow();
    // Change-branch destination is also the wallet's own key.
    expect(() =>
      signPearlConsolidationWithSeed(seed, req({ outputs: [{ address: int[4]!, amountGrains: "299999000" }], destination: { branch: 1, index: 4 } })),
    ).not.toThrow();
  });
  it("refuses a third-party output", () => {
    expect(() => signPearlConsolidationWithSeed(seed, req({ outputs: [{ address: OTHER_DEST, amountGrains: "299999000" }] }))).toThrow(
      "E_CONSOLIDATION_FOREIGN_OUTPUT",
    );
    expect(() =>
      signPearlConsolidationWithSeed(seed, req({ outputs: [{ address: tipAddressFor("mainnet"), amountGrains: "299999000" }] })),
    ).toThrow("E_CONSOLIDATION_FOREIGN_OUTPUT");
    expect(() => signPearlConsolidationWithSeed(seed, req({ outputs: [{ address: "not-an-address", amountGrains: "299999000" }] }))).toThrow(
      "E_CONSOLIDATION_FOREIGN_OUTPUT",
    );
  });
  it("refuses an own address under the wrong (branch, index)", () => {
    expect(() => signPearlConsolidationWithSeed(seed, req({ destination: { branch: 0, index: 1 } }))).toThrow(
      "E_CONSOLIDATION_FOREIGN_OUTPUT",
    );
    expect(() => signPearlConsolidationWithSeed(seed, req({ destination: { branch: 1, index: 0 } }))).toThrow(
      "E_CONSOLIDATION_FOREIGN_OUTPUT",
    );
    expect(() => signPearlConsolidationWithSeed(seed, req({ destination: { branch: 2 as HdBranch, index: 0 } }))).toThrow(
      "E_CONSOLIDATION_DESTINATION",
    );
  });
  it("refuses anything but exactly one output", () => {
    const two = [
      { address: ext[0]!, amountGrains: "100000000" },
      { address: OTHER_DEST, amountGrains: "199999000" },
    ];
    expect(() => signPearlConsolidationWithSeed(seed, req({ outputs: two }))).toThrow("E_CONSOLIDATION_OUTPUTS");
    expect(() => signPearlConsolidationWithSeed(seed, req({ outputs: [] }))).toThrow("E_CONSOLIDATION_OUTPUTS");
  });
  it("refuses a fee above 2 % or a non-positive fee", () => {
    const over = (3n * PRL * 98n) / 100n - 1n; // fee = 2 % + 1 grain
    expect(() => signPearlConsolidationWithSeed(seed, req({ outputs: [{ address: ext[0]!, amountGrains: over.toString() }] }))).toThrow(
      "E_CONSOLIDATION_FEE",
    );
    const at = (3n * PRL * 98n) / 100n; // fee exactly 2 %
    expect(() => signPearlConsolidationWithSeed(seed, req({ outputs: [{ address: ext[0]!, amountGrains: at.toString() }] }))).not.toThrow();
    expect(() =>
      signPearlConsolidationWithSeed(seed, req({ outputs: [{ address: ext[0]!, amountGrains: (3n * PRL).toString() }] })),
    ).toThrow("E_CONSOLIDATION_FEE");
  });
  it("still enforces input binding", () => {
    const u = ins();
    u[1] = { ...u[1]!, index: u[1]!.index + 1 };
    expect(() => signPearlConsolidationWithSeed(seed, req({ utxos: u }))).toThrow("E_PEARL_FOREIGN_INPUT");
  });
});

describe("end-to-end: 300-input consolidation signed, broadcast, verified", () => {
  it("signs every input, pays only our own address, fee = vsize × feerate", async () => {
    const utxos = ownCoins(300, (i) => 1_000_000n + BigInt(i) * 12_345n);
    const feerate = 2n;
    const plan = composeConsolidation({ utxos, destination: DEST, feerateSatPerVbyte: feerate });
    expect(plan.batches).toHaveLength(1);
    checkPlanInvariants(plan);
    const batch = plan.batches[0]!;
    expect(batch.utxos).toHaveLength(300);

    const workerCalls: string[] = [];
    vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async (cmd: string, args: { req: PearlConsolidationRequest }) => {
      workerCalls.push(cmd);
      if (cmd !== "signPearlConsolidation") throw new Error(`unexpected ${cmd}`);
      return signPearlConsolidationWithSeed(seed, args.req);
    }) as never);
    let broadcastRaw = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
        if (body.method !== "sendrawtransaction") throw new Error(`unexpected ${body.method}`);
        broadcastRaw = body.params[0] as string;
        return new Response(JSON.stringify({ result: rawTxId(broadcastRaw), error: null }));
      }),
    );

    // A stale review is refused before anything is signed.
    const now = Date.now();
    await expect(
      broadcastConsolidationBatch({ batch, verifiedAt: now - PEARL_PREVIEW_FRESHNESS_MS - 1 }, "mainnet", now),
    ).rejects.toThrow("E_PREVIEW_STALE");
    expect(workerCalls).toEqual([]);

    const res = await broadcastConsolidationBatch({ batch, verifiedAt: now }, "mainnet", now);
    expect(workerCalls).toEqual(["signPearlConsolidation"]);
    expect(res.txid).toBe(rawTxId(broadcastRaw));

    const tx = btc.Transaction.fromRaw(unhex(broadcastRaw));
    expect(tx.inputsLength).toBe(300);
    expect(tx.outputsLength).toBe(1);
    expect(hex(tx.getOutput(0).script!)).toBe(scriptForAddress(ext[0]!));
    expect(tx.getOutput(0).amount).toBe(batch.output.amountGrains);
    // Signed size is exactly what the fee was priced on.
    expect(BigInt(tx.vsize)).toBe(batch.vbytes);
    expect(batch.vbytes).toBe(p2trKeyPathVsize(300, 1));
    const inSum = utxos.reduce((a, u) => a + u.valueGrains, 0n);
    expect(inSum - tx.getOutput(0).amount!).toBe(batch.vbytes * feerate);

    // Every BIP-340 key-path signature verifies against its prevout.
    const prev = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
    const scripts: Uint8Array[] = [];
    const amounts: bigint[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const p = prev.get(`${hex(inp.txid!)}:${inp.index}`)!;
      scripts.push(unhex(p.scriptHex));
      amounts.push(p.valueGrains);
    }
    let ok = 0;
    for (let i = 0; i < tx.inputsLength; i++) {
      const w = tx.getInput(i).finalScriptWitness!;
      expect(w[0]!.length).toBe(64);
      const msg = tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts);
      if (schnorr.verify(w[0]!, msg, scripts[i]!.slice(2))) ok++;
    }
    expect(ok).toBe(300);

    // Re-run safety: the 300 coins are now pending; a fresh plan over the
    // same (not yet updated) scan spends none of them, and the same batch
    // cannot be broadcast again.
    expect(pendingOutpoints().size).toBe(300);
    const again = composeConsolidation({ utxos, destination: DEST, feerateSatPerVbyte: feerate });
    expect(again.batches).toHaveLength(0);
    expect(again.pendingExcluded).toBe(300);
    await expect(broadcastConsolidationBatch({ batch, verifiedAt: Date.now() }, "mainnet")).rejects.toThrow(
      "E_CONSOLIDATION_INPUT_PENDING",
    );
    expect(workerCalls).toEqual(["signPearlConsolidation"]);
  });

  it("a rejected broadcast records nothing as pending", async () => {
    const utxos = ownCoins(4, () => PRL);
    const batch = composeConsolidation({ utxos, destination: DEST }).batches[0]!;
    vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async (_c: string, args: { req: PearlConsolidationRequest }) =>
      signPearlConsolidationWithSeed(seed, args.req)) as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: null, error: { code: -26, message: "txn-mempool-conflict" } }))),
    );
    await expect(broadcastConsolidationBatch({ batch, verifiedAt: Date.now() }, "mainnet")).rejects.toThrow();
    expect(pendingOutpoints().size).toBe(0);
  });
});
