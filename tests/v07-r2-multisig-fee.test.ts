// FY1 (R1-A3 / Sonnet F6): the multisig composer must pay at least the
// requested feerate for every supported vault shape. Pre-fix it assumed a
// flat 100 vB per vault input, so a 15-of-15 1-in/2-out spend paid
// 394 grains for 519 vB (0.76 grains/vB at the 2 grains/vB default).
//
// The test runs the REAL composer (composeVaultSend) against the REAL crypto
// worker module (loaded with a minimal `self` shim and session restored from
// the public "abandon … about" mnemonic), signs with every required cosigner
// slot through the worker's signPearlMultisigPsbt, finalises with
// finalizeVaultPsbt and measures the finalised transaction's vsize.
// Only the UTXO read is mocked. Nothing is broadcast.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as btc from "@scure/btc-signer";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hex } from "@scure/base";
import { masterFromSeed, pearlMultisigPath } from "../src/crypto/hd";
import { bytesToHex, hexToBytes } from "../src/crypto/descriptor";
import { vaultDescriptorFromPubkeys } from "../src/chains/pearl/multisig";
import { pearlParams } from "../src/chains/pearl/network";
import { cryptoWorker } from "../src/crypto/worker-client";
import * as rpc from "../src/services/pearl-rpc";
import {
  composeVaultSend,
  finalizeVaultPsbt,
  wireDescriptorFromRecord,
  DUST_LIMIT_GRAINS,
} from "../src/services/multisig";
import type { VaultRecord } from "../src/storage/db";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const master = masterFromSeed(mnemonicToSeedSync(MNEMONIC));
const xonly = (i: number) => master.derive(pearlMultisigPath(0, i)).publicKey!.slice(1);

type Resp = { id: string; ok: boolean; result?: unknown; error?: string };
const g = globalThis as unknown as { self?: unknown };
const prevSelf = g.self;
let dispatch: (ev: { data: unknown; origin: string }) => Promise<void>;
let lastResp: Resp | null = null;

async function workerCall<R>(cmd: string, args: Record<string, unknown>): Promise<R> {
  lastResp = null;
  await dispatch({ data: { id: "t", cmd, ...args }, origin: "" });
  const r = lastResp as Resp | null;
  if (!r) throw new Error("no worker response");
  if (!r.ok) throw new Error(r.error);
  return r.result as R;
}

beforeAll(async () => {
  const fakeSelf: { location: { origin: string }; postMessage: (m: Resp) => void; onmessage?: unknown } = {
    location: { origin: "" },
    postMessage: (m: Resp) => {
      lastResp = m;
    },
  };
  g.self = fakeSelf;
  await import("../src/crypto/worker");
  dispatch = fakeSelf.onmessage as typeof dispatch;
  await workerCall("restoreWallet", { mnemonic: MNEMONIC, password: "fee-test-pw", network: "mainnet" });
  vi.spyOn(cryptoWorker, "call").mockImplementation(((cmd: string, args: Record<string, unknown>) =>
    workerCall(cmd, args)) as typeof cryptoWorker.call);
}, 60_000);

afterAll(() => {
  vi.restoreAllMocks();
  g.self = prevSelf;
});

function vaultRecord(m: number, n: number): VaultRecord {
  const keys = Array.from({ length: n }, (_, i) => xonly(i));
  const d = vaultDescriptorFromPubkeys(m, keys, pearlParams("mainnet"));
  return {
    id: `fee-${m}-${n}`,
    version: 1,
    label: `${m}-of-${n}`,
    threshold: m,
    total: n,
    sortedPubkeysHex: d.sortedPubkeys.map(bytesToHex),
    myPubkeyHex: bytesToHex(keys[0]!),
    myOriginPath: pearlMultisigPath(0, 0),
    myVaultAccount: 0,
    myKeyIndex: 0,
    pearlAddress: d.address,
    network: "mainnet",
    createdAt: 1,
  } as VaultRecord;
}

interface Measured {
  fee: bigint;
  vsize: number;
  inputs: number;
  outputs: number;
  quotedFee: bigint;
}

async function composeSignFinalize(rec: VaultRecord, coins: bigint[], amount: bigint): Promise<Measured> {
  const d = vaultDescriptorFromPubkeys(rec.threshold, rec.sortedPubkeysHex.map(hexToBytes), pearlParams("mainnet"));
  const spy = vi.spyOn(rpc, "fetchPrlUtxos").mockResolvedValue({
    utxos: coins.map((v, i) => ({
      txid: (i + 1).toString(16).padStart(2, "0").repeat(32),
      vout: i,
      valueGrains: v,
      scriptHex: bytesToHex(d.outputScript),
      confirmations: 100,
    })),
    degraded: false,
    droppedNoScript: 0,
  } as Awaited<ReturnType<typeof rpc.fetchPrlUtxos>>);
  try {
    const composed = await composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: amount });
    // Sign with the first `threshold` cosigner slots (all derived from the
    // test mnemonic at m/…/0'/i), each through the worker.
    let psbt = composed.psbtBase64;
    for (let i = 0; i < rec.threshold; i++) {
      const r = await workerCall<{ psbtBase64: string }>("signPearlMultisigPsbt", {
        req: { psbtBase64: psbt, descriptor: wireDescriptorFromRecord(rec), vaultAccount: 0, keyIndex: i },
      });
      psbt = r.psbtBase64;
    }
    const { rawHex } = finalizeVaultPsbt(psbt);
    const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true });
    const inSum = composed.utxos.reduce((a, u) => a + u.valueGrains, 0n);
    let outSum = 0n;
    for (let i = 0; i < tx.outputsLength; i++) outSum += tx.getOutput(i).amount!;
    return { fee: inSum - outSum, vsize: tx.vsize, inputs: tx.inputsLength, outputs: tx.outputsLength, quotedFee: composed.feeGrains };
  } finally {
    spy.mockRestore();
  }
}

const SHAPES: Array<[number, number]> = [];
for (let n = 1; n <= 15; n++) {
  const ms = new Set([1, Math.ceil(n / 2), n]);
  for (const m of ms) SHAPES.push([m, n]);
}
for (const s of [[2, 3], [3, 5], [8, 15], [5, 9], [11, 15]] as Array<[number, number]>) {
  if (!SHAPES.some(([m, n]) => m === s[0] && n === s[1])) SHAPES.push(s);
}

describe("FY1 multisig fee covers the finalised transaction size", () => {
  it.each(SHAPES)("%i-of-%i: 1 input + change pays >= 2 grains/vB, overestimate < 15%%", async (m, n) => {
    const rec = vaultRecord(m, n);
    const r = await composeSignFinalize(rec, [200_000_000n], 100_000_000n);
    expect(r.inputs).toBe(1);
    expect(r.outputs).toBe(2);
    expect(r.fee).toBe(r.quotedFee);
    const rate = Number(r.fee) / r.vsize;
    expect(rate, `${m}-of-${n}: fee ${r.fee} for ${r.vsize} vB`).toBeGreaterThanOrEqual(2);
    expect(rate).toBeGreaterThanOrEqual(1);
    expect(rate / 2 - 1, `${m}-of-${n} overestimate`).toBeLessThan(0.15);
  });

  it.each([
    [2, 3],
    [8, 15],
    [15, 15],
  ])("%i-of-%i: three inputs (no single coin covers it) still meet the feerate", async (m, n) => {
    const rec = vaultRecord(m, n);
    const r = await composeSignFinalize(rec, [40_000_000n, 40_000_000n, 40_000_000n], 100_000_000n);
    expect(r.inputs).toBe(3);
    expect(r.fee).toBe(r.quotedFee);
    const rate = Number(r.fee) / r.vsize;
    expect(rate).toBeGreaterThanOrEqual(2);
    expect(rate / 2 - 1).toBeLessThan(0.15);
  });

  it("15-of-15 dust-change coalesce: single output, fee still >= feerate and preview-consistent", async () => {
    const rec = vaultRecord(15, 15);
    // Find the 2-output fee first, then fund so change would be sub-dust.
    const probe = await composeSignFinalize(rec, [200_000_000n], 100_000_000n);
    const amount = 1_000_000n;
    const coin = amount + probe.quotedFee + DUST_LIMIT_GRAINS - 1n;
    const r = await composeSignFinalize(rec, [coin], amount);
    expect(r.outputs).toBe(1);
    expect(r.fee).toBe(r.quotedFee);
    expect(Number(r.fee) / r.vsize).toBeGreaterThanOrEqual(2);
  });
});
