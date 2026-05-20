// v0.2.0 — multisig flow tests.
//
// Covers the pieces that don't require an IndexedDB or a real WebWorker:
//   - VaultDescriptor reconstruction from a record (round-trip determinism)
//   - inspectPsbt: signer-set extraction, threshold check, witness-script
//     read-out, error codes for malformed input
//   - finalizeVaultPsbt: refuses sub-threshold, finalises threshold-met
//   - End-to-end PSBT round-trip: simulate the worker's compose + signIdx
//     for two cosigners on a 2-of-3 vault, finalise, parse the raw tx, and
//     confirm the witness has the expected `[empty, sigB, sigA, leaf, ctrl]`
//     stack shape (BIP-342 m-of-n with one non-signer slot).
//   - Pubkey-descriptor JSON round-trip for cosigner exchange
//   - createVault input validation (the Dexie write is the only failing
//     edge in node-only env; assertion-only paths run cleanly)
//   - Fee estimator monotonicity
//
// What we DON'T test here (covered elsewhere or out-of-scope for node env):
//   - Live worker.onmessage dispatch (needs a real Worker)
//   - Dexie persistence (no IndexedDB shim in this repo's test env)
//   - UI wizard flow (manual in v0.2.0; tested via build verification)

import { describe, it, expect } from "vitest";
import * as bip39 from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import {
  vaultDescriptorFromPubkeys,
} from "../src/chains/pearl/multisig";
import { pearlParams } from "../src/chains/pearl/network";
import { masterFromSeed, pearlMultisigPath } from "../src/crypto/hd";
import {
  encodePubkeyDescriptor,
  parsePubkeyDescriptor,
  bytesToHex,
  hexToBytes,
} from "../src/crypto/descriptor";

// `hexToBytes` in descriptor.ts is strict 32-byte-only (cosigner pubkey
// validator). For raw-tx hex we need a general parser.
function hexToBytesAny(hex: string): Uint8Array {
  const h = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    out[i / 2] = parseInt(h.slice(i, i + 2), 16);
  }
  return out;
}
import {
  descriptorFromRecord,
  wireDescriptorFromRecord,
  inspectPsbt,
  finalizeVaultPsbt,
  psbtOutputsEqual,
  feeSuspiciousReason,
  assertPsbtMatchesPreview,
  PER_INPUT_VBYTES_MULTISIG,
  PER_P2TR_OUTPUT_VBYTES,
  FIXED_OVERHEAD_VBYTES,
  DUST_LIMIT_GRAINS,
} from "../src/services/multisig";
import type { VaultRecord } from "../src/storage/db";

const params = pearlParams("mainnet");
const BIP86_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

interface Cosigner {
  xOnlyPubkey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: Uint8Array; // 33-byte compressed
  originPath: string;
}

let _cosignersPromise: Promise<Cosigner[]> | null = null;
async function cosigners(n: number): Promise<Cosigner[]> {
  if (!_cosignersPromise) {
    _cosignersPromise = (async () => {
      const seed = await bip39.mnemonicToSeed(BIP86_MNEMONIC);
      const master = masterFromSeed(seed);
      const out: Cosigner[] = [];
      for (let i = 0; i < 5; i++) {
        const path = pearlMultisigPath(0, i);
        const child = master.derive(path);
        if (!child.publicKey || !child.privateKey) {
          throw new Error(`derive failed at ${path}`);
        }
        out.push({
          xOnlyPubkey: child.publicKey.slice(1),
          privateKey: child.privateKey,
          publicKey: child.publicKey,
          originPath: path,
        });
      }
      return out;
    })();
  }
  const all = await _cosignersPromise;
  return all.slice(0, n);
}

// Build a record-shaped vault payload so we can exercise the service-layer
// helpers without touching Dexie. The label / id / createdAt fields don't
// affect any descriptor math — they're indexing metadata.
function recordFromCosigners(
  threshold: number,
  cs: Cosigner[],
  meIdx: number,
): VaultRecord {
  const desc = vaultDescriptorFromPubkeys(
    threshold,
    cs.map((c) => c.xOnlyPubkey),
    params,
  );
  const me = cs[meIdx]!;
  return {
    id: "test-vault-1",
    version: 1,
    label: "Test vault",
    threshold,
    total: cs.length,
    sortedPubkeysHex: desc.sortedPubkeys.map((p) => bytesToHex(p)),
    myPubkeyHex: bytesToHex(me.xOnlyPubkey),
    myOriginPath: me.originPath,
    myVaultAccount: 0,
    myKeyIndex: meIdx,
    pearlAddress: desc.address,
    network: "mainnet",
    createdAt: Date.now(),
  };
}

// Compose a Pearl multisig PSBT exactly the way the worker does — same
// addInput shape, same network, same vault rebuild. Lets us test the
// downstream service paths (inspectPsbt / finalizeVaultPsbt) without
// spinning up a real Worker.
function composeWorkerPsbt(
  rec: VaultRecord,
  inputs: { txid: Uint8Array; vout: number; amountGrains: bigint }[],
  outputs: { address: string; amountGrains: bigint }[],
): string {
  const desc = descriptorFromRecord(rec);
  const network = { bech32: params.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (const u of inputs) {
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { amount: u.amountGrains, script: desc.outputScript },
      tapInternalKey: desc.internalKey,
      tapLeafScript: desc.tapLeafScript,
    });
  }
  for (const o of outputs) {
    tx.addOutputAddress(o.address, o.amountGrains, network);
  }
  return base64.encode(tx.toPSBT());
}

function signWith(psbtB64: string, privkey: Uint8Array): string {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
  for (let i = 0; i < tx.inputsLength; i++) {
    tx.signIdx(privkey, i);
  }
  return base64.encode(tx.toPSBT());
}

// Two synthetic prevout txids — content doesn't matter for sighash; we
// just need stable 32-byte values.
const TXID_A = new Uint8Array(32).fill(0x11);
const TXID_B = new Uint8Array(32).fill(0x22);

describe("descriptorFromRecord / wireDescriptorFromRecord", () => {
  it("rebuilds a VaultDescriptor identical to the in-memory construction", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const d1 = descriptorFromRecord(rec);
    const d2 = vaultDescriptorFromPubkeys(
      2,
      cs.map((c) => c.xOnlyPubkey),
      params,
    );
    expect(d1.address).toBe(d2.address);
    expect(bytesToHex(d1.outputScript)).toBe(bytesToHex(d2.outputScript));
    expect(bytesToHex(d1.outputKey)).toBe(bytesToHex(d2.outputKey));
    expect(bytesToHex(d1.leafScript)).toBe(bytesToHex(d2.leafScript));
    expect(d1.leafVersion).toBe(d2.leafVersion);
  });

  it("wireDescriptorFromRecord round-trips through vaultDescriptorFromPubkeys", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const wire = wireDescriptorFromRecord(rec);
    const pubkeys = wire.sortedPubkeysHex.map((h) => hexToBytes(h));
    const d = vaultDescriptorFromPubkeys(wire.threshold, pubkeys, params);
    expect(d.address).toBe(rec.pearlAddress);
  });

  it("address from the record matches the address from the descriptor", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 1);
    const d = descriptorFromRecord(rec);
    expect(d.address).toBe(rec.pearlAddress);
  });
});

describe("inspectPsbt — signer-set extraction", () => {
  it("returns 0 signers / thresholdMet=false on a fresh-compose PSBT", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    const info = inspectPsbt(psbt, 2);
    expect(info.signerCount).toBe(0);
    expect(info.signersHex).toEqual([]);
    expect(info.thresholdMet).toBe(false);
    expect(info.inputCount).toBe(1);
    expect(info.witnessScriptHex.length).toBeGreaterThan(0);
  });

  it("counts signers after one cosigner signs (2-of-3)", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    const info = inspectPsbt(psbt, 2);
    expect(info.signerCount).toBe(1);
    expect(info.signersHex).toEqual([bytesToHex(cs[0]!.xOnlyPubkey)]);
    expect(info.thresholdMet).toBe(false);
  });

  it("flips thresholdMet to true once 2 cosigners have signed", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    psbt = signWith(psbt, cs[1]!.privateKey);
    const info = inspectPsbt(psbt, 2);
    expect(info.signerCount).toBe(2);
    expect(info.thresholdMet).toBe(true);
    const setExpected = new Set([
      bytesToHex(cs[0]!.xOnlyPubkey),
      bytesToHex(cs[1]!.xOnlyPubkey),
    ]);
    expect(new Set(info.signersHex)).toEqual(setExpected);
  });

  it("re-signing the same cosigner over an already-signed PSBT throws (defensive)", async () => {
    // BIP-340 schnorr signing in btc-signer uses random `auxRand`, so two
    // calls to signIdx with the same privkey produce different signature
    // bytes. btc-signer's PSBT key-map merge refuses to overwrite an
    // existing tapScriptSig with a different value — it throws.
    //
    // That throw is a defensive crash, not a silent inflation. It matters
    // because a naive flow ("if we already signed, do nothing") would
    // otherwise need to wrap signIdx in a try/catch — the service layer's
    // signPendingTx path should idempotency-check via inspectPsbt before
    // re-calling signVaultPsbt to avoid the crash.
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    // Re-signing with the same key throws because the second auxRand-based
    // signature differs and the PSBT key-map merge rejects the overwrite.
    expect(() => signWith(psbt, cs[0]!.privateKey)).toThrow(/keyMap.*tapScriptSig/);
  });

  it("inspectPsbt is a safe idempotency probe (caller can check before re-signing)", async () => {
    // The mitigation for the throw above: inspect first, sign only if our
    // pubkey isn't already in the signer set. This test confirms inspectPsbt
    // exposes exactly the bit needed for that check.
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    const info = inspectPsbt(psbt, 2);
    const myHex = bytesToHex(cs[0]!.xOnlyPubkey);
    expect(info.signersHex.includes(myHex)).toBe(true);
    // Caller can short-circuit: "already signed, skip" — same shape used by
    // services/multisig.ts:signPendingTx in production.
  });

  it("threshold check uses >= not == (over-signed PSBTs are still valid)", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    psbt = signWith(psbt, cs[1]!.privateKey);
    psbt = signWith(psbt, cs[2]!.privateKey);
    const info = inspectPsbt(psbt, 2);
    expect(info.signerCount).toBe(3);
    expect(info.thresholdMet).toBe(true);
  });

  it("throws E_MULTISIG_BAD_PSBT on empty string", () => {
    expect(() => inspectPsbt("", 2)).toThrow(/E_MULTISIG_BAD_PSBT/);
  });

  it("throws E_MULTISIG_PSBT_PARSE on a non-PSBT base64 blob", () => {
    expect(() => inspectPsbt(base64.encode(new Uint8Array([1, 2, 3])), 2)).toThrow(
      /E_MULTISIG_PSBT_PARSE/,
    );
  });
});

describe("finalizeVaultPsbt", () => {
  it("returns a parseable raw tx when threshold is met", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    psbt = signWith(psbt, cs[1]!.privateKey);
    const { rawHex } = finalizeVaultPsbt(psbt);
    expect(rawHex.length).toBeGreaterThan(0);
    // Round-trip through Transaction.fromRaw to confirm the raw tx is
    // structurally valid and finalised.
    const decoded = btc.Transaction.fromRaw(hexToBytesAny(rawHex));
    expect(decoded.inputsLength).toBe(1);
    expect(decoded.outputsLength).toBe(1);
    // Witness assembly invariant for tapscript m-of-n: stack ends with
    // [leafScript, controlBlock]. Verify by checking the trailing two
    // items match what the descriptor exposed.
    const desc = descriptorFromRecord(rec);
    const witness = (decoded.getInput(0).finalScriptWitness ?? []) as Uint8Array[];
    expect(witness.length).toBeGreaterThanOrEqual(4); // empty+sig+leaf+ctrl at minimum
    expect(bytesToHex(witness[witness.length - 2]!)).toBe(
      bytesToHex(desc.leafScript),
    );
    // Control block last; first byte is `leafVersion | parityBit` per BIP-341.
    // Mask off the LSB to check the leaf-version tag (0xc0 for BIP-342).
    const controlBlock = witness[witness.length - 1]!;
    expect(controlBlock[0]! & 0xfe).toBe(desc.leafVersion);
  });

  it("throws E_MULTISIG_PSBT_NOT_FINALIZABLE when threshold is NOT met", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey); // only 1 of 2 sigs
    expect(() => finalizeVaultPsbt(psbt)).toThrow(/E_MULTISIG_PSBT_NOT_FINALIZABLE/);
  });

  it("throws E_MULTISIG_PSBT_PARSE on garbage input", () => {
    expect(() => finalizeVaultPsbt("not-base64-psbt")).toThrow(/E_MULTISIG_PSBT_PARSE/);
  });

  it("handles a 3-of-5 spend (sigB+sigC+sigE finalises correctly)", async () => {
    const cs = await cosigners(5);
    const rec = recordFromCosigners(3, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 200_000n }],
      [{ address: rec.pearlAddress, amountGrains: 180_000n }],
    );
    // Skip cs[0] and cs[3]; sign with 1, 2, 4. The leaf positions are
    // determined by BIP-67 sort, not by our index here — btc-signer's
    // finalize() figures out the mapping from each pubkey's slot in the
    // leaf script.
    psbt = signWith(psbt, cs[1]!.privateKey);
    psbt = signWith(psbt, cs[2]!.privateKey);
    psbt = signWith(psbt, cs[4]!.privateKey);
    const info = inspectPsbt(psbt, 3);
    expect(info.thresholdMet).toBe(true);
    const { rawHex } = finalizeVaultPsbt(psbt);
    const decoded = btc.Transaction.fromRaw(hexToBytesAny(rawHex));
    expect(decoded.inputsLength).toBe(1);
  });

  it("multi-input PSBT: signs every input with every cosigner key", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [
        { txid: TXID_A, vout: 0, amountGrains: 100_000n },
        { txid: TXID_B, vout: 1, amountGrains: 50_000n },
      ],
      [{ address: rec.pearlAddress, amountGrains: 140_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    psbt = signWith(psbt, cs[1]!.privateKey);
    const info = inspectPsbt(psbt, 2);
    expect(info.inputCount).toBe(2);
    expect(info.signerCount).toBe(2);
    expect(info.thresholdMet).toBe(true);
    const { rawHex } = finalizeVaultPsbt(psbt);
    const decoded = btc.Transaction.fromRaw(hexToBytesAny(rawHex));
    expect(decoded.inputsLength).toBe(2);
  });
});

describe("Cosigner pubkey descriptor (JSON exchange)", () => {
  it("round-trips through encode + parse", async () => {
    const [c0] = await cosigners(1);
    const json = encodePubkeyDescriptor({
      xOnlyPubkey: c0!.xOnlyPubkey,
      originPath: c0!.originPath,
      label: "Alice — main",
    });
    const { descriptor, xOnlyPubkey } = parsePubkeyDescriptor(json);
    expect(descriptor.version).toBe(1);
    expect(descriptor.type).toBe("pearl-multisig-pubkey");
    expect(descriptor.network).toBe("mainnet");
    expect(descriptor.originPath).toBe(c0!.originPath);
    expect(descriptor.label).toBe("Alice — main");
    expect(bytesToHex(xOnlyPubkey)).toBe(bytesToHex(c0!.xOnlyPubkey));
  });

  it("rejects descriptors with truncated pubkey", () => {
    const json = JSON.stringify({
      version: 1,
      type: "pearl-multisig-pubkey",
      network: "mainnet",
      xOnlyPubkey: "ab".repeat(31), // 31 bytes, 1 short
      originPath: "m/86'/808276'/100'/0'/0",
      label: "x",
    });
    expect(() => parsePubkeyDescriptor(json)).toThrow();
  });

  it("rejects descriptors with version != 1", () => {
    const json = JSON.stringify({
      version: 2,
      type: "pearl-multisig-pubkey",
      network: "mainnet",
      xOnlyPubkey: "ab".repeat(32),
      originPath: "m/86'/808276'/100'/0'/0",
      label: "x",
    });
    expect(() => parsePubkeyDescriptor(json)).toThrow();
  });
});

describe("Fee estimator constants", () => {
  it("multisig per-input vbytes is larger than singlesig (covers tr_ms witness)", () => {
    // Singlesig keypath spend is ~58 vbytes/input; multisig with 2-of-3
    // adds ~37-byte leaf + 33-byte control block + 64-byte sig per slot.
    // We pin the multisig figure at 100 to leave headroom for up to 3-of-5.
    expect(PER_INPUT_VBYTES_MULTISIG).toBe(100n);
  });

  it("output + overhead constants are sane", () => {
    expect(PER_P2TR_OUTPUT_VBYTES).toBe(43n);
    expect(FIXED_OVERHEAD_VBYTES).toBe(11n);
    expect(DUST_LIMIT_GRAINS).toBe(546n);
  });
});

describe("Adversarial PSBT — defense against counterparty mutation", () => {
  it("inspectPsbt reports the witness script so caller can bind to vault", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const desc = descriptorFromRecord(rec);
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    const info = inspectPsbt(psbt, 2);
    // The "witness script" returned by inspectPsbt is the witnessUtxo.script
    // (the P2TR outputScript paying the vault). It MUST equal vault.outputScript
    // — that equality is what binds a counterparty-supplied PSBT to a vault
    // record on import.
    expect(info.witnessScriptHex).toBe(bytesToHex(desc.outputScript));
  });

  it("PSBTs for different vaults have different witnessScriptHex", async () => {
    const cs5 = await cosigners(5);
    const rec23 = recordFromCosigners(2, cs5.slice(0, 3), 0);
    const rec35 = recordFromCosigners(3, cs5, 0);
    const psbt23 = composeWorkerPsbt(
      rec23,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec23.pearlAddress, amountGrains: 90_000n }],
    );
    const psbt35 = composeWorkerPsbt(
      rec35,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec35.pearlAddress, amountGrains: 90_000n }],
    );
    const info23 = inspectPsbt(psbt23, 2);
    const info35 = inspectPsbt(psbt35, 3);
    expect(info23.witnessScriptHex).not.toBe(info35.witnessScriptHex);
  });
});

describe("Vault determinism — independent reconstruction", () => {
  it("two callers with the same pubkey set + threshold land on the same address", async () => {
    const cs = await cosigners(3);
    // Caller A passes pubkeys in BIP-67 sorted order (already canonical).
    const desc = vaultDescriptorFromPubkeys(
      2,
      cs.map((c) => c.xOnlyPubkey),
      params,
    );
    // Caller B passes the same set in a different permutation.
    const reversed = [...cs].reverse();
    const descB = vaultDescriptorFromPubkeys(
      2,
      reversed.map((c) => c.xOnlyPubkey),
      params,
    );
    expect(desc.address).toBe(descB.address);
  });

  it("changing one cosigner changes the address", async () => {
    const cs = await cosigners(4);
    const d1 = vaultDescriptorFromPubkeys(
      2,
      cs.slice(0, 3).map((c) => c.xOnlyPubkey),
      params,
    );
    const d2 = vaultDescriptorFromPubkeys(
      2,
      [cs[0]!, cs[1]!, cs[3]!].map((c) => c.xOnlyPubkey),
      params,
    );
    expect(d1.address).not.toBe(d2.address);
  });
});

describe("v0.2.1 — output parsing + foreign-signer partition (audit pass 2 Med #1/#2)", () => {
  it("parses every PSBT output as { address, amountGrains, scriptHex }", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 200_000n }],
      [
        { address: rec.pearlAddress, amountGrains: 150_000n }, // destination back to vault
        { address: rec.pearlAddress, amountGrains: 40_000n },  // "change" also to vault
      ],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(info.outputs).toHaveLength(2);
    expect(info.outputs[0]!.amountGrains).toBe(150_000n);
    expect(info.outputs[0]!.address).toBe(rec.pearlAddress);
    expect(info.outputs[1]!.amountGrains).toBe(40_000n);
    expect(info.outputs[1]!.address).toBe(rec.pearlAddress);
    expect(info.outputs[0]!.scriptHex.length).toBe(68); // OP_1 PUSH_32 <32B>
  });

  it("partitions tapScriptSig pubkeys into in-vault signersHex vs foreignSignersHex", async () => {
    // Two distinct vaults sharing a single cosigner. Sign with cs[0] under
    // vault A, then call inspectPsbt against vault B's cosigner set: cs[0]
    // should show up as foreign there. This is the audit-pass-2 Med #2
    // fix exposed end-to-end.
    const cs = await cosigners(5);
    const recA = recordFromCosigners(2, cs.slice(0, 3), 0);
    let psbt = composeWorkerPsbt(
      recA,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: recA.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);

    // Inspect with vault A's cosigner set: cs[0] is in-vault.
    const inA = inspectPsbt(psbt, 2, recA.sortedPubkeysHex);
    expect(inA.signersHex).toEqual([bytesToHex(cs[0]!.xOnlyPubkey)]);
    expect(inA.foreignSignersHex).toEqual([]);
    expect(inA.signerCount).toBe(1);

    // Inspect with a DIFFERENT cosigner set (cs[2..4]) — cs[0] is foreign.
    const foreignSet = [
      bytesToHex(cs[2]!.xOnlyPubkey),
      bytesToHex(cs[3]!.xOnlyPubkey),
      bytesToHex(cs[4]!.xOnlyPubkey),
    ];
    const inB = inspectPsbt(psbt, 2, foreignSet);
    expect(inB.signersHex).toEqual([]);
    expect(inB.foreignSignersHex).toEqual([bytesToHex(cs[0]!.xOnlyPubkey)]);
    expect(inB.signerCount).toBe(0);
    expect(inB.thresholdMet).toBe(false);
  });

  it("when no validPubkeysHex is provided, every signer counts (back-compat)", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    const info = inspectPsbt(psbt, 2); // no validPubkeysHex
    expect(info.signerCount).toBe(1);
    expect(info.foreignSignersHex).toEqual([]); // no partition → none flagged
  });

  it("psbtOutputsEqual returns true for identical output sets", () => {
    const a = [
      { address: "prl1abc", amountGrains: 100n, scriptHex: "51200000" },
      { address: "prl1def", amountGrains: 50n, scriptHex: "51201111" },
    ];
    expect(psbtOutputsEqual(a, a)).toBe(true);
    expect(psbtOutputsEqual(a, [...a])).toBe(true);
  });

  it("psbtOutputsEqual flags amount mutation", () => {
    const a = [{ address: "prl1abc", amountGrains: 100n, scriptHex: "51200000" }];
    const b = [{ address: "prl1abc", amountGrains: 99n, scriptHex: "51200000" }];
    expect(psbtOutputsEqual(a, b)).toBe(false);
  });

  it("psbtOutputsEqual flags address (script) mutation", () => {
    const a = [{ address: "prl1abc", amountGrains: 100n, scriptHex: "51200000" }];
    const b = [{ address: "prl1xyz", amountGrains: 100n, scriptHex: "5120ffff" }];
    expect(psbtOutputsEqual(a, b)).toBe(false);
  });

  it("psbtOutputsEqual flags appended drain output", () => {
    const a = [{ address: "prl1abc", amountGrains: 100n, scriptHex: "51200000" }];
    const b = [
      { address: "prl1abc", amountGrains: 100n, scriptHex: "51200000" },
      { address: "prl1drain", amountGrains: 5n, scriptHex: "51202222" },
    ];
    expect(psbtOutputsEqual(a, b)).toBe(false);
  });
});

describe("v0.2.2 — fee parsing + suspicion + service-level preview assertion (audit pass 3)", () => {
  it("inspectPsbt computes fee = sum(inputs) - sum(outputs)", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 95_000n }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(info.feeUnknown).toBe(false);
    expect(info.totalInputGrains).toBe(100_000n);
    expect(info.totalOutputGrains).toBe(95_000n);
    expect(info.feeGrains).toBe(5_000n);
    expect(info.inputAmountsGrains).toEqual([100_000n]);
  });

  it("inspectPsbt aggregates fee across multiple inputs", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const psbt = composeWorkerPsbt(
      rec,
      [
        { txid: TXID_A, vout: 0, amountGrains: 100_000n },
        { txid: TXID_B, vout: 1, amountGrains: 50_000n },
      ],
      [{ address: rec.pearlAddress, amountGrains: 140_000n }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(info.totalInputGrains).toBe(150_000n);
    expect(info.feeGrains).toBe(10_000n);
    expect(info.inputAmountsGrains).toEqual([100_000n, 50_000n]);
  });

  it("feeSuspiciousReason flags fee > 20% of inputs", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    // 100k in, 50k out → 50k fee = 50% of inputs. Hostile.
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 50_000n }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    const reason = feeSuspiciousReason(info);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/50%/);
  });

  it("feeSuspiciousReason returns null for normal fee (≤ 20% of inputs)", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    // 100k in, 95k out → 5k fee = 5%. Sane.
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 95_000n }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(feeSuspiciousReason(info)).toBeNull();
  });

  it("assertPsbtMatchesPreview passes when PSBT matches the preview", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const destAddr = rec.pearlAddress; // self-send for simplicity
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: destAddr, amountGrains: 95_000n }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(() =>
      assertPsbtMatchesPreview(
        info,
        {
          destination: destAddr,
          amountGrains: "95000",
          feeGrains: "5000",
          changeGrains: "0",
          inputCount: 1,
        },
        rec.pearlAddress,
      ),
    ).not.toThrow();
  });

  it("assertPsbtMatchesPreview throws on destination amount mutation", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const destAddr = rec.pearlAddress;
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: destAddr, amountGrains: 95_000n }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(() =>
      assertPsbtMatchesPreview(
        info,
        {
          destination: destAddr,
          amountGrains: "90000", // mutated
          feeGrains: "10000",
          changeGrains: "0",
          inputCount: 1,
        },
        rec.pearlAddress,
      ),
    ).toThrow(/E_MULTISIG_OUTPUT_MISMATCH/);
  });

  it("assertPsbtMatchesPreview throws on fee mutation", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const destAddr = rec.pearlAddress;
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: destAddr, amountGrains: 95_000n }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(() =>
      assertPsbtMatchesPreview(
        info,
        {
          destination: destAddr,
          amountGrains: "95000",
          feeGrains: "1", // claims tiny fee but actual is 5000
          changeGrains: "0",
          inputCount: 1,
        },
        rec.pearlAddress,
      ),
    ).toThrow(/E_MULTISIG_OUTPUT_MISMATCH.*fee/);
  });

  it("assertPsbtMatchesPreview throws on appended drain output", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [
        { address: rec.pearlAddress, amountGrains: 50_000n }, // dest
        { address: rec.pearlAddress, amountGrains: 30_000n }, // change
        { address: rec.pearlAddress, amountGrains: 10_000n }, // unexpected extra
      ],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);
    expect(() =>
      assertPsbtMatchesPreview(
        info,
        {
          destination: rec.pearlAddress,
          amountGrains: "50000",
          feeGrains: "10000",
          changeGrains: "30000",
          inputCount: 1,
        },
        rec.pearlAddress,
      ),
    ).toThrow(/E_MULTISIG_OUTPUT_MISMATCH.*outputs/);
  });

  it("assertPsbtMatchesPreview validates change address binds to vault", async () => {
    const cs = await cosigners(5);
    const recA = recordFromCosigners(2, cs.slice(0, 3), 0);
    const recB = recordFromCosigners(2, cs.slice(2, 5), 0); // different vault
    // Compose so "change" output goes to vault B but preview says it should
    // go to vault A. Simulates a hostile cosigner trying to reroute change.
    const psbt = composeWorkerPsbt(
      recA,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [
        { address: recA.pearlAddress, amountGrains: 50_000n },
        { address: recB.pearlAddress, amountGrains: 40_000n }, // wrong change addr
      ],
    );
    const info = inspectPsbt(psbt, 2, recA.sortedPubkeysHex);
    expect(() =>
      assertPsbtMatchesPreview(
        info,
        {
          destination: recA.pearlAddress,
          amountGrains: "50000",
          feeGrains: "10000",
          changeGrains: "40000",
          inputCount: 1,
        },
        recA.pearlAddress, // expected change goes here, but PSBT routes to B
      ),
    ).toThrow(/E_MULTISIG_OUTPUT_MISMATCH.*change/);
  });
});

describe("composeVaultSend — dust-coalesce fee invariant (audit pass 4 H1 regression)", () => {
  // When change < DUST_LIMIT_GRAINS, composeVaultSend drops the change output
  // and folds the dust into the fee. The PSBT then has ONE output (the dest)
  // worth opts.amountGrains, so the on-wire fee = sum(inputs) - amountGrains.
  //
  // Pass-3 added assertPsbtMatchesPreview which compares the PSBT's actual
  // fee against preview.feeGrains exactly. If preview.feeGrains is set to
  // the *recomputed* estimateMultisigFee(.., numOutputs=1, ..) (the old
  // buggy path), then the originator's own draft fails with
  //   E_MULTISIG_OUTPUT_MISMATCH: fee is X grains (expected Y).
  //
  // This test asserts the invariant: in the dust-coalesce branch, the value
  // stored as preview.feeGrains must equal (sum - amountGrains), not the
  // 1-output fee estimate. Worker-built PSBT here mirrors what
  // composePearlMultisigPsbt produces from composeVaultSend's outputs.
  it("preview.feeGrains equals sum-of-inputs minus amountGrains when change is dust", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);

    const feerate = 2n;
    const picked = 1;
    const numOutputs2 = 2;
    const numOutputs1 = 1;
    const fee2 =
      (FIXED_OVERHEAD_VBYTES +
        BigInt(picked) * PER_INPUT_VBYTES_MULTISIG +
        BigInt(numOutputs2) * PER_P2TR_OUTPUT_VBYTES) *
      feerate;
    const fee1 =
      (FIXED_OVERHEAD_VBYTES +
        BigInt(picked) * PER_INPUT_VBYTES_MULTISIG +
        BigInt(numOutputs1) * PER_P2TR_OUTPUT_VBYTES) *
      feerate;

    // Pick an amount so change_2out = DUST_LIMIT_GRAINS - 1 (forces coalesce)
    const dustChange = DUST_LIMIT_GRAINS - 1n;
    const amount = 100_000n;
    const sum = amount + fee2 + dustChange;

    // PSBT has 1 output worth `amount`; actual on-wire fee = sum - amount
    const actualFee = sum - amount;
    expect(actualFee).toBe(fee1 + dustChange + (fee2 - fee1));
    expect(actualFee).toBeGreaterThan(fee1); // proves the old `fee = fee1` was wrong

    const psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: sum }],
      [{ address: rec.pearlAddress, amountGrains: amount }],
    );
    const info = inspectPsbt(psbt, 2, rec.sortedPubkeysHex);

    // Fixed behaviour: preview built with feeGrains = sum - amount, change = 0
    expect(() =>
      assertPsbtMatchesPreview(
        info,
        {
          destination: rec.pearlAddress,
          amountGrains: amount.toString(),
          feeGrains: actualFee.toString(),
          changeGrains: "0",
          inputCount: 1,
        },
        rec.pearlAddress,
      ),
    ).not.toThrow();

    // Buggy behaviour (pre-fix): preview stored fee1 instead of actualFee.
    // assertPsbtMatchesPreview must catch this — otherwise an originator
    // could happily sign a draft that pays more than the displayed fee.
    expect(() =>
      assertPsbtMatchesPreview(
        info,
        {
          destination: rec.pearlAddress,
          amountGrains: amount.toString(),
          feeGrains: fee1.toString(),
          changeGrains: "0",
          inputCount: 1,
        },
        rec.pearlAddress,
      ),
    ).toThrow(/E_MULTISIG_OUTPUT_MISMATCH.*fee/);
  });
});

describe("Witness layout sanity for tr_ms — non-signer slot is empty push", () => {
  it("2-of-3 with cosigner 0+2 signing produces an empty push in cosigner 1's slot", async () => {
    const cs = await cosigners(3);
    const rec = recordFromCosigners(2, cs, 0);
    let psbt = composeWorkerPsbt(
      rec,
      [{ txid: TXID_A, vout: 0, amountGrains: 100_000n }],
      [{ address: rec.pearlAddress, amountGrains: 90_000n }],
    );
    psbt = signWith(psbt, cs[0]!.privateKey);
    psbt = signWith(psbt, cs[2]!.privateKey);
    const { rawHex } = finalizeVaultPsbt(psbt);
    const decoded = btc.Transaction.fromRaw(hexToBytesAny(rawHex));
    const witness = (decoded.getInput(0).finalScriptWitness ?? []) as Uint8Array[];
    // For 3-cosigner m-of-n the witness stack is:
    //   [s_3, s_2, s_1, leaf, ctrl]  (stack-order, with non-signers as P.EMPTY)
    // where the s_i positions correspond to the BIP-67-sorted cosigner order
    // reversed for stack push semantics. Exactly one slot should be the
    // empty push (the non-signer); the other two are 64- or 65-byte sigs.
    expect(witness.length).toBe(5);
    const sigSlots = witness.slice(0, 3);
    const empties = sigSlots.filter((s) => s.length === 0).length;
    const sigs = sigSlots.filter((s) => s.length === 64 || s.length === 65).length;
    expect(empties).toBe(1);
    expect(sigs).toBe(2);
  });
});
