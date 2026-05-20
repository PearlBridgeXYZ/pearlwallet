// Multisig vault service — top-level façade over:
//   - Dexie vault registry (vaults + vaultPendingTxs tables)
//   - Crypto worker (cosigner pubkey derivation, PSBT composition + signing)
//   - Pearl RPC (UTXO scan for vault address, raw-tx broadcast)
//   - PSBT analysis (signer-set extraction, threshold-met check, finalisation)
//
// The on-the-wire artefact between cosigners is the **PSBT base64**. The
// originating cosigner composes it, signs it once, hands the partially-
// signed PSBT to the next cosigner over their channel of choice (paste box,
// QR, signed message). Each cosigner verifies, signs, and returns. Once
// m signatures are present the holder finalises locally and broadcasts.
//
// We carry our own derived child key paths in the local vault record so
// signing later can call `derivePearlMultisigPubkey` / `signPearlMultisigPsbt`
// against the right BIP-32 slot without searching.

import { base64 } from "@scure/base";
import * as btc from "@scure/btc-signer";
import {
  db,
  type VaultRecord,
  type VaultPendingTxRecord,
} from "../storage/db";
import {
  vaultDescriptorFromPubkeys,
  type VaultDescriptor,
} from "../chains/pearl/multisig";
import { pearlParams } from "../chains/pearl/network";
import { cryptoWorker } from "../crypto/worker-client";
import {
  encodePubkeyDescriptor,
  parsePubkeyDescriptor,
  hexToBytes,
  bytesToHex,
  type PearlMultisigPubkeyDescriptor,
} from "../crypto/descriptor";
import { pearlMultisigPath } from "../crypto/hd";
import {
  fetchPrlUtxos,
  fetchPrlBalanceGrains,
  broadcastPearlTx,
  type PrlUtxo,
} from "./pearl-rpc";
import type {
  PearlMultisigComposePsbtRequest,
  PearlMultisigUtxoSpec,
  PearlTxOutput,
  VaultDescriptorOverWire,
} from "../crypto/worker";

// Fee + dust knobs mirrored from pearl-tx.ts. Multisig spends are bigger
// (script + control block per input) so the per-input vbyte estimate is
// generous to avoid stalls. Re-using the constants from the singlesig path
// would under-estimate the witness for tr_ms.
const PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE = 2n;
// Witness for 2-of-3 tr_ms: 2 × 64-byte sigs + 1 empty + ~37-byte leaf + 33-byte
// control block ≈ 230 bytes ÷ 4 = 58 vweight + 41-byte non-witness header.
// We bump to 100 vbytes/input to leave headroom for 3-of-5 and similar.
const PER_INPUT_VBYTES_MULTISIG = 100n;
const PER_P2TR_OUTPUT_VBYTES = 43n;
const FIXED_OVERHEAD_VBYTES = 11n;
const DUST_LIMIT_GRAINS = 546n;

function estimateMultisigFee(numInputs: number, numOutputs: number, feerate: bigint): bigint {
  const vbytes =
    FIXED_OVERHEAD_VBYTES +
    BigInt(numInputs) * PER_INPUT_VBYTES_MULTISIG +
    BigInt(numOutputs) * PER_P2TR_OUTPUT_VBYTES;
  return vbytes * feerate;
}

function newUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older Safari, some
  // test runners). Not cryptographically strong, but vault IDs aren't a
  // security primitive — they're local indexing keys.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Vault registry
// ---------------------------------------------------------------------------

/** Return all known vaults, newest first. */
export async function listVaults(): Promise<VaultRecord[]> {
  const out = await db.vaults.toArray();
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getVault(id: string): Promise<VaultRecord | undefined> {
  return db.vaults.get(id);
}

export async function deleteVault(id: string): Promise<void> {
  // Cascade delete pending txs — they reference a vaultId and a dangling
  // record is just stale clutter in the UI.
  await db.transaction("rw", db.vaults, db.vaultPendingTxs, async () => {
    await db.vaultPendingTxs.where("vaultId").equals(id).delete();
    await db.vaults.delete(id);
  });
}

export interface CreateVaultInput {
  label: string;
  threshold: number;
  /** Lowercase hex x-only pubkeys, including the user's own. Order is normalised internally. */
  cosignerPubkeysHex: string[];
  /** Our pubkey hex — must be present in cosignerPubkeysHex. */
  myPubkeyHex: string;
  /** The BIP-32 vault account index we derived our pubkey under. */
  myVaultAccount: number;
  /** The BIP-32 key index we derived our pubkey under. */
  myKeyIndex: number;
  /** Network — only "mainnet" is supported in v0.2.0. */
  network: "mainnet";
}

/**
 * Create + persist a vault record. The address is derived locally from the
 * cosigner pubkey set, threshold, and Pearl HRP, so two cosigners running
 * this with the same inputs land on the same vault address — that equality
 * is what they verify by side-channel before funding.
 */
export async function createVault(input: CreateVaultInput): Promise<VaultRecord> {
  const label = input.label.trim();
  if (label.length === 0 || label.length > 64) {
    throw new Error("E_VAULT_BAD_LABEL");
  }
  if (
    !Number.isInteger(input.myVaultAccount) ||
    input.myVaultAccount < 0 ||
    input.myVaultAccount > 0x7fffffff
  ) {
    throw new Error("E_VAULT_BAD_ORIGIN");
  }
  if (
    !Number.isInteger(input.myKeyIndex) ||
    input.myKeyIndex < 0 ||
    input.myKeyIndex > 0x7fffffff
  ) {
    throw new Error("E_VAULT_BAD_ORIGIN");
  }
  const pubkeys = input.cosignerPubkeysHex.map((h) => hexToBytes(h));
  const params = pearlParams(input.network);
  // vaultDescriptorFromPubkeys throws E_MULTISIG_* on any structural issue
  // (duplicates, bad threshold, bad pubkey length). Bubble up unchanged so
  // the wizard can render the exact failure.
  const descriptor = vaultDescriptorFromPubkeys(input.threshold, pubkeys, params);

  // Verify my pubkey is in the set (after BIP-67 sort the descriptor stores
  // the canonical order).
  const myHex = input.myPubkeyHex.toLowerCase();
  const isMember = descriptor.sortedPubkeys.some((p) => bytesToHex(p) === myHex);
  if (!isMember) throw new Error("E_VAULT_NOT_A_COSIGNER");

  const record: VaultRecord = {
    id: newUuid(),
    version: 1,
    label,
    threshold: descriptor.threshold,
    total: descriptor.total,
    sortedPubkeysHex: descriptor.sortedPubkeys.map((p) => bytesToHex(p)),
    myPubkeyHex: myHex,
    myOriginPath: pearlMultisigPath(input.myVaultAccount, input.myKeyIndex),
    myVaultAccount: input.myVaultAccount,
    myKeyIndex: input.myKeyIndex,
    pearlAddress: descriptor.address,
    network: input.network,
    createdAt: Date.now(),
  };
  await db.vaults.put(record);
  return record;
}

/**
 * Rebuild the on-chain VaultDescriptor (leaf script, output key, address, etc.)
 * from a persisted record. Used by every spend / sign / verify path so the
 * derivation chain is always: record → descriptor, no cached intermediates.
 */
export function descriptorFromRecord(rec: VaultRecord): VaultDescriptor {
  const pubkeys = rec.sortedPubkeysHex.map((h) => hexToBytes(h));
  const params = pearlParams(rec.network);
  return vaultDescriptorFromPubkeys(rec.threshold, pubkeys, params);
}

/**
 * Worker-side wire shape derived from a record. Use this when calling
 * `composePearlMultisigPsbt` / `signPearlMultisigPsbt` so the worker can
 * re-derive the same VaultDescriptor.
 */
export function wireDescriptorFromRecord(rec: VaultRecord): VaultDescriptorOverWire {
  return {
    threshold: rec.threshold,
    sortedPubkeysHex: rec.sortedPubkeysHex,
    network: rec.network,
  };
}

// ---------------------------------------------------------------------------
// Cosigner descriptor exchange (pubkey JSON)
// ---------------------------------------------------------------------------

export interface ExportedPubkeyDescriptor {
  json: string;
  pubkeyHex: string;
  originPath: string;
}

/**
 * Derive this wallet's cosigner pubkey at the requested vault-account /
 * key-index slot and return it formatted as a JSON descriptor ready to
 * paste into a counterparty's CreateVault wizard.
 */
export async function exportMyCosignerDescriptor(opts: {
  vaultAccount: number;
  keyIndex: number;
  label: string;
}): Promise<ExportedPubkeyDescriptor> {
  const { pubkeyHex, originPath } = await cryptoWorker.call<
    "derivePearlMultisigPubkey",
    { pubkeyHex: string; originPath: string }
  >("derivePearlMultisigPubkey", {
    vaultAccount: opts.vaultAccount,
    keyIndex: opts.keyIndex,
  });
  const json = encodePubkeyDescriptor({
    xOnlyPubkey: hexToBytes(pubkeyHex),
    originPath,
    label: opts.label,
  });
  return { json, pubkeyHex, originPath };
}

export function importCosignerDescriptor(json: string): {
  descriptor: PearlMultisigPubkeyDescriptor;
  pubkeyHex: string;
} {
  const { descriptor, xOnlyPubkey } = parsePubkeyDescriptor(json);
  return { descriptor, pubkeyHex: bytesToHex(xOnlyPubkey) };
}

// ---------------------------------------------------------------------------
// Vault balance / UTXO
// ---------------------------------------------------------------------------

export interface VaultBalance {
  grains: bigint;
  degraded: boolean;
}

export async function fetchVaultBalance(rec: VaultRecord): Promise<VaultBalance> {
  return fetchPrlBalanceGrains(rec.pearlAddress);
}

export async function fetchVaultUtxos(rec: VaultRecord): Promise<{ utxos: PrlUtxo[]; degraded: boolean }> {
  return fetchPrlUtxos(rec.pearlAddress);
}

// ---------------------------------------------------------------------------
// PSBT lifecycle
// ---------------------------------------------------------------------------

export interface ComposeVaultSendOpts {
  vault: VaultRecord;
  destination: string;
  amountGrains: bigint;
  feerateSatPerVbyte?: bigint;
}

export interface ComposedVaultSend {
  /** PSBT base64 — initial state, no sigs yet. */
  psbtBase64: string;
  utxos: PrlUtxo[];
  outputs: { address: string; amountGrains: bigint }[];
  feeGrains: bigint;
  changeGrains: bigint;
  degraded: boolean;
  amountGrains: bigint;
  destination: string;
}

/**
 * Greedy coin selection on the vault's UTXO set. Same shape as the singlesig
 * composer in pearl-tx.ts but with the multisig vbytes-per-input bumped to
 * cover the larger witness footprint.
 *
 * Change is paid back to the vault address. Tip is intentionally omitted —
 * the tip toggle is a singlesig-side opt-in; multisig spenders shouldn't be
 * surprised by an extra output on a co-signed PSBT.
 */
export async function composeVaultSend(opts: ComposeVaultSendOpts): Promise<ComposedVaultSend> {
  const feerate = opts.feerateSatPerVbyte ?? PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE;
  const { utxos: avail, degraded } = await fetchPrlUtxos(opts.vault.pearlAddress);
  if (avail.length === 0) throw new Error("E_NO_UTXOS");

  // Largest-first selection — minimises input count and witness footprint.
  const sorted = [...avail].sort((a, b) =>
    a.valueGrains > b.valueGrains ? -1 : a.valueGrains < b.valueGrains ? 1 : 0,
  );

  let numOutputs = 2; // dest + change (provisional)
  const picked: PrlUtxo[] = [];
  let sum = 0n;
  for (const u of sorted) {
    picked.push(u);
    sum += u.valueGrains;
    const fee = estimateMultisigFee(picked.length, numOutputs, feerate);
    if (sum >= opts.amountGrains + fee) break;
  }
  let fee = estimateMultisigFee(picked.length, numOutputs, feerate);
  let need = opts.amountGrains + fee;
  if (sum < need) throw new Error("E_INSUFFICIENT_FUNDS");

  let change = sum - need;
  if (change < DUST_LIMIT_GRAINS) {
    // Coalesce dust change into fee — same heuristic as singlesig.
    numOutputs -= 1;
    fee = estimateMultisigFee(picked.length, numOutputs, feerate);
    need = opts.amountGrains + fee;
    if (sum < need) throw new Error("E_INSUFFICIENT_FUNDS");
    change = 0n;
  }

  const outputs: { address: string; amountGrains: bigint }[] = [
    { address: opts.destination, amountGrains: opts.amountGrains },
  ];
  if (change > 0n) {
    outputs.push({ address: opts.vault.pearlAddress, amountGrains: change });
  }

  // Ask the worker to assemble the PSBT — it has the vault descriptor
  // reconstruction logic and the btc-signer Transaction class.
  const wireUtxos: PearlMultisigUtxoSpec[] = picked.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    valueGrains: u.valueGrains.toString(),
    scriptHex: u.scriptHex,
  }));
  const wireOutputs: PearlTxOutput[] = outputs.map((o) => ({
    address: o.address,
    amountGrains: o.amountGrains.toString(),
  }));
  const composeReq: PearlMultisigComposePsbtRequest = {
    utxos: wireUtxos,
    outputs: wireOutputs,
    network: opts.vault.network,
    descriptor: wireDescriptorFromRecord(opts.vault),
  };
  const { psbtBase64 } = await cryptoWorker.call<
    "composePearlMultisigPsbt",
    { psbtBase64: string }
  >("composePearlMultisigPsbt", { req: composeReq });

  return {
    psbtBase64,
    utxos: picked,
    outputs,
    feeGrains: fee,
    changeGrains: change,
    degraded,
    amountGrains: opts.amountGrains,
    destination: opts.destination,
  };
}

/**
 * Apply our cosigner signature to a PSBT (fresh or partially-signed) and
 * return the updated PSBT base64. Caller is responsible for handing the
 * result back to the next cosigner (or to the finalise path if threshold
 * is now met).
 */
export async function signVaultPsbt(opts: {
  vault: VaultRecord;
  psbtBase64: string;
}): Promise<{ psbtBase64: string }> {
  const out = await cryptoWorker.call<
    "signPearlMultisigPsbt",
    { psbtBase64: string }
  >("signPearlMultisigPsbt", {
    req: {
      psbtBase64: opts.psbtBase64,
      descriptor: wireDescriptorFromRecord(opts.vault),
      vaultAccount: opts.vault.myVaultAccount,
      keyIndex: opts.vault.myKeyIndex,
    },
  });
  return out;
}

export interface PsbtSignerInfo {
  /** Number of distinct signers on input 0. All inputs share the cosigner set under our compose path so input 0 is representative. */
  signerCount: number;
  /** Lowercase hex x-only pubkeys that have a sig on input 0. */
  signersHex: string[];
  /** True when signerCount >= threshold. */
  thresholdMet: boolean;
  inputCount: number;
  /** vault.outputScript hex from the PSBT's first input (witnessUtxo). Lets the caller bind the PSBT to a vault record by lookup. */
  witnessScriptHex: string;
}

/**
 * Parse a PSBT and report its signing progress. Pure local analysis — no
 * worker round-trip, no key material involved.
 *
 * Throws E_MULTISIG_PSBT_PARSE on a malformed PSBT, E_PEARL_NO_INPUTS on a
 * shape with zero inputs.
 */
export function inspectPsbt(psbtBase64: string, threshold: number): PsbtSignerInfo {
  if (typeof psbtBase64 !== "string" || psbtBase64.length === 0) {
    throw new Error("E_MULTISIG_BAD_PSBT");
  }
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64));
  } catch (err) {
    throw new Error(
      `E_MULTISIG_PSBT_PARSE: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (tx.inputsLength === 0) throw new Error("E_PEARL_NO_INPUTS");

  const input0 = tx.getInput(0) as {
    tapScriptSig?: Array<[{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array]>;
    witnessUtxo?: { script: Uint8Array; amount: bigint };
  };
  const sigEntries = input0.tapScriptSig ?? [];
  const seen = new Set<string>();
  for (const [{ pubKey }] of sigEntries) {
    seen.add(bytesToHex(pubKey));
  }
  const signersHex = Array.from(seen);
  const witnessScript = input0.witnessUtxo?.script;
  return {
    signerCount: signersHex.length,
    signersHex,
    thresholdMet: signersHex.length >= threshold,
    inputCount: tx.inputsLength,
    witnessScriptHex: witnessScript ? bytesToHex(witnessScript) : "",
  };
}

/**
 * Finalise a PSBT (threshold must be met) and return the raw signed tx hex
 * ready for broadcast. Local-only — no key material.
 *
 * The signature assembly is delegated to @scure/btc-signer's finalize()
 * which knows how to lay out tr_ms witnesses (sigs in pubkey-script order,
 * empty pushes for non-signers, reversed for stack ordering, leafScript +
 * controlBlock appended). See the binding test for the canonical layout.
 */
export function finalizeVaultPsbt(psbtBase64: string): { rawHex: string } {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64));
  } catch (err) {
    throw new Error(
      `E_MULTISIG_PSBT_PARSE: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    tx.finalize();
  } catch (err) {
    throw new Error(
      `E_MULTISIG_PSBT_NOT_FINALIZABLE: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { rawHex: tx.hex };
}

export async function broadcastVaultTx(rawHex: string): Promise<string> {
  return broadcastPearlTx(rawHex);
}

// ---------------------------------------------------------------------------
// Pending-tx persistence (a "draft" / "in-flight" PSBT bound to a vault)
// ---------------------------------------------------------------------------

export async function listPendingTxs(vaultId: string): Promise<VaultPendingTxRecord[]> {
  const out = await db.vaultPendingTxs.where("vaultId").equals(vaultId).toArray();
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPendingTx(id: string): Promise<VaultPendingTxRecord | undefined> {
  return db.vaultPendingTxs.get(id);
}

export async function savePendingTx(rec: VaultPendingTxRecord): Promise<void> {
  await db.vaultPendingTxs.put(rec);
}

export async function deletePendingTx(id: string): Promise<void> {
  await db.vaultPendingTxs.delete(id);
}

/**
 * Convenience: persist a freshly-composed (or freshly-imported) PSBT as a
 * pending tx and return its record. Status is derived from inspectPsbt.
 */
export async function persistComposedAsPending(opts: {
  vault: VaultRecord;
  psbtBase64: string;
  preview: VaultPendingTxRecord["preview"];
}): Promise<VaultPendingTxRecord> {
  const info = inspectPsbt(opts.psbtBase64, opts.vault.threshold);
  const rec: VaultPendingTxRecord = {
    id: newUuid(),
    vaultId: opts.vault.id,
    psbtBase64: opts.psbtBase64,
    signersHex: info.signersHex,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: info.thresholdMet ? "ready" : "drafting",
    preview: opts.preview,
  };
  await db.vaultPendingTxs.put(rec);
  return rec;
}

/**
 * Sign the pending tx with our cosigner key, update the stored record, and
 * return the new state.
 *
 * Idempotent: if our cosigner pubkey is already in the PSBT's signer set,
 * we skip the worker round-trip and return the pending record as-is. This
 * matters because btc-signer's `signIdx` does NOT silently overwrite an
 * existing tapScriptSig entry — it throws on the duplicate-key merge (the
 * second BIP-340 schnorr signature differs from the first due to random
 * auxRand). Without this guard, a user who hits "Sign" twice would see a
 * crash rather than a no-op.
 */
export async function signPendingTx(opts: {
  vault: VaultRecord;
  pending: VaultPendingTxRecord;
}): Promise<VaultPendingTxRecord> {
  const myHex = opts.vault.myPubkeyHex.toLowerCase();
  const pre = inspectPsbt(opts.pending.psbtBase64, opts.vault.threshold);
  if (pre.signersHex.includes(myHex)) {
    return opts.pending;
  }
  const { psbtBase64 } = await signVaultPsbt({
    vault: opts.vault,
    psbtBase64: opts.pending.psbtBase64,
  });
  const info = inspectPsbt(psbtBase64, opts.vault.threshold);
  const updated: VaultPendingTxRecord = {
    ...opts.pending,
    psbtBase64,
    signersHex: info.signersHex,
    status: info.thresholdMet ? "ready" : "drafting",
    updatedAt: Date.now(),
  };
  await db.vaultPendingTxs.put(updated);
  return updated;
}

/**
 * Finalise + broadcast a pending tx (threshold already met). Updates the
 * record to status="broadcast" with the returned txid, or "failed" if the
 * sentry rejects the raw tx.
 */
export async function broadcastPendingTx(opts: {
  vault: VaultRecord;
  pending: VaultPendingTxRecord;
}): Promise<VaultPendingTxRecord> {
  const info = inspectPsbt(opts.pending.psbtBase64, opts.vault.threshold);
  if (!info.thresholdMet) throw new Error("E_MULTISIG_THRESHOLD_NOT_MET");

  const { rawHex } = finalizeVaultPsbt(opts.pending.psbtBase64);
  let txid: string;
  try {
    txid = await broadcastPearlTx(rawHex);
  } catch (err) {
    const failed: VaultPendingTxRecord = {
      ...opts.pending,
      status: "failed",
      updatedAt: Date.now(),
    };
    await db.vaultPendingTxs.put(failed);
    throw err;
  }
  const broadcast: VaultPendingTxRecord = {
    ...opts.pending,
    status: "broadcast",
    txid,
    updatedAt: Date.now(),
  };
  await db.vaultPendingTxs.put(broadcast);
  return broadcast;
}

// Re-export the fee knobs so tests / UI can show estimates.
export {
  PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE,
  PER_INPUT_VBYTES_MULTISIG,
  PER_P2TR_OUTPUT_VBYTES,
  FIXED_OVERHEAD_VBYTES,
  DUST_LIMIT_GRAINS,
};
