// Vault auto-import — tests for reconstructing a multisig vault from a
// cosign-request PSBT and proving local signer membership.
//
// These exercise the security-critical recovery path WITHOUT a Web Worker
// or IndexedDB (node env): we build real vault PSBTs the same way the
// crypto worker / relay presign do (NUMS-internal-key tr_ms leaf), then
// recover + bind, and assert every tamper is rejected.

import { describe, it, expect } from "vitest";
import * as bip39 from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import {
  vaultDescriptorFromPubkeys,
  PEARL_MULTISIG_NUMS_INTERNAL_KEY,
} from "../src/chains/pearl/multisig";
import { pearlParams } from "../src/chains/pearl/network";
import {
  masterFromSeed,
  pearlMultisigPath,
  findMultisigSlot,
} from "../src/crypto/hd";
import { bytesToHex, hexToBytes } from "../src/crypto/descriptor";
import {
  recoverVaultFromPsbt,
  VaultRecoveryError,
} from "../src/services/vault-import";

const params = pearlParams("mainnet");
const net = { bech32: "prl", pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 } as const;

// Two distinct seeds: SIGNER holds a key in the vault; STRANGER does not.
const SIGNER_M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const STRANGER_M =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

async function masterFor(mnemonic: string) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  return masterFromSeed(seed);
}

interface Cosigner {
  xOnly: Uint8Array;
  priv: Uint8Array;
  account: number;
  index: number;
}

async function signerCosigner(account: number, index: number): Promise<Cosigner> {
  const master = await masterFor(SIGNER_M);
  const child = master.derive(pearlMultisigPath(account, index));
  return { xOnly: child.publicKey!.slice(1), priv: child.privateKey!, account, index };
}

// A throwaway cosigner pubkey not tied to either test seed (random-ish but
// deterministic). We only need a valid x-only point; derive from STRANGER.
async function strangerXOnly(index: number): Promise<Uint8Array> {
  const master = await masterFor(STRANGER_M);
  return master.derive(pearlMultisigPath(0, index)).publicKey!.slice(1);
}

interface BuiltVault {
  pubkeys: Uint8Array[];
  threshold: number;
  address: string;
  outputScript: Uint8Array;
  tapLeafScript: unknown;
  internalKey: Uint8Array;
}

function buildVault(threshold: number, pubkeys: Uint8Array[]): BuiltVault {
  const d = vaultDescriptorFromPubkeys(threshold, pubkeys, params);
  return {
    pubkeys: d.sortedPubkeys,
    threshold,
    address: d.address,
    outputScript: d.outputScript,
    tapLeafScript: d.tapLeafScript,
    internalKey: d.internalKey,
  };
}

// Build a vault-spending PSBT mirroring the worker/presign compose path.
function buildVaultPsbt(
  v: BuiltVault,
  opts?: {
    inputs?: number;
    overrideInternalKey?: Uint8Array;
    overrideLeaf?: unknown;
    overrideScript?: Uint8Array;
    dropWitnessUtxo?: boolean;
  },
): string {
  const n = opts?.inputs ?? 1;
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (let i = 0; i < n; i++) {
    const input: Record<string, unknown> = {
      txid: hexToBytes("11".repeat(32)),
      index: i,
      tapInternalKey: opts?.overrideInternalKey ?? v.internalKey,
      tapLeafScript: opts?.overrideLeaf ?? v.tapLeafScript,
    };
    if (!opts?.dropWitnessUtxo) {
      input.witnessUtxo = {
        amount: 100_000n,
        script: opts?.overrideScript ?? v.outputScript,
      };
    }
    tx.addInput(input as never);
  }
  tx.addOutputAddress(v.address, 90_000n, net);
  return base64.encode(tx.toPSBT());
}

describe("recoverVaultFromPsbt — happy path + binding", () => {
  it("recovers a 2-of-3 vault config bound to its address", async () => {
    const cs = [
      (await signerCosigner(0, 0)).xOnly,
      await strangerXOnly(1),
      await strangerXOnly(2),
    ];
    const v = buildVault(2, cs);
    const psbt = buildVaultPsbt(v);

    const r = recoverVaultFromPsbt(psbt);
    expect(r.threshold).toBe(2);
    expect(r.total).toBe(3);
    expect(r.address).toBe(v.address);
    expect(r.outputScriptHex).toBe(bytesToHex(v.outputScript));
    // Sorted set matches the descriptor's canonical order.
    expect(r.sortedPubkeysHex).toEqual(v.pubkeys.map((p) => bytesToHex(p)));
  });

  it("recovers across thresholds 1-of-2 … 4-of-5", async () => {
    for (const [m, n] of [[1, 2], [2, 2], [3, 4], [4, 5]] as const) {
      const cs: Uint8Array[] = [(await signerCosigner(0, 0)).xOnly];
      for (let k = 1; k < n; k++) cs.push(await strangerXOnly(k));
      const v = buildVault(m, cs);
      const r = recoverVaultFromPsbt(buildVaultPsbt(v));
      expect(r.threshold).toBe(m);
      expect(r.total).toBe(n);
      expect(r.address).toBe(v.address);
    }
  });

  it("accepts a multi-input PSBT where all inputs share the vault", async () => {
    const cs = [(await signerCosigner(0, 0)).xOnly, await strangerXOnly(1)];
    const v = buildVault(2, cs);
    const r = recoverVaultFromPsbt(buildVaultPsbt(v, { inputs: 3 }));
    expect(r.address).toBe(v.address);
  });
});

describe("recoverVaultFromPsbt — attacker / malformed rejection", () => {
  it("rejects a non-PSBT string", () => {
    expect(() => recoverVaultFromPsbt("not base64 psbt!!")).toThrow(VaultRecoveryError);
  });

  it("rejects a forged (non-NUMS) internal key — key-path escape", async () => {
    // Attacker builds the SAME m-of-n leaf but commits it under a spendable
    // internal key they control, so they could key-path drain the vault.
    // The leaf's control block then carries a non-NUMS key → hard reject.
    const cs = [(await signerCosigner(0, 0)).xOnly, await strangerXOnly(1)];
    const v = buildVault(2, cs);
    const evilInternal = await strangerXOnly(9); // real, spendable, not in leaf
    const ms = btc.p2tr_ms(2, v.pubkeys);
    const evilTr = btc.p2tr(evilInternal, ms as never, net, false) as unknown as {
      script: Uint8Array;
      tapLeafScript: unknown;
    };
    const psbt = buildVaultPsbt(v, {
      overrideLeaf: evilTr.tapLeafScript,
      overrideScript: evilTr.script,
      overrideInternalKey: evilInternal,
    });
    try {
      recoverVaultFromPsbt(psbt);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultRecoveryError);
      expect((e as VaultRecoveryError).code).toBe("E_RECOVER_NOT_NUMS");
    }
  });

  it("rejects when witnessUtxo.script is mutated away from the leaf's address", async () => {
    const cs = [(await signerCosigner(0, 0)).xOnly, await strangerXOnly(1)];
    const v = buildVault(2, cs);
    // A *different* vault's output script, so the leaf no longer commits to it.
    const other = buildVault(2, [await strangerXOnly(3), await strangerXOnly(4)]);
    const psbt = buildVaultPsbt(v, { overrideScript: other.outputScript });
    try {
      recoverVaultFromPsbt(psbt);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultRecoveryError);
      expect((e as VaultRecoveryError).code).toBe("E_VAULT_BINDING");
    }
  });

  it("rejects a PSBT with no witnessUtxo (blind-sign bait)", async () => {
    const cs = [(await signerCosigner(0, 0)).xOnly, await strangerXOnly(1)];
    const v = buildVault(2, cs);
    const psbt = buildVaultPsbt(v, { dropWitnessUtxo: true });
    expect(() => recoverVaultFromPsbt(psbt)).toThrow(VaultRecoveryError);
  });

  it("rejects a PSBT whose inputs reference two different vaults", async () => {
    const a = buildVault(2, [(await signerCosigner(0, 0)).xOnly, await strangerXOnly(1)]);
    const b = buildVault(2, [await strangerXOnly(2), await strangerXOnly(3)]);
    const tx = new btc.Transaction({ allowUnknownOutputs: false });
    tx.addInput({
      txid: hexToBytes("11".repeat(32)),
      index: 0,
      witnessUtxo: { amount: 100_000n, script: a.outputScript },
      tapInternalKey: a.internalKey,
      tapLeafScript: a.tapLeafScript as never,
    });
    tx.addInput({
      txid: hexToBytes("22".repeat(32)),
      index: 0,
      witnessUtxo: { amount: 100_000n, script: b.outputScript },
      tapInternalKey: b.internalKey,
      tapLeafScript: b.tapLeafScript as never,
    });
    tx.addOutputAddress(a.address, 150_000n, net);
    const psbt = base64.encode(tx.toPSBT());
    try {
      recoverVaultFromPsbt(psbt);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as VaultRecoveryError).code).toBe("E_RECOVER_INPUT_MISMATCH");
    }
  });

  it("rejects a plain single-sig (non-vault) PSBT — no tapLeafScript", async () => {
    const tx = new btc.Transaction({ allowUnknownOutputs: false });
    const someKey = await strangerXOnly(0);
    const p2tr = btc.p2tr(someKey, undefined, net);
    tx.addInput({
      txid: hexToBytes("11".repeat(32)),
      index: 0,
      witnessUtxo: { amount: 100_000n, script: p2tr.script },
      tapInternalKey: someKey,
    });
    tx.addOutputAddress(p2tr.address!, 90_000n, net);
    const psbt = base64.encode(tx.toPSBT());
    try {
      recoverVaultFromPsbt(psbt);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultRecoveryError);
      expect((e as VaultRecoveryError).code).toBe("E_RECOVER_NO_LEAF");
    }
  });
});

describe("findMultisigSlot — local membership proof", () => {
  it("finds the signer's slot when their key is in the set", async () => {
    const me = await signerCosigner(0, 0);
    const cs = [me.xOnly, await strangerXOnly(1), await strangerXOnly(2)];
    const v = buildVault(2, cs);
    const set = new Set(v.pubkeys.map((p) => bytesToHex(p)));
    const master = await masterFor(SIGNER_M);
    const match = findMultisigSlot(master, set, 5, 5);
    expect(match).not.toBeNull();
    expect(match!.pubkeyHex).toBe(bytesToHex(me.xOnly));
    expect(match!.vaultAccount).toBe(0);
    expect(match!.keyIndex).toBe(0);
    expect(match!.originPath).toBe(pearlMultisigPath(0, 0));
  });

  it("finds a signer enrolled at a non-zero slot", async () => {
    const me = await signerCosigner(3, 2);
    const cs = [me.xOnly, await strangerXOnly(1), await strangerXOnly(2)];
    const v = buildVault(2, cs);
    const set = new Set(v.pubkeys.map((p) => bytesToHex(p)));
    const master = await masterFor(SIGNER_M);
    const match = findMultisigSlot(master, set, 5, 5);
    expect(match).not.toBeNull();
    expect(match!.vaultAccount).toBe(3);
    expect(match!.keyIndex).toBe(2);
  });

  it("returns null when this seed holds no key in the set (not a signer)", async () => {
    // Vault made entirely of SIGNER keys; scan with the STRANGER seed.
    const cs = [
      (await signerCosigner(0, 0)).xOnly,
      (await signerCosigner(0, 1)).xOnly,
      (await signerCosigner(0, 2)).xOnly,
    ];
    const v = buildVault(2, cs);
    const set = new Set(v.pubkeys.map((p) => bytesToHex(p)));
    const stranger = await masterFor(STRANGER_M);
    expect(findMultisigSlot(stranger, set, 6, 6)).toBeNull();
  });

  it("does not find a slot outside the scan bounds", async () => {
    const me = await signerCosigner(9, 0); // account 9 > maxAccount 5
    const cs = [me.xOnly, await strangerXOnly(1)];
    const v = buildVault(2, cs);
    const set = new Set(v.pubkeys.map((p) => bytesToHex(p)));
    const master = await masterFor(SIGNER_M);
    expect(findMultisigSlot(master, set, 5, 5)).toBeNull();
  });
});

// Build a PSBT the EXACT way the relay's pearl-vault-relay/src/presign.ts
// does (p2tr(undefined, p2tr_ms(...)) → NUMS internal key, tapMerkleRoot
// set on the input). This proves the existing top-up cosign requests are
// already compatible with auto-import — no proposer/relay change needed.
function buildPresignShapedPsbt(threshold: number, sortedPubkeysHex: string[]): string {
  const sortedBytes = sortedPubkeysHex.map((h) => hexToBytes(h));
  const ms = btc.p2tr_ms(threshold, sortedBytes);
  const tr = btc.p2tr(undefined, ms as never, net, false) as unknown as {
    address: string;
    script: Uint8Array;
    tapLeafScript: unknown;
    tapInternalKey: Uint8Array;
    tapMerkleRoot: Uint8Array;
  };
  const tx = new btc.Transaction({
    allowUnknown: false,
    allowUnknownInputs: false,
    allowUnknownOutputs: false,
  });
  tx.addInput({
    txid: hexToBytes("aa".repeat(32)),
    index: 0,
    witnessUtxo: { amount: 500_000n, script: tr.script },
    tapLeafScript: tr.tapLeafScript as never,
    tapInternalKey: tr.tapInternalKey,
    tapMerkleRoot: tr.tapMerkleRoot,
    sequence: 0xfffffffd,
  });
  tx.addOutputAddress(tr.address, 450_000n, net);
  return base64.encode(tx.toPSBT());
}

describe("compatibility: presign.ts-shaped top-up cosign request", () => {
  it("recovers a vault from a relay-presign-shaped PSBT (no proposer change needed)", async () => {
    const me = await signerCosigner(2, 1);
    const cs = [me.xOnly, await strangerXOnly(1), await strangerXOnly(2)];
    // Use the BIP-67 sorted hex set, exactly like the relay's VaultConfig.
    const sortedHex = vaultDescriptorFromPubkeys(2, cs, params).sortedPubkeys.map((p) =>
      bytesToHex(p),
    );
    const psbt = buildPresignShapedPsbt(2, sortedHex);

    const r = recoverVaultFromPsbt(psbt);
    expect(r.threshold).toBe(2);
    expect(r.total).toBe(3);
    expect(r.sortedPubkeysHex).toEqual(sortedHex);

    // And the genuine signer is provably a member.
    const set = new Set(r.sortedPubkeysHex);
    const master = await masterFor(SIGNER_M);
    const match = findMultisigSlot(master, set, 5, 5);
    expect(match).not.toBeNull();
    expect(match!.vaultAccount).toBe(2);
    expect(match!.keyIndex).toBe(1);
  });
});

describe("end-to-end: recover then prove membership", () => {
  it("a presign-style PSBT yields a recoverable vault the signer is in", async () => {
    const me = await signerCosigner(1, 0);
    const cs = [me.xOnly, await strangerXOnly(1), await strangerXOnly(2)];
    const v = buildVault(2, cs);
    const psbt = buildVaultPsbt(v);

    const recovered = recoverVaultFromPsbt(psbt);
    expect(recovered.address).toBe(v.address);

    const set = new Set(recovered.sortedPubkeysHex);
    const master = await masterFor(SIGNER_M);
    const match = findMultisigSlot(master, set, 5, 5);
    expect(match).not.toBeNull();
    // The recovered set contains exactly the matched pubkey.
    expect(recovered.sortedPubkeysHex).toContain(match!.pubkeyHex);
    // And NUMS internal key is what the descriptor pins.
    expect(bytesToHex(v.internalKey)).toBe(bytesToHex(PEARL_MULTISIG_NUMS_INTERNAL_KEY));
  });
});
