// v0.7 B3 — Send max, the per-tx input cap (E_TOO_MANY_INPUTS), the
// structured E_NO_UTXOS / E_UTXO_SCAN_INCOMPLETE diagnostics, exact fee
// accounting in composePearlSend, and pending-spend exclusion.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as pearlRpc from "../src/services/pearl-rpc";
import {
  composePearlSend,
  computeMaxSendable,
  InsufficientFundsError,
  MAX_SEND_INPUTS,
  NoSpendableCoinsError,
  TooManyInputsError,
  UtxoScanIncompleteError,
  PER_INPUT_VBYTES,
  PER_P2TR_OUTPUT_VBYTES,
  FIXED_OVERHEAD_VBYTES,
  DUST_LIMIT_GRAINS,
  type PoolUtxo,
  type ComposedPearlTx,
} from "../src/services/pearl-tx";
import { MAX_PEARL_SIGN_INPUTS } from "../src/crypto/pearl-sign";
import { computeTipGrains, tipAddressFor, TIP_MIN_GRAINS } from "../src/chains/pearl/tip";
import { clearPendingSpends } from "../src/services/pending-spends";
import { addRecord, useMemoryStorage } from "./helpers/broadcast-env";

const POOL = ["prl1pdummy0", "prl1pdummy1"];
const DEST = "prl1pdest0000";
const SCRIPT = "5120" + "00".repeat(32);
const PRL = 100_000_000n;

function coins(values: bigint[], start = 0): PoolUtxo[] {
  return values.map((v, i) => ({
    txid: (start + i + 1).toString(16).padStart(64, "0"),
    vout: i % 3,
    valueGrains: v,
    scriptHex: SCRIPT,
    branch: 0,
    index: 0,
  }));
}

/** Serve `utxos` from POOL[0] through the mocked per-address walk. */
function serve(utxos: PoolUtxo[]) {
  return vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => ({
    utxos: addr === POOL[0] ? utxos.map(({ txid, vout, valueGrains, scriptHex }) => ({ txid, vout, valueGrains, scriptHex })) : [],
    degraded: false,
    droppedNoScript: 0,
    used: addr === POOL[0],
  }));
}

function fee(inputs: number, outputs: number, feerate: bigint): bigint {
  return (FIXED_OVERHEAD_VBYTES + BigInt(inputs) * PER_INPUT_VBYTES + BigInt(outputs) * PER_P2TR_OUTPUT_VBYTES) * feerate;
}

function checkBalance(c: ComposedPearlTx) {
  const ins = c.utxos.reduce((a, u) => a + u.valueGrains, 0n);
  const outs = c.outputs.reduce((a, o) => a + o.amountGrains, 0n);
  expect(ins).toBe(outs + c.feeGrains);
  expect(c.feeGrains).toBeGreaterThan(0n);
}

const keys = (us: { txid: string; vout: number }[]) => us.map((u) => `${u.txid}:${u.vout}`).sort();

beforeEach(() => {
  vi.restoreAllMocks();
  clearPendingSpends();
  useMemoryStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearPendingSpends();
});

describe("constants", () => {
  it("send input cap equals the signer's hard cap", () => {
    expect(MAX_SEND_INPUTS).toBe(MAX_PEARL_SIGN_INPUTS);
    expect(MAX_SEND_INPUTS).toBe(500);
  });
});

describe("computeMaxSendable — exactness", () => {
  const wallets: bigint[][] = [
    [7n * PRL],
    [3n * PRL, 2n * PRL, 123_456_789n],
    [1500n * PRL, 250n * PRL + 17n, 99_999_999n, 5_000_000n, 777n],
    Array.from({ length: 40 }, (_, i) => BigInt(i + 1) * 31_337_000n + BigInt(i)),
    [987_654_321_000n, 12_345n * PRL + 1n],
  ];
  for (const [wi, values] of wallets.entries()) {
    for (const includeTip of [true, false]) {
      for (const feerate of [1n, 2n, 4n]) {
        it(`wallet ${wi} tip=${includeTip} feerate=${feerate}: amount + tip + fee == inputs, compose agrees`, async () => {
          const utxos = coins(values);
          const m = computeMaxSendable({ utxos, feerateSatPerVbyte: feerate, includeTip });
          expect(m.amountGrains).toBeGreaterThan(0n);
          expect(m.amountGrains + m.tipGrains + m.feeGrains + m.changeGrains).toBe(m.inputGrains);
          expect(m.tipGrains).toBe(includeTip ? computeTipGrains(m.amountGrains) : 0n);
          if (m.exact) {
            expect(m.changeGrains).toBe(0n);
            const est = fee(m.inputs.length, m.tipGrains > 0n ? 2 : 1, feerate);
            // Fee is the estimate, plus at most one rounding grain.
            expect(m.feeGrains - est >= 0n && m.feeGrains - est <= 1n).toBe(true);
          }
          // One more grain is not sendable from these coins.
          serve(utxos);
          await expect(
            composePearlSend({
              network: "mainnet",
              pool: POOL,
              destination: DEST,
              amountGrains: m.amountGrains + 1n,
              includeTip,
              feerateSatPerVbyte: feerate,
            }),
          ).rejects.toBeInstanceOf(m.exact ? InsufficientFundsError : Error);
          // Composing the max selects the same coins, no change, same fee.
          const c = await composePearlSend({
            network: "mainnet",
            pool: POOL,
            destination: DEST,
            amountGrains: m.amountGrains,
            includeTip,
            feerateSatPerVbyte: feerate,
          });
          checkBalance(c);
          if (m.exact) {
            expect(keys(c.utxos)).toEqual(keys(m.inputs));
            expect(c.changeGrains).toBe(0n);
            expect(c.feeGrains).toBe(m.feeGrains);
            expect(c.tipGrains).toBe(m.tipGrains);
            expect(c.outputs.length).toBe(m.tipGrains > 0n ? 2 : 1);
          }
        });
      }
    }
  }

  it("skips coins worth less than their own input fee", () => {
    const feerate = 2n;
    const marginal = PER_INPUT_VBYTES * feerate; // 116
    const utxos = coins([5n * PRL, marginal, marginal - 1n, marginal + 1n]);
    const m = computeMaxSendable({ utxos, feerateSatPerVbyte: feerate, includeTip: false });
    expect(m.uneconomicCount).toBe(2);
    expect(m.inputs.map((u) => u.valueGrains)).toEqual([5n * PRL, marginal + 1n]);
    expect(m.exact).toBe(true);
  });

  it("returns 0 for an empty or dust-only wallet", () => {
    expect(computeMaxSendable({ utxos: [], includeTip: true }).amountGrains).toBe(0n);
    expect(computeMaxSendable({ utxos: coins([100n, 50n]), includeTip: false, feerateSatPerVbyte: 2n }).amountGrains).toBe(0n);
    // One coin whose leftover after fee would be ≤ dust.
    const tiny = fee(1, 1, 1n) + DUST_LIMIT_GRAINS;
    expect(computeMaxSendable({ utxos: coins([tiny]), includeTip: false, feerateSatPerVbyte: 1n }).amountGrains).toBe(0n);
  });

  it("caps at maxInputs, largest first", () => {
    const values = Array.from({ length: 600 }, (_, i) => BigInt(i + 1) * 1_000_000n);
    const m = computeMaxSendable({ utxos: coins(values), includeTip: false, feerateSatPerVbyte: 1n });
    expect(m.inputs).toHaveLength(500);
    expect(m.capped).toBe(true);
    expect(m.cappedOutCount).toBe(100);
    expect(m.inputs[499]!.valueGrains).toBe(101n * 1_000_000n);
    expect(m.amountGrains).toBe(m.inputGrains - fee(500, 1, 1n));
    const small = computeMaxSendable({ utxos: coins(values), includeTip: false, feerateSatPerVbyte: 1n, maxInputs: 10 });
    expect(small.inputs).toHaveLength(10);
    expect(() => computeMaxSendable({ utxos: coins(values), includeTip: false, maxInputs: 0 })).toThrow("E_MAX_INPUTS");
  });

  it("ignores duplicate outpoints", () => {
    const [a] = coins([5n * PRL]);
    const m = computeMaxSendable({ utxos: [a!, { ...a! }], includeTip: false, feerateSatPerVbyte: 1n });
    expect(m.inputs).toHaveLength(1);
  });
});

describe("computeMaxSendable — tip boundaries", () => {
  // One input, feerate 1: fee with a tip output = fee(1, 2, 1) = 155,
  // without = fee(1, 1, 1) = 112.
  const F2 = fee(1, 2, 1n);
  const F1 = fee(1, 1, 1n);
  const max = (s: bigint) => computeMaxSendable({ utxos: coins([s]), includeTip: true, feerateSatPerVbyte: 1n });
  // 10 bps exceeds the 1 PRL floor from A = 100,000,001,000 (1000.00001 PRL).
  const SWITCH = 100_000_001_000n;

  it("tip function boundaries", () => {
    expect(computeTipGrains(PRL - 1n)).toBe(0n);
    expect(computeTipGrains(PRL)).toBe(TIP_MIN_GRAINS);
    expect(computeTipGrains(1000n * PRL)).toBe(TIP_MIN_GRAINS);
    expect(computeTipGrains(SWITCH - 1n)).toBe(TIP_MIN_GRAINS);
    expect(computeTipGrains(SWITCH)).toBe(TIP_MIN_GRAINS + 1n);
  });

  it("A = 1000 PRL exactly: minimum tip", () => {
    const m = max(1000n * PRL + PRL + F2);
    expect([m.amountGrains, m.tipGrains, m.feeGrains, m.exact]).toEqual([1000n * PRL, PRL, F2, true]);
  });
  it("last amount on the 1 PRL floor", () => {
    const m = max(SWITCH - 1n + PRL + F2);
    expect([m.amountGrains, m.tipGrains, m.feeGrains, m.exact]).toEqual([SWITCH - 1n, PRL, F2, true]);
  });
  it("first amount paying 10 bps above the floor", () => {
    const m = max(SWITCH + PRL + 1n + F2);
    expect([m.amountGrains, m.tipGrains, m.feeGrains, m.exact]).toEqual([SWITCH, PRL + 1n, F2, true]);
  });
  it("unreachable total (A + tip skips a value): the spare grain goes to fee, no change", () => {
    const m = max(SWITCH + PRL + F2);
    expect([m.amountGrains, m.tipGrains, m.feeGrains, m.changeGrains, m.exact]).toEqual([SWITCH - 1n, PRL, F2 + 1n, 0n, true]);
  });
  it("large amounts in the 10 bps region", () => {
    const A = 123_456_789_012_345n;
    const m = max(A + computeTipGrains(A) + F2);
    expect(m.amountGrains).toBe(A);
    expect(m.exact).toBe(true);
  });
  it("A = 1 PRL exactly", () => {
    const m = max(PRL + PRL + F2);
    expect([m.amountGrains, m.tipGrains, m.exact]).toEqual([PRL, PRL, true]);
  });
  it("below 1 PRL no tip is due and no tip output is paid for", () => {
    const m = max(PRL / 2n + F1);
    expect([m.amountGrains, m.tipGrains, m.feeGrains, m.exact]).toEqual([PRL / 2n, 0n, F1, true]);
  });
  it("tip-floor gap: coins cover < 1 PRL untipped but not 1 PRL + 1 PRL tip", () => {
    const S = PRL + PRL + F2 - 1n;
    const m = max(S);
    expect(m.amountGrains).toBe(PRL - 1n);
    expect(m.tipGrains).toBe(0n);
    expect(m.exact).toBe(false);
    expect(m.changeGrains).toBe(S - (PRL - 1n) - fee(1, 2, 1n));
    expect(m.amountGrains + m.tipGrains + m.feeGrains + m.changeGrains).toBe(S);
    // With the tip off the same coin sends everything.
    const off = computeMaxSendable({ utxos: coins([S]), includeTip: false, feerateSatPerVbyte: 1n });
    expect([off.amountGrains, off.exact]).toEqual([S - F1, true]);
  });
});

describe("composePearlSend — input cap (E_TOO_MANY_INPUTS)", () => {
  const values = Array.from({ length: 600 }, () => PRL); // 600 × 1 PRL

  it("throws TooManyInputsError when the amount needs more than 500 coins", async () => {
    serve(coins(values));
    const err = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: 550n * PRL,
      includeTip: false,
      feerateSatPerVbyte: 1n,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyInputsError);
    const t = err as TooManyInputsError;
    expect(t.code).toBe("E_TOO_MANY_INPUTS");
    expect(t.message).toMatch(/^E_TOO_MANY_INPUTS/);
    expect(t.inputsNeeded).toBe(551);
    expect(t.maxInputs).toBe(500);
    expect(t.utxoCount).toBe(600);
    expect(t.spendableGrains).toBe(600n * PRL);
    expect(t.maxSendableGrains).toBe(500n * PRL - fee(500, 1, 1n));
  });

  it("the same wallet sends 400 PRL (≤ 500 coins) fine", async () => {
    serve(coins(values));
    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: 400n * PRL,
      includeTip: false,
      feerateSatPerVbyte: 1n,
    });
    expect(c.utxos).toHaveLength(401);
    checkBalance(c);
  });

  it("a shortfall is still InsufficientFunds, not too-many-inputs", async () => {
    serve(coins(values));
    await expect(
      composePearlSend({
        network: "mainnet",
        pool: POOL,
        destination: DEST,
        amountGrains: 601n * PRL,
        includeTip: false,
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it("honours a lower maxInputs", async () => {
    serve(coins(values));
    await expect(
      composePearlSend({
        network: "mainnet",
        pool: POOL,
        destination: DEST,
        amountGrains: 20n * PRL,
        includeTip: false,
        maxInputs: 10,
      }),
    ).rejects.toBeInstanceOf(TooManyInputsError);
  });
});

describe("composePearlSend — fee accounting and diagnostics", () => {
  it("absorbed sub-dust leftover is part of feeGrains (inputs = outputs + fee)", async () => {
    const amount = PRL - fee(1, 1, 2n) - 300n; // leftover 300 < dust
    serve(coins([PRL]));
    const c = await composePearlSend({ network: "mainnet", pool: POOL, destination: DEST, amountGrains: amount, includeTip: false });
    expect(c.changeGrains).toBe(0n);
    expect(c.outputs).toHaveLength(1);
    expect(c.feeGrains).toBe(fee(1, 1, 2n) + 300n);
    checkBalance(c);
  });

  it("no tip output (and no fee for one) when the tip is 0", async () => {
    serve(coins([PRL]));
    const c = await composePearlSend({ network: "mainnet", pool: POOL, destination: DEST, amountGrains: PRL / 10n, includeTip: true });
    expect(c.tipGrains).toBe(0n);
    expect(c.outputs.map((o) => o.address)).not.toContain(tipAddressFor("mainnet"));
    expect(c.feeGrains).toBe(fee(1, 2, 2n)); // dest + change
    checkBalance(c);
  });

  it("random sends always balance exactly", async () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let t = 0; t < 40; t++) {
      const values = Array.from({ length: 1 + (rnd() % 30) }, () => BigInt(1000 + (rnd() % 5_000_000_000)));
      const total = values.reduce((a, b) => a + b, 0n);
      const amount = 1n + (total * BigInt(rnd() % 1000)) / 1000n;
      vi.restoreAllMocks();
      serve(coins(values));
      try {
        const c = await composePearlSend({
          network: "mainnet",
          pool: POOL,
          destination: DEST,
          amountGrains: amount,
          includeTip: rnd() % 2 === 0,
          feerateSatPerVbyte: BigInt(1 + (rnd() % 4)),
        });
        checkBalance(c);
        expect(c.amountGrains).toBe(amount);
        if (c.changeGrains > 0n) expect(c.changeGrains).toBeGreaterThanOrEqual(DUST_LIMIT_GRAINS);
      } catch (e) {
        expect(e).toBeInstanceOf(InsufficientFundsError);
      }
    }
  });

  it("E_NO_UTXOS is structured: every address answered, nothing spendable", async () => {
    serve([]);
    const err = await composePearlSend({ network: "mainnet", pool: POOL, destination: DEST, amountGrains: PRL, includeTip: false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NoSpendableCoinsError);
    expect((err as NoSpendableCoinsError).addressesScanned).toBe(2);
    expect((err as NoSpendableCoinsError).pendingCount).toBe(0);
    expect((err as Error).message).toBe("E_NO_UTXOS");
  });

  it("scan incomplete is reported as such, not as an empty wallet", async () => {
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockRejectedValue(new Error("busy"));
    const err = await composePearlSend({ network: "mainnet", pool: POOL, destination: DEST, amountGrains: PRL, includeTip: false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UtxoScanIncompleteError);
    expect((err as UtxoScanIncompleteError).failures).toBe(2);
    expect((err as Error).message).toMatch(/^E_UTXO_SCAN_INCOMPLETE/);
  });

  it("coins of a pending broadcast are never selected (cache or live)", async () => {
    const utxos = coins([5n * PRL, 3n * PRL]);
    addRecord("f".repeat(64), [utxos[0]!]);
    serve(utxos);
    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: PRL,
      includeTip: false,
      cachedUtxos: utxos,
    });
    expect(keys(c.utxos)).toEqual(keys([utxos[1]!]));
    // Everything pending → E_NO_UTXOS with the pending count.
    addRecord("e".repeat(64), [utxos[1]!]);
    const err = await composePearlSend({ network: "mainnet", pool: POOL, destination: DEST, amountGrains: PRL, includeTip: false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NoSpendableCoinsError);
    expect((err as NoSpendableCoinsError).pendingCount).toBe(2);
  });

  it("uses the cache without a walk when it covers the send", async () => {
    const spy = serve([]);
    const utxos = coins([5n * PRL]);
    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: PRL,
      includeTip: false,
      cachedUtxos: utxos,
    });
    expect(spy).not.toHaveBeenCalled();
    checkBalance(c);
  });
});
