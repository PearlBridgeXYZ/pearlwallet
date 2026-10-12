// R3 FZ5 (Sonnet S3 / F1) — a vault send never composes a transaction above
// the 100,000 vB standard relay limit. Before (8054da3) composeVaultSend
// had no input cap: a 15-of-15 vault with 300 small coins composed a
// 293-input, ~123,818 vB spend that every cosigner would sign and the
// network would refuse.
//
// Runs the REAL composer against the REAL worker module (public "abandon …
// about" mnemonic); only the UTXO read is mocked. Nothing is broadcast.
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
import * as multisig from "../src/services/multisig";
import { TooManyInputsError } from "../src/services/pearl-tx";
import type { VaultRecord } from "../src/storage/db";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
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
    postMessage: (m: Resp) => { lastResp = m; },
  };
  g.self = fakeSelf;
  await import("../src/crypto/worker");
  dispatch = fakeSelf.onmessage as typeof dispatch;
  await workerCall("restoreWallet", { mnemonic: MNEMONIC, password: "cap-test-pw", network: "mainnet" });
  vi.spyOn(cryptoWorker, "call").mockImplementation(((cmd: string, args: Record<string, unknown>) => workerCall(cmd, args)) as typeof cryptoWorker.call);
}, 60_000);
afterAll(() => {
  vi.restoreAllMocks();
  g.self = prevSelf;
});

function vaultRecord(m: number, n: number): VaultRecord {
  const keys = Array.from({ length: n }, (_, i) => xonly(i));
  const d = vaultDescriptorFromPubkeys(m, keys, pearlParams("mainnet"));
  return {
    id: `cap-${m}-${n}`, version: 1, label: `${m}-of-${n}`, threshold: m, total: n,
    sortedPubkeysHex: d.sortedPubkeys.map(bytesToHex), myPubkeyHex: bytesToHex(keys[0]!),
    myOriginPath: pearlMultisigPath(0, 0), myVaultAccount: 0, myKeyIndex: 0,
    pearlAddress: d.address, network: "mainnet", createdAt: 1,
  } as VaultRecord;
}
function mockCoins(rec: VaultRecord, count: number, value: bigint) {
  const d = vaultDescriptorFromPubkeys(rec.threshold, rec.sortedPubkeysHex.map(hexToBytes), pearlParams("mainnet"));
  return vi.spyOn(rpc, "fetchPrlUtxos").mockResolvedValue({
    utxos: Array.from({ length: count }, (_, i) => ({
      txid: (i + 1).toString(16).padStart(64, "0"), vout: 0, valueGrains: value,
      scriptHex: bytesToHex(d.outputScript), confirmations: 100,
    })),
    degraded: false,
    droppedNoScript: 0,
  } as Awaited<ReturnType<typeof rpc.fetchPrlUtxos>>);
}
function perInput(rec: VaultRecord): bigint {
  const d = vaultDescriptorFromPubkeys(rec.threshold, rec.sortedPubkeysHex.map(hexToBytes), pearlParams("mainnet"));
  return multisig.multisigInputVbytes(d);
}
const estVsize = (inputs: number, outputs: number, per: bigint) => 11n + BigInt(inputs) * per + BigInt(outputs) * 43n;

describe("FZ5 — vault sends are capped below the 100,000 vB standard limit", () => {
  it.each([
    [15, 15, 300, 1_000_000n],
    [2, 3, 1_200, 1_000_000n],
  ] as const)("%i-of-%i: a send needing too many coins is refused with the max sendable; that max composes under the limit", async (m, n, count, value) => {
    const rec = vaultRecord(m, n);
    const per = perInput(rec);
    const cap = multisig.maxVaultInputs(per);
    expect(estVsize(cap, 2, per)).toBeLessThan(100_000n);
    expect(cap === 500 || estVsize(cap + 1, 2, per) >= 100_000n).toBe(true);
    const spy = mockCoins(rec, count, value);
    try {
      // Needs (almost) every coin: far above the cap.
      const amount = value * BigInt(count - 10);
      const err = await multisig.composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: amount }).catch((e) => e);
      expect(err).toBeInstanceOf(multisig.VaultTooManyInputsError); // pre-fix: composed (no error)
      expect(err).toBeInstanceOf(TooManyInputsError);
      const e = err as multisig.VaultTooManyInputsError;
      expect(e.code).toBe("E_TOO_MANY_INPUTS");
      expect(e.maxInputs).toBe(cap);
      expect(e.inputsNeeded).toBeGreaterThan(cap);
      expect(e.utxoCount).toBe(count);
      expect(e.maxSendableGrains).toBe(value * BigInt(cap) - estVsize(cap, 2, per) * 2n);
      // The max sendable composes, within the cap and the size limit.
      const ok = await multisig.composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: e.maxSendableGrains });
      expect(ok.utxos.length).toBeLessThanOrEqual(cap);
      expect(estVsize(ok.utxos.length, ok.outputs.length, per)).toBeLessThan(100_000n);
      const inSum = ok.utxos.reduce((a, u) => a + u.valueGrains, 0n);
      const outSum = ok.outputs.reduce((a, o) => a + o.amountGrains, 0n);
      expect(inSum - outSum).toBe(ok.feeGrains);
      // The composed PSBT has exactly those inputs.
      const tx = btc.Transaction.fromPSBT(Buffer.from(ok.psbtBase64, "base64"), { allowUnknownOutputs: true });
      expect(tx.inputsLength).toBe(ok.utxos.length);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  it("15-of-15: the cap is exactly 234 inputs and the estimate it uses bounds the real signed size", async () => {
    const rec = vaultRecord(15, 15);
    const per = perInput(rec);
    expect(multisig.maxVaultInputs(per)).toBe(234);
    expect(multisig.maxVaultInputs(perInput(vaultRecord(2, 3)))).toBe(500); // MAX_SEND_INPUTS binds first
    // Sign + finalise a 4-input spend: the per-input estimate the cap is
    // computed from is at least the real per-input size (so 234 real
    // inputs stay under the limit too). Signing all 234 × 15 is too slow
    // for the unit suite.
    const value = 1_000_000n;
    const spy = mockCoins(rec, 4, value);
    try {
      const amount = value * 4n - estVsize(4, 2, per) * 2n;
      const composed = await multisig.composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: amount });
      expect(composed.utxos.length).toBe(4);
      let psbt = composed.psbtBase64;
      for (let i = 0; i < rec.threshold; i++) {
        const r = await workerCall<{ psbtBase64: string }>("signPearlMultisigPsbt", {
          req: { psbtBase64: psbt, descriptor: multisig.wireDescriptorFromRecord(rec), vaultAccount: 0, keyIndex: i },
        });
        psbt = r.psbtBase64;
      }
      const { rawHex } = multisig.finalizeVaultPsbt(psbt);
      const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true });
      expect(BigInt(tx.vsize)).toBeLessThanOrEqual(estVsize(4, tx.outputsLength, per));
      // Per-input share of the real size, extrapolated to the cap.
      const realPer = (tx.vsize - 11 - 43 * tx.outputsLength) / 4;
      expect(11 + 234 * realPer + 2 * 43).toBeLessThan(100_000);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  it("the vault send page shows the refusal readably", async () => {
    const { vaultTooManyInputsMessage } = await import("../src/ui/pages/SendFromVault");
    const msg = vaultTooManyInputsMessage(new multisig.VaultTooManyInputsError(293, 236, 300, 300_000_000n, 230_000_000n));
    expect(msg).toContain("needs 293 vault coins");
    expect(msg).toContain("at most 236");
    expect(msg).toContain("100,000 vbytes");
    expect(msg).toMatch(/most you can send in one transaction is 2\.3 PRL/);
    expect(msg).not.toMatch(/E_TOO_MANY_INPUTS/);
  });
});
