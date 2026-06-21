// Vault auto-import — reconstruct a multisig vault from a cosign request
// (a PSBT delivered by the relay) and, IF the local wallet holds a key in
// the cosigner set, register the vault so the user never has to re-enter
// the threshold + every cosigner pubkey by hand.
//
// SECURITY MODEL (read before touching this file):
//
//   A cosign request is attacker-influenceable data. We therefore NEVER
//   trust a "this is the vault / you are a signer" claim. Instead we:
//
//     1. Recover the cosigner set + threshold from the PSBT's tapLeafScript
//        (the m-of-n CHECKSIGADD leaf) — these are the bytes the on-chain
//        address actually commits to.
//     2. Rebuild the vault descriptor from those primitives with the same
//        `vaultDescriptorFromPubkeys` used everywhere else, and ASSERT the
//        rebuilt `outputScript` + `leafScript` are byte-identical to what
//        the PSBT carries. This binds the recovered config to the address
//        the proposal spends from — a forged internal key, a swapped leaf,
//        or a mutated pubkey set all fail here (mirrors presign.ts's
//        E_VAULT_BINDING). The internal key MUST be the NUMS point, so the
//        key-path spend stays provably disabled.
//     3. Prove membership LOCALLY: derive our own cosigner pubkey across a
//        bounded slot range and check it is in the recovered set. An
//        attacker cannot forge this — the only way the check passes is if
//        the committed leaf genuinely contains a key we control.
//
//   If membership fails we REFUSE to import. Importing a vault we cannot
//   sign for would only serve to lend a hostile address a veneer of
//   legitimacy in the dashboard (the "auto-import = it must be real"
//   phishing halo). The address is always surfaced to the user for
//   out-of-band verification before anything is persisted.

import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import {
  vaultDescriptorFromPubkeys,
  PEARL_MULTISIG_NUMS_INTERNAL_KEY,
  MULTISIG_MAX_COSIGNERS,
} from "../chains/pearl/multisig";
import { pearlParams } from "../chains/pearl/network";
import { bytesToHex } from "../crypto/descriptor";
import { cryptoWorker } from "../crypto/worker-client";
import { createVault, listVaults } from "./multisig";
import type { VaultRecord } from "../storage/db";

// Bounded slot scan for the local membership proof. A user exports one
// cosigner pubkey per vault they join (one hardened `vaultAccount`, one
// `keyIndex` slot within it). These bounds comfortably cover any realistic
// number of vaults + slots while keeping the derivation count well under a
// second of worker time. Anything past here just reports "not a signer".
export const IMPORT_SCAN_MAX_ACCOUNT = 50;
export const IMPORT_SCAN_MAX_INDEX = 10;

// Upper bound on PSBT inputs we'll walk during recovery (main-thread loop).
// Far above any real vault spend; a backstop against a self-inflicted hang.
const MAX_RECOVER_INPUTS = 256;

export type VaultRecoveryCode =
  | "E_RECOVER_PSBT_PARSE"
  | "E_RECOVER_NO_INPUTS"
  | "E_RECOVER_INPUT_MISMATCH"
  | "E_RECOVER_NO_WITNESS_UTXO"
  | "E_RECOVER_NO_LEAF"
  | "E_RECOVER_LEAF_COUNT"
  | "E_RECOVER_LEAF_VERSION"
  | "E_RECOVER_NOT_NUMS"
  | "E_RECOVER_MERKLE_PATH"
  | "E_RECOVER_LEAF_SHAPE"
  | "E_RECOVER_BAD_COSIGNER_COUNT"
  | "E_VAULT_BINDING";

export class VaultRecoveryError extends Error {
  constructor(
    message: string,
    public code: VaultRecoveryCode,
  ) {
    super(message);
    this.name = "VaultRecoveryError";
  }
}

export interface RecoveredVault {
  threshold: number;
  total: number;
  /** Lowercase hex x-only pubkeys, BIP-67 sorted (canonical). */
  sortedPubkeysHex: string[];
  /** Pearl bech32m vault address recomputed from the recovered set. */
  address: string;
  network: "mainnet";
  /** Output script hex — equals the PSBT's witnessUtxo.script (bound). */
  outputScriptHex: string;
}

// Bitcoin script opcodes referenced by the m-of-n tapleaf.
const OP_PUSH32 = 0x20;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGADD = 0xba;
const OP_NUMEQUAL = 0x9c;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_PUSHDATA1_BYTE = 0x01; // minimal 1-byte numeric push (defensive)

/**
 * Parse the cosigner pubkeys + threshold out of a BIP-342 m-of-n tapleaf
 * script as emitted by `@scure/btc-signer` `p2tr_ms`:
 *
 *   <32:pk1> OP_CHECKSIG <32:pk2> OP_CHECKSIGADD … <32:pkn> OP_CHECKSIGADD
 *   <m> OP_NUMEQUAL
 *
 * Strict: any structural deviation throws E_RECOVER_LEAF_SHAPE. The result
 * is treated as *candidate* values only — the caller re-derives the leaf
 * from them and byte-compares, so a parse that drifts can never widen trust.
 */
function parseMultisigLeaf(leaf: Uint8Array): {
  pubkeys: Uint8Array[];
  threshold: number;
} {
  const pubkeys: Uint8Array[] = [];
  let i = 0;
  const need = (n: number) => {
    if (i + n > leaf.length) {
      throw new VaultRecoveryError(
        "tapleaf truncated mid-token",
        "E_RECOVER_LEAF_SHAPE",
      );
    }
  };

  // At least one cosigner: <32:pk> OP_CHECKSIG.
  for (;;) {
    need(1);
    if (leaf[i] !== OP_PUSH32) {
      throw new VaultRecoveryError(
        `expected 32-byte pubkey push, got 0x${leaf[i]!.toString(16)}`,
        "E_RECOVER_LEAF_SHAPE",
      );
    }
    need(1 + 32);
    pubkeys.push(leaf.slice(i + 1, i + 33));
    i += 33;
    need(1);
    const op = leaf[i++]!;
    const expected = pubkeys.length === 1 ? OP_CHECKSIG : OP_CHECKSIGADD;
    if (op !== expected) {
      throw new VaultRecoveryError(
        `expected ${pubkeys.length === 1 ? "OP_CHECKSIG" : "OP_CHECKSIGADD"} after pubkey ${pubkeys.length}`,
        "E_RECOVER_LEAF_SHAPE",
      );
    }
    if (pubkeys.length > MULTISIG_MAX_COSIGNERS) {
      throw new VaultRecoveryError(
        `more than ${MULTISIG_MAX_COSIGNERS} cosigners in leaf`,
        "E_RECOVER_BAD_COSIGNER_COUNT",
      );
    }
    // Another pubkey push follows, or we've reached the threshold token.
    need(1);
    if (leaf[i] === OP_PUSH32) continue;
    break;
  }

  // Threshold: OP_1..OP_16 (canonical for 1..16), or a defensive 1-byte push.
  need(1);
  const t = leaf[i++]!;
  let threshold: number;
  if (t >= OP_1 && t <= OP_16) {
    threshold = t - (OP_1 - 1);
  } else if (t === OP_PUSHDATA1_BYTE) {
    need(1);
    threshold = leaf[i++]!;
  } else {
    throw new VaultRecoveryError(
      `unexpected threshold token 0x${t.toString(16)}`,
      "E_RECOVER_LEAF_SHAPE",
    );
  }

  need(1);
  if (leaf[i++] !== OP_NUMEQUAL) {
    throw new VaultRecoveryError(
      "expected OP_NUMEQUAL to close the m-of-n leaf",
      "E_RECOVER_LEAF_SHAPE",
    );
  }
  if (i !== leaf.length) {
    throw new VaultRecoveryError(
      "trailing bytes after OP_NUMEQUAL",
      "E_RECOVER_LEAF_SHAPE",
    );
  }
  return { pubkeys, threshold };
}

interface InputCommitment {
  witnessScript: Uint8Array;
  leafScript: Uint8Array;
}

/** Pull the (witnessUtxo.script, single-NUMS-leaf script) from one input. */
function readInputCommitment(input: unknown): InputCommitment {
  const inp = input as {
    witnessUtxo?: { script?: Uint8Array };
    tapLeafScript?: Array<
      [{ version: number; internalKey: Uint8Array; merklePath: Uint8Array[] }, Uint8Array]
    >;
  };
  const witnessScript = inp.witnessUtxo?.script;
  if (!(witnessScript instanceof Uint8Array) || witnessScript.length === 0) {
    throw new VaultRecoveryError(
      "input is missing witnessUtxo.script — cannot bind to a vault address",
      "E_RECOVER_NO_WITNESS_UTXO",
    );
  }
  const tls = inp.tapLeafScript;
  if (!Array.isArray(tls) || tls.length === 0) {
    throw new VaultRecoveryError(
      "input has no tapLeafScript — not a Pearl vault spend",
      "E_RECOVER_NO_LEAF",
    );
  }
  if (tls.length !== 1) {
    throw new VaultRecoveryError(
      `expected exactly one tapleaf, got ${tls.length}`,
      "E_RECOVER_LEAF_COUNT",
    );
  }
  const [controlBlock, scriptWithVersion] = tls[0]!;
  if (!(scriptWithVersion instanceof Uint8Array) || scriptWithVersion.length < 1) {
    throw new VaultRecoveryError("tapleaf script bytes missing", "E_RECOVER_LEAF_SHAPE");
  }
  const leafVersion = scriptWithVersion[scriptWithVersion.length - 1]!;
  if (leafVersion !== 0xc0) {
    throw new VaultRecoveryError(
      `unexpected tapleaf version 0x${leafVersion.toString(16)} (want 0xc0)`,
      "E_RECOVER_LEAF_VERSION",
    );
  }
  // The control block's internal key SHOULD be the NUMS point. Note this is
  // a cheap EARLY-REJECT, not the NUMS guarantee on its own: a PSBT control
  // block is attacker-malleable (btc-signer parses it structurally, without
  // proving it's a valid taproot inclusion proof for witnessUtxo.script).
  // The real guarantee is the outputScript byte-binding in
  // recoverVaultFromPsbt — the rebuilt descriptor pins the NUMS internal key
  // (multisig.ts), so a non-NUMS-committed address simply fails that bind.
  // Do NOT drop the outputScript binding believing this check covers it.
  const internalKey = controlBlock?.internalKey;
  if (
    !(internalKey instanceof Uint8Array) ||
    bytesToHex(internalKey) !== bytesToHex(PEARL_MULTISIG_NUMS_INTERNAL_KEY)
  ) {
    throw new VaultRecoveryError(
      "tapleaf internal key is not the NUMS point — refusing",
      "E_RECOVER_NOT_NUMS",
    );
  }
  if (Array.isArray(controlBlock.merklePath) && controlBlock.merklePath.length !== 0) {
    throw new VaultRecoveryError(
      "tapleaf has sibling leaves — not a single-leaf Pearl vault",
      "E_RECOVER_MERKLE_PATH",
    );
  }
  return {
    witnessScript,
    leafScript: scriptWithVersion.slice(0, -1),
  };
}

/**
 * Recover a Pearl multisig vault descriptor from a (possibly partially
 * signed) PSBT, verifying the recovered config is byte-bound to the
 * address the PSBT spends from. Throws VaultRecoveryError on any deviation.
 *
 * Pure + local — no key material, no network, no worker. Safe to run on an
 * untrusted PSBT.
 */
export function recoverVaultFromPsbt(psbtBase64: string): RecoveredVault {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64));
  } catch (e) {
    throw new VaultRecoveryError(
      `PSBT parse failed: ${e instanceof Error ? e.message : String(e)}`,
      "E_RECOVER_PSBT_PARSE",
    );
  }
  if (tx.inputsLength === 0) {
    throw new VaultRecoveryError("PSBT has no inputs", "E_RECOVER_NO_INPUTS");
  }
  // Recovery runs on the main thread; cap the input count so a pathological
  // PSBT can't freeze the tab in the per-input binding loop. A real vault
  // spend never approaches this — it's a self-inflicted-DoS backstop.
  if (tx.inputsLength > MAX_RECOVER_INPUTS) {
    throw new VaultRecoveryError(
      `PSBT has ${tx.inputsLength} inputs (cap ${MAX_RECOVER_INPUTS})`,
      "E_RECOVER_INPUT_MISMATCH",
    );
  }

  // Every input must commit to the SAME vault. Our compose path only ever
  // spends one vault per PSBT; a PSBT mixing inputs from different scripts
  // is hostile or malformed — refuse rather than guess which one is "the"
  // vault.
  const first = readInputCommitment(tx.getInput(0));
  const firstWitnessHex = bytesToHex(first.witnessScript);
  const firstLeafHex = bytesToHex(first.leafScript);
  for (let i = 1; i < tx.inputsLength; i++) {
    const c = readInputCommitment(tx.getInput(i));
    if (bytesToHex(c.witnessScript) !== firstWitnessHex || bytesToHex(c.leafScript) !== firstLeafHex) {
      throw new VaultRecoveryError(
        "PSBT inputs reference more than one vault — refusing",
        "E_RECOVER_INPUT_MISMATCH",
      );
    }
  }

  const { pubkeys, threshold } = parseMultisigLeaf(first.leafScript);
  const params = pearlParams("mainnet");

  // Rebuild from primitives and BIND: the recovered descriptor must
  // reproduce BOTH the leaf script and the output script byte-for-byte.
  // vaultDescriptorFromPubkeys re-sorts (BIP-67) and re-derives the NUMS
  // tweak, so a match proves the address commits to exactly this set.
  let descriptor;
  try {
    descriptor = vaultDescriptorFromPubkeys(threshold, pubkeys, params);
  } catch (e) {
    throw new VaultRecoveryError(
      `recovered cosigner set is invalid: ${e instanceof Error ? e.message : String(e)}`,
      "E_VAULT_BINDING",
    );
  }
  if (bytesToHex(descriptor.leafScript) !== firstLeafHex) {
    throw new VaultRecoveryError(
      "recovered leaf script does not match the PSBT leaf — binding failed",
      "E_VAULT_BINDING",
    );
  }
  if (bytesToHex(descriptor.outputScript) !== firstWitnessHex) {
    throw new VaultRecoveryError(
      "recovered vault address does not match the PSBT's spent script — binding failed",
      "E_VAULT_BINDING",
    );
  }

  return {
    threshold: descriptor.threshold,
    total: descriptor.total,
    sortedPubkeysHex: descriptor.sortedPubkeys.map((p) => bytesToHex(p)),
    address: descriptor.address,
    network: "mainnet",
    outputScriptHex: firstWitnessHex,
  };
}

export interface MySlot {
  vaultAccount: number;
  keyIndex: number;
  myPubkeyHex: string;
  originPath: string;
}

/**
 * Prove local membership in a recovered vault: scan our bounded multisig
 * slot range and return the (vaultAccount, keyIndex) whose derived x-only
 * pubkey appears in the cosigner set, or null if we hold no key in it.
 *
 * The derivation runs entirely inside the crypto worker — no privkey or
 * seed crosses the boundary; only the matched slot's public data returns.
 */
export async function findMySlotForVault(
  sortedPubkeysHex: readonly string[],
  opts?: { maxAccount?: number; maxIndex?: number },
): Promise<MySlot | null> {
  const r = await cryptoWorker.call<
    "findPearlMultisigSlot",
    { found: MySlot | null }
  >("findPearlMultisigSlot", {
    targetPubkeysHex: sortedPubkeysHex.map((h) => h.toLowerCase()),
    maxAccount: opts?.maxAccount ?? IMPORT_SCAN_MAX_ACCOUNT,
    maxIndex: opts?.maxIndex ?? IMPORT_SCAN_MAX_INDEX,
  });
  return r.found;
}

export interface ImportResult {
  vault: VaultRecord;
  created: boolean;
}

/** Suggest a human label for a freshly recovered vault. */
export function defaultVaultLabel(address: string): string {
  const head = address.slice(0, 9);
  const tail = address.slice(-5);
  return `Vault ${head}…${tail}`;
}

/**
 * Persist a recovered vault for which we've proven membership. Idempotent:
 * if a vault with the same Pearl address already exists locally, that
 * record is returned untouched (created=false) rather than duplicated.
 *
 * `createVault` independently re-verifies that `myPubkeyHex` is in the set
 * AND that re-deriving at (myVaultAccount, myKeyIndex) reproduces it, so a
 * wrong slot can never be persisted even if the scan misbehaved.
 */
export async function importRecoveredVault(opts: {
  recovered: RecoveredVault;
  slot: MySlot;
  label: string;
}): Promise<ImportResult> {
  const existing = (await listVaults()).find(
    (v) => v.pearlAddress === opts.recovered.address,
  );
  if (existing) {
    return { vault: existing, created: false };
  }
  const vault = await createVault({
    label: opts.label,
    threshold: opts.recovered.threshold,
    cosignerPubkeysHex: opts.recovered.sortedPubkeysHex,
    myPubkeyHex: opts.slot.myPubkeyHex,
    myVaultAccount: opts.slot.vaultAccount,
    myKeyIndex: opts.slot.keyIndex,
    network: opts.recovered.network,
    importedFrom: "cosign-proposal",
  });
  return { vault, created: true };
}
