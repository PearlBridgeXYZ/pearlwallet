// R4 L4 / L5 — one vault input ceiling for compose, cosign and import; the
// too-many-coins refusal names the limit that binds.
//
// Before (e06cf60): composeVaultSend capped a vault spend at 500 inputs
// (1-of-1, 2-of-3) or 319 (8-of-15), but the cosign-request auto-import
// (recoverVaultFromPsbt) refused anything above 256 inputs, so a cosigner
// could not import a max-size PSBT this very wallet composed. And the
// refusal always blamed the 100,000 vbyte size limit, also when the input
// count was what bound.
//
// Runs the REAL composer, the REAL import and the REAL worker signer
// (public "abandon … about" mnemonic); only the UTXO read is mocked.
// Nothing is broadcast.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as btc from "@scure/btc-signer";
import { mnemonicToSeedSync } from "@scure/bip39";
import { base64 } from "@scure/base";
import { masterFromSeed, pearlMultisigPath } from "../src/crypto/hd";
import { bytesToHex, hexToBytes } from "../src/crypto/descriptor";
import { vaultDescriptorFromPubkeys } from "../src/chains/pearl/multisig";
import { pearlParams } from "../src/chains/pearl/network";
import { cryptoWorker } from "../src/crypto/worker-client";
import * as rpc from "../src/services/pearl-rpc";
import * as multisig from "../src/services/multisig";
import { recoverVaultFromPsbt, VaultRecoveryError } from "../src/services/vault-import";
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
  await workerCall("restoreWallet", { mnemonic: MNEMONIC, password: "ceiling-test-pw", network: "mainnet" });
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
    id: `ceil-${m}-${n}`, version: 1, label: `${m}-of-${n}`, threshold: m, total: n,
    sortedPubkeysHex: d.sortedPubkeys.map(bytesToHex), myPubkeyHex: bytesToHex(keys[0]!),
    myOriginPath: pearlMultisigPath(0, 0), myVaultAccount: 0, myKeyIndex: 0,
    pearlAddress: d.address, network: "mainnet", createdAt: 1,
  } as VaultRecord;
}
const descOf = (rec: VaultRecord) => vaultDescriptorFromPubkeys(rec.threshold, rec.sortedPubkeysHex.map(hexToBytes), pearlParams("mainnet"));
function mockCoins(rec: VaultRecord, count: number, value: bigint) {
  const d = descOf(rec);
  return vi.spyOn(rpc, "fetchPrlUtxos").mockResolvedValue({
    utxos: Array.from({ length: count }, (_, i) => ({
      txid: (i + 1).toString(16).padStart(64, "0"), vout: 0, valueGrains: value,
      scriptHex: bytesToHex(d.outputScript), confirmations: 100,
    })),
    degraded: false,
    droppedNoScript: 0,
  } as Awaited<ReturnType<typeof rpc.fetchPrlUtxos>>);
}
const estVsize = (inputs: number, outputs: number, per: bigint) => 11n + BigInt(inputs) * per + BigInt(outputs) * 43n;
const sign = (rec: VaultRecord, psbt: string, keyIndex: number) =>
  workerCall<{ psbtBase64: string }>("signPearlMultisigPsbt", {
    req: { psbtBase64: psbt, descriptor: multisig.wireDescriptorFromRecord(rec), vaultAccount: 0, keyIndex },
  });

/** `psbt` with one more input of the same vault (a copy of input 0 spending another outpoint). */
function withOneMoreInput(psbt: string): string {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbt));
  const in0 = tx.getInput(0);
  tx.addInput({
    txid: hexToBytes("ff".repeat(32)), index: 7,
    witnessUtxo: in0.witnessUtxo!, tapInternalKey: in0.tapInternalKey!, tapLeafScript: in0.tapLeafScript!,
  });
  return base64.encode(tx.toPSBT());
}

describe("L4 — one shared vault input ceiling", () => {
  it("every m-of-n vault's compose cap is within the shared ceiling (what import and cosign accept) and under the size limit", () => {
    expect(multisig.MAX_VAULT_INPUTS).toBe(256);
    for (let n = 1; n <= 15; n++) {
      for (let m = 1; m <= n; m++) {
        const per = multisig.multisigInputVbytes(descOf(vaultRecord(m, n)));
        const cap = multisig.maxVaultInputs(per);
        expect(cap, `${m}-of-${n}`).toBeLessThanOrEqual(multisig.MAX_VAULT_INPUTS); // pre-fix: 500 for small vaults
        expect(estVsize(cap, 2, per), `${m}-of-${n}`).toBeLessThan(100_000n);
      }
    }
  });

  it("2-of-3: a max-size compose round-trips through the wallet's own import and cosign paths; one input more is refused by both", async () => {
    const rec = vaultRecord(2, 3);
    const value = 1_000_000n;
    const spy = mockCoins(rec, 300, value);
    try {
      // Needs every coin: refused with the most one transaction can send.
      const err = await multisig.composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: value * 290n }).catch((e) => e);
      expect(err).toBeInstanceOf(multisig.VaultTooManyInputsError); // pre-fix: composed ~293 inputs
      const max = await multisig.composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: (err as multisig.VaultTooManyInputsError).maxSendableGrains });
      expect(max.utxos).toHaveLength(multisig.MAX_VAULT_INPUTS);
      // Import (a cosigner's auto-import of the cosign request) accepts it.
      const recovered = recoverVaultFromPsbt(max.psbtBase64);
      expect(recovered.address).toBe(rec.pearlAddress);
      expect(recovered.threshold).toBe(2);
      // Cosign accepts it: two cosigners sign all 256 inputs; it finalises.
      const s1 = await sign(rec, max.psbtBase64, 0);
      const s2 = await sign(rec, s1.psbtBase64, 1);
      expect(multisig.inspectPsbt(s2.psbtBase64, 2).thresholdMet).toBe(true);
      expect(multisig.finalizeVaultPsbt(s2.psbtBase64).rawHex.length).toBeGreaterThan(0);
      // One input more: refused by import and by cosign, nothing signed.
      const over = withOneMoreInput(max.psbtBase64);
      expect(() => recoverVaultFromPsbt(over)).toThrow(VaultRecoveryError);
      await expect(sign(rec, over, 0)).rejects.toThrow("E_MULTISIG_TOO_MANY_INPUTS");
      // R5 L-c: the refusal carries the count and reads as plain copy on
      // the cosign / pending-tx sign paths.
      const overErr = await sign(rec, over, 0).catch((e) => e);
      expect((overErr as Error).message).toBe("E_MULTISIG_TOO_MANY_INPUTS: 257");
      const { vaultSignErrorMessage } = await import("../src/ui/vault-messages");
      expect(vaultSignErrorMessage(overErr)).toBe(
        "Nothing was signed: this transaction spends 257 vault coins, and this wallet signs at most 256 per vault transaction. Ask the sender to send less, or to combine the vault's coins first.",
      );
      // And the worker never composes above it either.
      await expect(
        workerCall("composePearlMultisigPsbt", {
          req: {
            descriptor: multisig.wireDescriptorFromRecord(rec), network: "mainnet",
            utxos: Array.from({ length: multisig.MAX_VAULT_INPUTS + 1 }, (_, i) => ({
              txid: (i + 1).toString(16).padStart(64, "0"), vout: 0, valueGrains: "1000000", scriptHex: bytesToHex(descOf(rec).outputScript),
            })),
            outputs: [{ address: rec.pearlAddress, amountGrains: "1000" }],
          },
        }),
      ).rejects.toThrow("E_MULTISIG_TOO_MANY_INPUTS");
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});

describe("L5 — the too-many-coins refusal names the limit that binds", () => {
  it("count-bound (2-of-3: 256 inputs): names the per-transaction coin limit, not the size limit", async () => {
    const { vaultTooManyInputsMessage } = await import("../src/ui/pages/SendFromVault");
    const rec = vaultRecord(2, 3);
    const spy = mockCoins(rec, 300, 1_000_000n);
    try {
      const err = (await multisig.composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: 290_000_000n }).catch((e) => e)) as multisig.VaultTooManyInputsError;
      expect(err.binding).toBe("count");
      expect(err.maxInputs).toBe(256);
      const msg = vaultTooManyInputsMessage(err);
      expect(msg).toContain("at most 256");
      expect(msg).toContain("the most coins this wallet signs or imports in one vault transaction");
      // R5 L-d: it does not claim other cosigners' wallets enforce it.
      expect(msg).not.toMatch(/cosigner/i);
      expect(msg).not.toContain("100,000 vbytes"); // pre-fix: blamed the size limit
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("size-bound (15-of-15: 234 inputs): names the 100,000 vbyte relay limit", async () => {
    const { vaultTooManyInputsMessage } = await import("../src/ui/pages/SendFromVault");
    const rec = vaultRecord(15, 15);
    const spy = mockCoins(rec, 300, 1_000_000n);
    try {
      const err = (await multisig.composeVaultSend({ vault: rec, destination: rec.pearlAddress, amountGrains: 290_000_000n }).catch((e) => e)) as multisig.VaultTooManyInputsError;
      expect(err.binding).toBe("size");
      expect(err.maxInputs).toBe(234);
      const msg = vaultTooManyInputsMessage(err);
      expect(msg).toContain("at most 234");
      expect(msg).toContain("100,000 vbytes");
      expect(msg).not.toContain("the most coins this wallet signs");
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

describe("L7 — SendFromVault doc comments sit on the functions they describe", () => {
  it("the dust-copy comment is on vaultDustMessage, the refusal comment on vaultTooManyInputsMessage", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/ui/pages/SendFromVault.tsx", "utf8");
    expect(src).toMatch(/\/\*\* Same copy as Send PRL for a destination output at or below dust\. \*\/\nexport function vaultDustMessage\(/);
    expect(src).toMatch(/\*\/\nexport function vaultTooManyInputsMessage\(/);
    expect(src).not.toMatch(/\*\/\n\/\*\*/); // no doc comment stacked on another
  });
});
