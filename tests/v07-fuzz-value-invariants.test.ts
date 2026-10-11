// v0.7 — seeded property fuzzing of the PRL value paths. Deterministic and
// dependency-free: a mulberry32 PRNG with fixed seeds drives random UTXO
// sets, amounts, feerates, caps and pending-broadcast records through the
// REAL exported functions (no re-implementations of the code under test):
//
//   P1 composePearlSend      — exact money balance or a typed refusal
//   P2 computeMaxSendable    — composes to an exact, change-free spend
//   P3 composeConsolidation  — per-batch balance, cap, own destination
//   P4 computeTipGrains      — tip formula + tip never silently overdraws
//   P5 signPearlTxWithSeed   — every input signed by its own derived key;
//                              foreign scripts refused (test mnemonic only)
//   P6 pending spends        — excluded outpoints never selected
//
// Network: the only RPC touched is fetchPrlUtxos, mocked per case from the
// in-memory coin set. Nothing is broadcast; no real keys are used.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import * as pearlRpc from "../src/services/pearl-rpc";
import {
  composePearlSend,
  computeMaxSendable,
  InsufficientFundsError,
  TooManyInputsError,
  NoSpendableCoinsError,
  MAX_SEND_INPUTS,
  PER_INPUT_VBYTES,
  PER_P2TR_OUTPUT_VBYTES,
  FIXED_OVERHEAD_VBYTES,
  DUST_LIMIT_GRAINS,
  type PoolUtxo,
  type ComposedPearlTx,
} from "../src/services/pearl-tx";
import {
  composeConsolidation,
  assertConsolidationBatch,
  marginalInputFee,
  CONSOLIDATION_MAX_INPUTS,
  CONSOLIDATION_MAX_VBYTES,
  type ConsolidationDestination,
} from "../src/services/pearl-consolidate";
import { computeTipGrains, tipAddressFor, TIP_MIN_GRAINS, TIP_BPS } from "../src/chains/pearl/tip";
import { clearPendingSpends, outpointKey, pendingOutpoints } from "../src/services/pending-spends";
import {
  signPearlTxWithSeed,
  signPearlConsolidationWithSeed,
  p2trScriptForInternalKey,
  type PearlUtxoSpec,
} from "../src/crypto/pearl-sign";
import { masterFromSeed, pearlAccountPath, pearlBranchPath, publicAccountNode, type HdBranch } from "../src/crypto/hd";
import { pearlBranchAddressRange } from "../src/crypto/pearl-addresses";
import { pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import { addRecord, useMemoryStorage } from "./helpers/broadcast-env";

// ─── Deterministic PRNG ──────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private r: () => number;
  constructor(readonly seed: number) {
    this.r = mulberry32(seed);
  }
  float(): number {
    return this.r();
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.r() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.r() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!;
  }
  /** Uniform bigint in [lo, hi]. */
  big(lo: bigint, hi: bigint): bigint {
    const span = hi - lo + 1n;
    const x = (BigInt(Math.floor(this.r() * 2 ** 32)) << 32n) | BigInt(Math.floor(this.r() * 2 ** 32));
    return lo + (x % span);
  }
  /** Log-uniform bigint in [1, max] — covers dust, mid and whale coins. */
  logBig(max: bigint): bigint {
    const digits = max.toString().length;
    const d = this.int(1, digits);
    const hi = 10n ** BigInt(d) < max ? 10n ** BigInt(d) : max;
    const lo = d === 1 ? 1n : 10n ** BigInt(d - 1);
    return this.big(lo > hi ? 1n : lo, hi);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const params = pearlParams("mainnet");
const PRL = 100_000_000n;
const MAX_COIN = 1_000_000_000_000n; // 1e12 grains
const POOL = ["prl1pfuzzpool0", "prl1pfuzzpool1"];
const DEST = "prl1pfuzzdest0";
const DUMMY_SCRIPT = "5120" + "00".repeat(32);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const OTHER_DEST = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/86'/808276'/0'/0/0");
  return pearlAddressFromInternalKey(k.publicKey!.slice(1), params);
})();
const FOREIGN_SCRIPT = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive("m/86'/808276'/0'/0/0");
  return hex(p2trScriptForInternalKey(k.publicKey!.slice(1)));
})();

const fee = (inputs: number, outputs: number, feerate: bigint) =>
  (FIXED_OVERHEAD_VBYTES + BigInt(inputs) * PER_INPUT_VBYTES + BigInt(outputs) * PER_P2TR_OUTPUT_VBYTES) * feerate;
const sumOf = (us: readonly { valueGrains: bigint }[]) => us.reduce((a, u) => a + u.valueGrains, 0n);
const okey = (u: { txid: string; vout: number }) => outpointKey(u);

let txCounter = 0;
function txid(rng: Rng): string {
  txCounter++;
  return (rng.int(0, 0xffffff).toString(16) + txCounter.toString(16)).padStart(64, "0");
}

/** Random UTXO set: 1..maxCount coins, log-uniform 1..1e12 grains, mixed
 *  branches/indices; some coins share a txid (different vouts). */
function randomCoins(rng: Rng, minCount: number, maxCount: number, maxValue = MAX_COIN): PoolUtxo[] {
  const n = rng.int(minCount, maxCount);
  const out: PoolUtxo[] = [];
  // Outpoints are unique (a real chain cannot list one outpoint with two
  // values); some coins share a txid with distinct vouts.
  let prevTx = txid(rng);
  for (let i = 0; i < n; i++) {
    const shareTx = i > 0 && rng.bool(0.2);
    const t = shareTx ? prevTx : txid(rng);
    prevTx = t;
    out.push({
      txid: t,
      vout: shareTx ? 4 + i : rng.int(0, 3),
      valueGrains: rng.bool(0.05) ? rng.big(1n, 600n) : rng.logBig(maxValue),
      scriptHex: DUMMY_SCRIPT,
      branch: rng.pick([0, 1] as const),
      index: rng.int(0, 40),
    });
  }
  return out;
}

/** Random amount relative to the set: tiny, mid, near-total, over-total, invalid. */
function randomAmount(rng: Rng, total: bigint): bigint {
  const mode = rng.int(0, 9);
  if (mode === 0) return rng.big(-5n, 0n);
  if (mode === 1) return rng.big(1n, 1000n);
  if (mode === 2) return rng.big(PRL - 1000n, PRL + 1000n);
  if (mode === 3) return total + rng.big(0n, 10_000n);
  if (mode === 4) return total > 100_000n ? total - rng.big(0n, 100_000n) : rng.big(1n, total + 1n);
  return rng.big(1n, total > 1n ? total : 1n);
}

/** Every live walk serves `current` from POOL[0] (branch/index come from
 *  the walk's own refs, so the identity check below uses outpoint+value). */
let current: PoolUtxo[] = [];
function serveCurrent() {
  return vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => ({
    utxos: addr === POOL[0] ? current.map(({ txid, vout, valueGrains, scriptHex }) => ({ txid, vout, valueGrains, scriptHex })) : [],
    degraded: false,
    droppedNoScript: 0,
    used: addr === POOL[0],
  }));
}

function describeCase(seed: number, i: number, extra: Record<string, unknown>): string {
  return JSON.stringify({ seed, case: i, ...extra }, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
}

/** Full invariant check of a composed send against the coin set it drew from. */
function checkComposed(c: ComposedPearlTx, coins: readonly PoolUtxo[], amount: bigint, includeTip: boolean, maxInputs: number, excluded: Set<string>) {
  const byKey = new Map(coins.map((u) => [okey(u), u]));
  const ins = sumOf(c.utxos);
  const outs = c.outputs.reduce((a, o) => a + o.amountGrains, 0n);
  const tip = includeTip ? computeTipGrains(amount) : 0n;
  // exact balance
  expect(ins).toBe(amount + tip + c.changeGrains + c.feeGrains);
  expect(ins).toBe(outs + c.feeGrains);
  expect(c.feeGrains > 0n).toBe(true);
  expect(c.tipGrains).toBe(tip);
  // change: none, or at least dust
  expect(c.changeGrains === 0n || c.changeGrains >= DUST_LIMIT_GRAINS).toBe(true);
  // destination output first and exact
  expect(c.outputs[0]!.address).toBe(DEST);
  expect(c.outputs[0]!.amountGrains).toBe(amount);
  expect(c.amountGrains).toBe(amount);
  // tip / change outputs where expected, nothing else
  let n = 1;
  if (tip > 0n) {
    expect(c.outputs[n]!.address).toBe(tipAddressFor("mainnet"));
    expect(c.outputs[n]!.amountGrains).toBe(tip);
    n++;
  }
  if (c.changeGrains > 0n) {
    expect(c.outputs[n]!.address).toBe(POOL[0]);
    expect(c.outputs[n]!.amountGrains).toBe(c.changeGrains);
    n++;
  }
  expect(c.outputs.length).toBe(n);
  // inputs: unique, from the set, within cap, never pending
  expect(c.utxos.length).toBeGreaterThan(0);
  expect(c.utxos.length).toBeLessThanOrEqual(maxInputs);
  const seen = new Set<string>();
  for (const u of c.utxos) {
    const k = okey(u);
    expect(seen.has(k)).toBe(false);
    seen.add(k);
    const src = byKey.get(k);
    expect(src).toBeDefined();
    expect(u.valueGrains).toBe(src!.valueGrains);
    expect(u.scriptHex).toBe(src!.scriptHex);
    expect(excluded.has(k)).toBe(false);
  }
  // fee is the size estimate, plus at most the sub-dust leftover folded in
  // when there is no change output
  const est = fee(c.utxos.length, c.outputs.length, 2n);
  if (c.changeGrains > 0n) expect(c.feeGrains).toBe(est);
  else {
    expect(c.feeGrains >= est).toBe(true);
    expect(c.feeGrains - est < DUST_LIMIT_GRAINS + PER_P2TR_OUTPUT_VBYTES * 2n).toBe(true);
  }
}

/** Independent soundness check of a refusal: no subset of the (deduped,
 *  non-pending) coins of size k ≤ cap could pay amount+tip+fee(k).  The
 *  best size-k subset is the k largest coins. */
function provablyShort(avail: PoolUtxo[], need0: bigint, outputs: number, cap: number): { short: boolean; firstCoveringK: number } {
  const sorted = [...avail].sort((a, b) => (a.valueGrains > b.valueGrains ? -1 : a.valueGrains < b.valueGrains ? 1 : 0));
  let s = 0n;
  for (let k = 1; k <= sorted.length; k++) {
    s += sorted[k - 1]!.valueGrains;
    if (s >= need0 + fee(k, outputs, 2n)) return { short: k > cap, firstCoveringK: k };
  }
  return { short: true, firstCoveringK: -1 };
}

function dedupe(us: PoolUtxo[]): PoolUtxo[] {
  const seen = new Set<string>();
  return us.filter((u) => (seen.has(okey(u)) ? false : (seen.add(okey(u)), true)));
}

beforeEach(() => {
  vi.restoreAllMocks();
  useMemoryStorage();
  clearPendingSpends();
  current = [];
  serveCurrent();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── P1 ──────────────────────────────────────────────────────────────────

const P1_SEED = 0x5eed0001;
const P1_CASES = 600;

describe("P1 composePearlSend — exact balance or typed refusal", () => {
  it(`${P1_CASES} random UTXO sets × amounts (seed ${P1_SEED.toString(16)})`, async () => {
    const rng = new Rng(P1_SEED);
    const tally = { ok: 0, insufficient: 0, tooMany: 0, amount: 0 };
    for (let i = 0; i < P1_CASES; i++) {
      const coins = randomCoins(rng, 1, 300);
      current = coins;
      const total = sumOf(coins);
      const amount = randomAmount(rng, total);
      const includeTip = rng.bool();
      const maxInputs = rng.bool(0.3) ? rng.int(1, 20) : rng.bool(0.5) ? MAX_SEND_INPUTS : rng.int(1, 300);
      const useCache = rng.bool(0.7);
      const ctx = () => describeCase(P1_SEED, i, { amount, includeTip, maxInputs, useCache, coins: coins.length });
      try {
        const c = await composePearlSend({
          network: "mainnet",
          pool: [POOL[0]!],
          destination: DEST,
          amountGrains: amount,
          includeTip,
          maxInputs,
          cachedUtxos: useCache ? coins : undefined,
        });
        expect(amount > 0n, ctx()).toBe(true);
        checkComposed(c, coins, amount, includeTip, maxInputs, new Set());
        tally.ok++;
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        const tip = includeTip && amount > 0n ? computeTipGrains(amount) : 0n;
        const outputs = tip > 0n ? 2 : 1;
        if (e.message === "E_AMOUNT") {
          expect(amount <= 0n, ctx()).toBe(true);
          tally.amount++;
        } else if (e.message === "E_AMOUNT_DUST") {
          // Typed refusal for an output that would not relay.
          expect(amount > 0n && amount <= DUST_LIMIT_GRAINS, ctx()).toBe(true);
          tally.amount++;
        } else if (e instanceof InsufficientFundsError) {
          // Sound: no subset of any size can pay.
          const p = provablyShort(dedupe(coins), amount + tip, outputs, Number.MAX_SAFE_INTEGER);
          expect(p.firstCoveringK, ctx()).toBe(-1);
          expect(e.have).toBe(sumOf(dedupe(coins)));
          tally.insufficient++;
        } else if (e instanceof TooManyInputsError) {
          // Sound: the cheapest covering selection needs more than the cap.
          const p = provablyShort(dedupe(coins), amount + tip, outputs, maxInputs);
          expect(p.short && p.firstCoveringK > maxInputs, ctx()).toBe(true);
          expect(e.inputsNeeded).toBe(p.firstCoveringK);
          expect(e.maxInputs).toBe(maxInputs);
          expect(e.maxSendableGrains < amount, ctx()).toBe(true);
          tally.tooMany++;
        } else {
          throw new Error(`untyped refusal ${e.message} :: ${ctx()}`);
        }
      }
    }
    // Every branch of the property was exercised.
    expect(tally.ok).toBeGreaterThan(100);
    expect(tally.insufficient).toBeGreaterThan(10);
    expect(tally.tooMany).toBeGreaterThan(5);
    expect(tally.amount).toBeGreaterThan(5);
  });

  // Separate property so a failure here does not mask P1's balance checks.
  it(`destination output is above dust or the send is refused (seed ${(P1_SEED + 1).toString(16)})`, async () => {
    const rng = new Rng(P1_SEED + 1);
    const violations: string[] = [];
    let refusedDust = 0;
    for (let i = 0; i < 500; i++) {
      const coins = randomCoins(rng, 1, 30);
      current = coins;
      const amount = rng.big(1n, DUST_LIMIT_GRAINS + 10n);
      const includeTip = rng.bool();
      try {
        const c = await composePearlSend({
          network: "mainnet",
          pool: [POOL[0]!],
          destination: DEST,
          amountGrains: amount,
          includeTip,
          cachedUtxos: coins,
        });
        if (c.outputs[0]!.amountGrains <= DUST_LIMIT_GRAINS) {
          violations.push(describeCase(P1_SEED + 1, i, { amount, includeTip, coins: coins.length }));
        }
      } catch (e) {
        if (e instanceof Error && e.message === "E_AMOUNT_DUST") {
          expect(amount <= DUST_LIMIT_GRAINS).toBe(true);
          refusedDust++;
          continue;
        }
        if (!(e instanceof InsufficientFundsError || e instanceof TooManyInputsError)) throw e;
      }
    }
    expect(refusedDust).toBeGreaterThan(400);
    expect(violations.slice(0, 3), `dust destination outputs composed: ${violations.length}`).toEqual([]);
  });
});

// ─── P2 ──────────────────────────────────────────────────────────────────

const P2_SEED = 0x5eed0002;
const P2_CASES = 500;

describe("P2 computeMaxSendable — composes to an exact spend", () => {
  it(`${P2_CASES} random wallets (seed ${P2_SEED.toString(16)})`, async () => {
    const rng = new Rng(P2_SEED);
    let exactCases = 0;
    const mismatches: string[] = [];
    for (let i = 0; i < P2_CASES; i++) {
      const coins = randomCoins(rng, 1, 300);
      current = coins;
      const includeTip = rng.bool();
      const maxInputs = rng.bool(0.3) ? rng.int(1, 30) : MAX_SEND_INPUTS;
      const ctx = () => describeCase(P2_SEED, i, { includeTip, maxInputs, coins: coins.length });
      const spendable = sumOf(dedupe(coins));
      const m = computeMaxSendable({ utxos: coins, includeTip, maxInputs });
      expect(m.amountGrains + m.tipGrains + m.feeGrains + m.changeGrains, ctx()).toBe(m.inputGrains);
      expect(m.inputGrains <= spendable, ctx()).toBe(true);
      expect(m.inputs.length <= maxInputs, ctx()).toBe(true);
      if (m.amountGrains === 0n) {
        expect(m.inputs.length).toBe(0);
        continue;
      }
      expect(m.amountGrains > DUST_LIMIT_GRAINS, ctx()).toBe(true);
      expect(m.feeGrains > 0n, ctx()).toBe(true);
      expect(m.tipGrains).toBe(includeTip ? computeTipGrains(m.amountGrains) : 0n);
      if (!m.exact) {
        // Only the documented tip-floor gap may return change.
        expect(includeTip && m.amountGrains === TIP_MIN_GRAINS - 1n, ctx()).toBe(true);
      } else {
        expect(m.changeGrains).toBe(0n);
      }
      const c = await composePearlSend({
        network: "mainnet",
        pool: [POOL[0]!],
        destination: DEST,
        amountGrains: m.amountGrains,
        includeTip,
        maxInputs,
        cachedUtxos: coins,
      });
      checkComposed(c, coins, m.amountGrains, includeTip, maxInputs, new Set());
      expect(sumOf(c.utxos) <= m.inputGrains, ctx()).toBe(true);
      // Documented contract (pearl-tx.ts computeMaxSendable): when `exact`,
      // composing the returned amount selects the same inputs and produces
      // the same fee. In the tip-floor gap (!exact) compose may pick fewer
      // inputs; its own plan (checked above) is what is shown and signed, and
      // it never costs more fee than the preview.
      // Collected rather than thrown so the remaining cases still run.
      const sameInputs =
        c.utxos.length === m.inputs.length && c.utxos.every((u) => m.inputs.some((x) => okey(x) === okey(u)));
      const gapOk = !m.exact && c.amountGrains === m.amountGrains && c.feeGrains <= m.feeGrains;
      if (!gapOk && (!sameInputs || c.feeGrains !== m.feeGrains || c.changeGrains !== m.changeGrains)) {
        mismatches.push(
          describeCase(P2_SEED, i, {
            exact: m.exact,
            amount: m.amountGrains,
            maxInputs: m.inputs.length,
            maxFee: m.feeGrains,
            maxChange: m.changeGrains,
            composedInputs: c.utxos.length,
            composedFee: c.feeGrains,
            composedChange: c.changeGrains,
          }),
        );
      }
      if (m.exact) {
        exactCases++;
        // One more grain cannot be sent within the cap.
        await expect(
          composePearlSend({
            network: "mainnet",
            pool: [POOL[0]!],
            destination: DEST,
            amountGrains: m.amountGrains + 1n,
            includeTip,
            maxInputs,
            cachedUtxos: coins,
          }),
          ctx(),
        ).rejects.toSatisfy((e) => e instanceof InsufficientFundsError || e instanceof TooManyInputsError);
      }
    }
    expect(exactCases).toBeGreaterThan(300);
    expect(mismatches.slice(0, 3), `max/compose input-set or fee mismatches: ${mismatches.length}`).toEqual([]);
  });
});

// Minimal (shrunk) counterexamples found on 4f53f1c, kept as deterministic
// regressions: the dust refusal (fixed in composePearlSend) and the
// tip-floor-gap send-max contract (documented; compose's plan is signed).
describe("shrunk counterexamples", () => {
  const coin = (n: number, v: bigint): PoolUtxo => ({
    txid: n.toString(16).padStart(64, "0"),
    vout: 0,
    valueGrains: v,
    scriptHex: DUMMY_SCRIPT,
    branch: 0,
    index: 0,
  });

  it("composePearlSend refuses a destination output at or below dust (1 coin of 1 PRL, amount 1 grain)", async () => {
    current = [coin(1, PRL)];
    const r = await composePearlSend({
      network: "mainnet",
      pool: [POOL[0]!],
      destination: DEST,
      amountGrains: 1n,
      includeTip: false,
      cachedUtxos: current,
    }).catch((e: unknown) => e);
    // On HEAD this composes outputs[0] = 1 grain (non-relayable dust).
    expect(r instanceof Error ? "refused" : `composed dest=${(r as ComposedPearlTx).outputs[0]!.amountGrains}`).toBe("refused");
  });

  it("send-max in the tip-floor gap: the composed plan balances and costs no more fee than the preview (coins 1.5 PRL + 1000 grains, tip on)", async () => {
    current = [coin(1, 150_000_000n), coin(2, 1000n)];
    const m = computeMaxSendable({ utxos: current, includeTip: true });
    expect(m.exact).toBe(false);
    expect(m.amountGrains).toBe(TIP_MIN_GRAINS - 1n);
    const c = await composePearlSend({
      network: "mainnet",
      pool: [POOL[0]!],
      destination: DEST,
      amountGrains: m.amountGrains,
      includeTip: true,
      cachedUtxos: current,
    });
    // Max previews 2 inputs / fee 426 (with change); compose picks 1 input /
    // fee 310. The composed plan is the one confirmed and signed.
    expect(c.amountGrains).toBe(m.amountGrains);
    expect(c.feeGrains <= m.feeGrains).toBe(true);
    expect(sumOf(c.utxos)).toBe(c.amountGrains + c.tipGrains + c.feeGrains + c.changeGrains);
  });
});

// ─── P3 ──────────────────────────────────────────────────────────────────

const P3_SEED = 0x5eed0003;
const P3_CASES = 500;

describe("P3 composeConsolidation — batch invariants", () => {
  let dest: ConsolidationDestination;
  beforeAll(async () => {
    const seed = await bip39.mnemonicToSeed(MNEMONIC);
    const acct = publicAccountNode(masterFromSeed(seed), pearlAccountPath());
    dest = { address: pearlBranchAddressRange(acct, "mainnet", 0, 0, 1)[0]!, branch: 0, index: 0 };
  });

  it(`${P3_CASES} random coin sets (seed ${P3_SEED.toString(16)})`, () => {
    const rng = new Rng(P3_SEED);
    let multiBatch = 0;
    for (let i = 0; i < P3_CASES; i++) {
      const big = rng.bool(0.1);
      const coins = randomCoins(rng, 1, big ? 1200 : 300, rng.bool(0.3) ? 100_000n : MAX_COIN);
      const feerate = BigInt(rng.int(1, 6));
      const maxInputs = rng.bool(0.5) ? rng.int(2, 40) : rng.int(2, CONSOLIDATION_MAX_INPUTS);
      const ctx = () => describeCase(P3_SEED, i, { feerate, maxInputs, coins: coins.length });
      const plan = composeConsolidation({ utxos: coins, destination: dest, feerateSatPerVbyte: feerate, maxInputs });
      const byKey = new Map(dedupe(coins).map((u) => [okey(u), u]));
      const used = new Set<string>();
      let inTotal = 0n;
      let feeTotal = 0n;
      let recvTotal = 0n;
      for (const b of plan.batches) {
        assertConsolidationBatch(b);
        expect(b.output.amountGrains, ctx()).toBe(b.inputGrains - b.feeGrains);
        expect(sumOf(b.utxos), ctx()).toBe(b.inputGrains);
        expect(b.feeGrains > 0n).toBe(true);
        expect(b.utxos.length >= 2 && b.utxos.length <= maxInputs, ctx()).toBe(true);
        expect(b.vbytes <= CONSOLIDATION_MAX_VBYTES).toBe(true);
        expect(b.output.address).toBe(dest.address);
        expect(b.destination).toEqual(dest);
        for (const u of b.utxos) {
          const k = okey(u);
          expect(used.has(k), ctx()).toBe(false);
          used.add(k);
          const src = byKey.get(k);
          expect(src, ctx()).toBeDefined();
          expect(u.valueGrains).toBe(src!.valueGrains);
          expect(u.valueGrains > marginalInputFee(feerate)).toBe(true);
        }
        inTotal += b.inputGrains;
        feeTotal += b.feeGrains;
        recvTotal += b.output.amountGrains;
      }
      expect(plan.totalInputGrains).toBe(inTotal);
      expect(plan.totalFeeGrains).toBe(feeTotal);
      expect(plan.totalReceiveGrains).toBe(recvTotal);
      expect(recvTotal).toBe(inTotal - feeTotal);
      // Every positive coin is accounted for exactly once.
      const positive = [...byKey.values()].filter((u) => u.valueGrains > 0n);
      expect(used.size + plan.dust.count + plan.uneconomic.count + plan.leftover.count, ctx()).toBe(positive.length);
      expect(inTotal + plan.dust.grains + plan.uneconomic.grains + plan.leftover.grains, ctx()).toBe(sumOf(positive));
      if (plan.batches.length > 1) multiBatch++;
    }
    expect(multiBatch).toBeGreaterThan(20);
  });
});

// ─── P4 ──────────────────────────────────────────────────────────────────

const P4_SEED = 0x5eed0004;
const P4_CASES = 2000;

describe("P4 tip", () => {
  it(`computeTipGrains over ${P4_CASES} random amounts (seed ${P4_SEED.toString(16)})`, () => {
    const rng = new Rng(P4_SEED);
    for (let i = 0; i < P4_CASES; i++) {
      const a = rng.bool(0.1) ? rng.big(-1000n, 0n) : rng.bool(0.2) ? rng.big(PRL - 5n, PRL + 5n) : rng.logBig(10n ** 18n);
      const t = computeTipGrains(a);
      const formula = (a * TIP_BPS) / 10_000n > TIP_MIN_GRAINS ? (a * TIP_BPS) / 10_000n : TIP_MIN_GRAINS;
      // max(amount × 10 / 10000, 1 PRL), except: no tip on amounts below
      // the 1 PRL floor (documented in chains/pearl/tip.ts — a 1 PRL tip on
      // a 0.01 PRL send would be 100× the principal).
      if (a < TIP_MIN_GRAINS) expect(t, `a=${a}`).toBe(0n);
      else expect(t, `a=${a}`).toBe(formula);
      expect(t >= 0n).toBe(true);
    }
  });

  it(`tip disabled adds nothing; enabled never silently overdraws (${500} sends, seed ${(P4_SEED + 1).toString(16)})`, async () => {
    const rng = new Rng(P4_SEED + 1);
    let tipped = 0;
    let refusedForTip = 0;
    for (let i = 0; i < 500; i++) {
      const coins = randomCoins(rng, 1, 40, rng.bool(0.5) ? 5n * PRL : MAX_COIN);
      current = coins;
      const balance = sumOf(coins);
      const amount = rng.bool(0.4) ? rng.big(PRL, PRL * 3n) : randomAmount(rng, balance);
      if (amount <= 0n) continue;
      const ctx = () => describeCase(P4_SEED + 1, i, { amount, balance });
      const base = { network: "mainnet" as const, pool: [POOL[0]!], destination: DEST, amountGrains: amount, cachedUtxos: coins };
      const off = await composePearlSend({ ...base, includeTip: false }).catch((e: unknown) => e);
      const on = await composePearlSend({ ...base, includeTip: true }).catch((e: unknown) => e);
      if (!(off instanceof Error)) {
        expect(off.tipGrains).toBe(0n);
        expect(off.outputs.some((o) => o.address === tipAddressFor("mainnet")), ctx()).toBe(false);
      }
      if (!(on instanceof Error)) {
        const tip = computeTipGrains(amount);
        expect(on.tipGrains).toBe(tip);
        // total spent fits within the inputs (and therefore the balance)
        expect(on.amountGrains + on.tipGrains + on.feeGrains + on.changeGrains).toBe(sumOf(on.utxos));
        expect(sumOf(on.utxos) <= balance, ctx()).toBe(true);
        if (tip > 0n) tipped++;
      } else if (on.message === "E_AMOUNT_DUST") {
        expect(amount <= DUST_LIMIT_GRAINS, ctx()).toBe(true);
        expect(off instanceof Error && off.message === "E_AMOUNT_DUST", ctx()).toBe(true);
      } else {
        expect(on instanceof InsufficientFundsError || on instanceof TooManyInputsError, ctx()).toBe(true);
        if (!(off instanceof Error)) refusedForTip++;
        if (on instanceof InsufficientFundsError) {
          // the refusal names the tip-inclusive need
          expect(on.need >= amount + computeTipGrains(amount), ctx()).toBe(true);
        }
      }
    }
    expect(tipped).toBeGreaterThan(50);
    expect(refusedForTip).toBeGreaterThan(5);
  });
});

// ─── P5 ──────────────────────────────────────────────────────────────────

const P5_SEED = 0x5eed0005;
const P5_CASES = 60;

describe("P5 signing round trip (test mnemonic only)", () => {
  let seed: Uint8Array;
  let ext: string[];
  let int: string[];
  const scripts = new Map<string, string>();
  const scriptOf = (b: HdBranch, i: number) => scripts.get(`${b}/${i}`)!;

  beforeAll(async () => {
    seed = await bip39.mnemonicToSeed(MNEMONIC);
    const master = masterFromSeed(seed);
    const acct = publicAccountNode(master, pearlAccountPath());
    ext = pearlBranchAddressRange(acct, "mainnet", 0, 0, 8);
    int = pearlBranchAddressRange(acct, "mainnet", 1, 0, 8);
    for (const b of [0, 1] as const) {
      for (let i = 0; i < 8; i++) {
        scripts.set(`${b}/${i}`, hex(p2trScriptForInternalKey(master.derive(pearlBranchPath(b, i)).publicKey!.slice(1))));
      }
    }
  });

  function verifyAll(raw: string, ins: readonly { txid: string; vout: number; scriptHex: string; valueGrains: bigint }[]): number {
    const prev = new Map(ins.map((u) => [`${u.txid}:${u.vout}`, { script: unhex(u.scriptHex), amount: u.valueGrains }]));
    const tx = btc.Transaction.fromRaw(unhex(raw));
    expect(tx.inputsLength).toBe(ins.length);
    const ss: Uint8Array[] = [];
    const as: bigint[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const p = prev.get(`${hex(inp.txid!)}:${inp.index}`)!;
      expect(p).toBeDefined();
      ss.push(p.script);
      as.push(p.amount);
    }
    let ok = 0;
    for (let i = 0; i < tx.inputsLength; i++) {
      const w = tx.getInput(i).finalScriptWitness!;
      expect(w.length).toBe(1);
      expect(w[0]!.length).toBe(64);
      const msg = tx.preimageWitnessV1(i, ss, btc.SigHash.DEFAULT, as);
      if (schnorr.verify(w[0]!, msg, ss[i]!.slice(2))) ok++;
    }
    return ok;
  }

  it(`${P5_CASES} random composed plans from receive + change coins (seed ${P5_SEED.toString(16)})`, async () => {
    const rng = new Rng(P5_SEED);
    for (let c = 0; c < P5_CASES; c++) {
      const n = rng.int(1, 6);
      const coins: PoolUtxo[] = [];
      for (let k = 0; k < n; k++) {
        const branch = rng.pick([0, 1] as const);
        const index = rng.int(0, 7);
        coins.push({ txid: txid(rng), vout: rng.int(0, 2), valueGrains: rng.big(100_000n, 50n * PRL), scriptHex: scriptOf(branch, index), branch, index });
      }
      current = coins;
      const total = sumOf(coins);
      const includeTip = rng.bool();
      const amount = rng.big(DUST_LIMIT_GRAINS + 1n, total / 2n > DUST_LIMIT_GRAINS + 1n ? total / 2n : DUST_LIMIT_GRAINS + 1n);
      const ctx = describeCase(P5_SEED, c, { n, amount, includeTip });
      let composed: ComposedPearlTx;
      try {
        composed = await composePearlSend({
          network: "mainnet",
          pool: [ext[0]!],
          destination: OTHER_DEST,
          amountGrains: amount,
          includeTip,
          cachedUtxos: coins,
        });
      } catch (e) {
        expect(e instanceof InsufficientFundsError, ctx).toBe(true);
        continue;
      }
      const req = {
        utxos: composed.utxos.map((u) => ({ ...u, valueGrains: u.valueGrains.toString() })),
        outputs: composed.outputs.map((o) => ({ address: o.address, amountGrains: o.amountGrains.toString() })),
        network: "mainnet" as const,
        maxFeeGrains: composed.feeGrains.toString(),
      };
      const { raw } = signPearlTxWithSeed(seed, req);
      expect(verifyAll(raw, composed.utxos), ctx).toBe(composed.utxos.length);
      // The signed tx pays exactly the composed outputs.
      const tx = btc.Transaction.fromRaw(unhex(raw));
      expect(tx.outputsLength).toBe(composed.outputs.length);
      for (let o = 0; o < tx.outputsLength; o++) expect(tx.getOutput(o).amount).toBe(composed.outputs[o]!.amountGrains);
      // A fee ceiling one grain below the real fee is refused.
      expect(() => signPearlTxWithSeed(seed, { ...req, maxFeeGrains: (composed.feeGrains - 1n).toString() })).toThrow("E_PEARL_FEE_ABOVE_LIMIT");
      // Foreign input: swap one input's script for another key's / another wallet's.
      const victim = rng.int(0, req.utxos.length - 1);
      const v = req.utxos[victim]!;
      const wrongScript = rng.bool()
        ? FOREIGN_SCRIPT
        : scriptOf(v.branch === 0 ? 1 : 0, v.index); // same index, other branch
      const tampered = req.utxos.map((u, j) => (j === victim ? { ...u, scriptHex: wrongScript } : u));
      expect(() => signPearlTxWithSeed(seed, { ...req, utxos: tampered }), ctx).toThrow("E_PEARL_FOREIGN_INPUT");
      // Wrong (branch, index) claim for a correct script.
      const relabeled = req.utxos.map((u, j) => (j === victim ? { ...u, index: (u.index + 1) % 8 } : u));
      expect(() => signPearlTxWithSeed(seed, { ...req, utxos: relabeled }), ctx).toThrow("E_PEARL_FOREIGN_INPUT");
    }
  });

  it("consolidation plans sign and verify; foreign destination refused (20 cases)", () => {
    const rng = new Rng(P5_SEED + 1);
    for (let c = 0; c < 20; c++) {
      const n = rng.int(2, 6);
      const coins: PoolUtxo[] = [];
      for (let k = 0; k < n; k++) {
        const branch = rng.pick([0, 1] as const);
        const index = rng.int(0, 7);
        coins.push({ txid: txid(rng), vout: 0, valueGrains: rng.big(PRL / 100n, 20n * PRL), scriptHex: scriptOf(branch, index), branch, index });
      }
      const dIdx = rng.int(0, 7);
      const dBranch = rng.pick([0, 1] as const);
      const destination = { address: (dBranch === 0 ? ext : int)[dIdx]!, branch: dBranch, index: dIdx };
      const plan = composeConsolidation({ utxos: coins, destination, feerateSatPerVbyte: BigInt(rng.int(1, 4)) });
      expect(plan.batches.length).toBe(1);
      const b = plan.batches[0]!;
      const req = {
        utxos: b.utxos.map((u) => ({ ...u, valueGrains: u.valueGrains.toString() })) as PearlUtxoSpec[],
        outputs: [{ address: b.output.address, amountGrains: b.output.amountGrains.toString() }],
        destination: { branch: dBranch, index: dIdx },
        network: "mainnet" as const,
      };
      const { raw } = signPearlConsolidationWithSeed(seed, req);
      expect(verifyAll(raw, b.utxos)).toBe(b.utxos.length);
      expect(() => signPearlConsolidationWithSeed(seed, { ...req, outputs: [{ ...req.outputs[0]!, address: OTHER_DEST }] })).toThrow(
        "E_CONSOLIDATION_FOREIGN_OUTPUT",
      );
      expect(() => signPearlConsolidationWithSeed(seed, { ...req, destination: { branch: dBranch, index: (dIdx + 1) % 8 } })).toThrow(
        "E_CONSOLIDATION_FOREIGN_OUTPUT",
      );
    }
  });
});

// ─── P6 ──────────────────────────────────────────────────────────────────

const P6_SEED = 0x5eed0006;
const P6_CASES = 500;

describe("P6 pending spends — excluded outpoints never selected", () => {
  it(`${P6_CASES} random sets with random pending records (seed ${P6_SEED.toString(16)})`, async () => {
    const rng = new Rng(P6_SEED);
    let allPending = 0;
    let selected = 0;
    for (let i = 0; i < P6_CASES; i++) {
      clearPendingSpends();
      const coins = randomCoins(rng, 1, 120);
      current = coins;
      const unique = dedupe(coins);
      // Mark a random subset (sometimes all, sometimes the largest coins)
      // as spent by recorded broadcasts.
      const mode = rng.int(0, 3);
      const pend =
        mode === 0
          ? unique
          : mode === 1
            ? [...unique].sort((a, b) => (a.valueGrains > b.valueGrains ? -1 : 1)).slice(0, rng.int(1, Math.max(1, unique.length >> 1)))
            : unique.filter(() => rng.bool(0.3));
      let r = 0;
      for (let j = 0; j < pend.length; j += 7) {
        const id = (0xabc000 + i * 64 + r++).toString(16).padStart(64, "0");
        addRecord(id, pend.slice(j, j + 7), { state: rng.bool() ? "unknown" : "accepted" });
      }
      const excluded = new Set(pend.map(okey));
      expect(pendingOutpoints()).toEqual(excluded);
      const rest = unique.filter((u) => !excluded.has(okey(u)));
      const restSum = sumOf(rest);
      const includeTip = rng.bool();
      const amount = rng.bool(0.3) ? sumOf(unique) / 2n + 1n : randomAmount(rng, restSum > 0n ? restSum : 1000n);
      const ctx = () => describeCase(P6_SEED, i, { amount, coins: coins.length, pending: excluded.size, mode });

      // composePearlSend (cache path and live-walk path)
      for (const useCache of [true, false]) {
        try {
          const c = await composePearlSend({
            network: "mainnet",
            pool: [POOL[0]!],
            destination: DEST,
            amountGrains: amount,
            includeTip,
            cachedUtxos: useCache ? coins : undefined,
          });
          checkComposed(c, coins, amount, includeTip, MAX_SEND_INPUTS, excluded);
          expect(c.spendableGrains, ctx()).toBe(restSum);
          selected++;
        } catch (e) {
          if (e instanceof NoSpendableCoinsError) {
            expect(rest.length, ctx()).toBe(0);
            allPending++;
          } else if (e instanceof InsufficientFundsError) {
            expect(e.have, ctx()).toBe(restSum);
          } else if (e instanceof Error && e.message === "E_AMOUNT_DUST") {
            expect(amount <= DUST_LIMIT_GRAINS, ctx()).toBe(true);
          } else if (!(e instanceof TooManyInputsError) && !(e instanceof Error && e.message === "E_AMOUNT")) {
            throw e;
          }
        }
      }
      // computeMaxSendable
      const m = computeMaxSendable({ utxos: coins, includeTip });
      for (const u of m.inputs) expect(excluded.has(okey(u)), ctx()).toBe(false);
      expect(m.inputGrains <= restSum).toBe(true);
      // composeConsolidation
      const plan = composeConsolidation({ utxos: coins, destination: { address: POOL[0]!, branch: 0, index: 0 } });
      for (const b of plan.batches) for (const u of b.utxos) expect(excluded.has(okey(u)), ctx()).toBe(false);
      expect(plan.pendingExcluded, ctx()).toBe(unique.filter((u) => u.valueGrains > 0n && excluded.has(okey(u))).length);
    }
    expect(selected).toBeGreaterThan(200);
    expect(allPending).toBeGreaterThan(10);
  });
});
