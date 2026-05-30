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
import { encodeTaprootAddress } from "../chains/pearl/address";
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

  // Audit pass 3 M2: defend against a race in CreateVault where the user
  // adjusts (vaultAccount, keyIndex) AFTER the wizard derived a pubkey at
  // the previous slot. Re-derive at the slot we're about to PERSIST and
  // require it match the pubkey claimed as "mine". Without this, a vault
  // could be saved with myPubkeyHex bound to slot (0,0) but myKeyIndex
  // pointing at (0,1) — at spend time we'd try to sign with the slot-(0,1)
  // key, which isn't in the cosigner set, and the user would be permanently
  // locked out of participating in their own funded vault.
  const verify = await cryptoWorker.call<
    "derivePearlMultisigPubkey",
    { pubkeyHex: string; originPath: string }
  >("derivePearlMultisigPubkey", {
    vaultAccount: input.myVaultAccount,
    keyIndex: input.myKeyIndex,
  });
  if (verify.pubkeyHex.toLowerCase() !== myHex) {
    throw new Error("E_VAULT_PUBKEY_PATH_MISMATCH");
  }

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
    // The PSBT will have only the destination output, so the on-wire fee
    // equals sum - amountGrains (i.e. the recomputed 1-output fee PLUS the
    // dust that would have been the change PLUS the saved per-output vbytes).
    // We must store *that* value as preview.feeGrains, otherwise the pass-3
    // assertPsbtMatchesPreview check (services/multisig.ts:628) will refuse
    // to sign the originator's own draft with E_MULTISIG_OUTPUT_MISMATCH.
    numOutputs -= 1;
    const recomputed = estimateMultisigFee(picked.length, numOutputs, feerate);
    if (sum < opts.amountGrains + recomputed) throw new Error("E_INSUFFICIENT_FUNDS");
    fee = sum - opts.amountGrains;
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

/**
 * Mint a sig-return proof for posting a partial sig back to the relay.
 * The worker derives the cosigner privkey, computes the domain-separated
 * digest from (token, psbtBase64, signedAt), and BIP 340 Schnorr-signs
 * it. Main thread never sees the privkey or the raw digest — only the
 * pubkey and the proof come back.
 *
 * Used by SignMultisigPsbt's "Post to relay" path.
 */
export async function signVaultSigProof(opts: {
  vault: VaultRecord;
  token: string;
  psbtBase64: string;
  signedAt: number;
}): Promise<{ signerPubkeyHex: string; hmacProofHex: string }> {
  return await cryptoWorker.call<
    "signSigProofForVault",
    { signerPubkeyHex: string; hmacProofHex: string }
  >("signSigProofForVault", {
    req: {
      token: opts.token,
      psbtBase64: opts.psbtBase64,
      signedAt: opts.signedAt,
      vaultAccount: opts.vault.myVaultAccount,
      keyIndex: opts.vault.myKeyIndex,
      descriptor: wireDescriptorFromRecord(opts.vault),
    },
  });
}

export interface PsbtOutputInfo {
  /** Pearl bech32m address if the output script is P2TR; otherwise null. */
  address: string | null;
  /** Output amount in grains (bigint). */
  amountGrains: bigint;
  /** Raw output scriptPubKey hex — present even when address is null so the UI can still show something. */
  scriptHex: string;
}

export interface PsbtSignerInfo {
  /** Number of distinct VALID signers on input 0 (vault cosigners only, foreign keys excluded if validPubkeysHex provided). */
  signerCount: number;
  /** Lowercase hex x-only pubkeys that have a sig on input 0 AND are members of the vault (if validPubkeysHex provided). */
  signersHex: string[];
  /** Sigs from pubkeys NOT in the vault cosigner set. Empty unless validPubkeysHex was provided. A non-empty value flags a hostile or stale PSBT. */
  foreignSignersHex: string[];
  /** True when signerCount >= threshold. */
  thresholdMet: boolean;
  inputCount: number;
  /** vault.outputScript hex from the PSBT's first input (witnessUtxo). Lets the caller bind the PSBT to a vault record by lookup. */
  witnessScriptHex: string;
  /** Parsed outputs (address + amount) so the UI can show exactly what's being signed/broadcast. */
  outputs: PsbtOutputInfo[];
  /** Per-input witnessUtxo.amount in grains. */
  inputAmountsGrains: bigint[];
  /** Sum of input witnessUtxo.amount across all inputs. */
  totalInputGrains: bigint;
  /** Sum of output amounts. */
  totalOutputGrains: bigint;
  /** Fee = totalInputGrains - totalOutputGrains (sentinel 0n if feeUnknown). */
  feeGrains: bigint;
  /** True if any input is missing witnessUtxo.amount — fee cannot be computed; caller should treat as hostile. */
  feeUnknown: boolean;
  /** Network the addresses were decoded under — needed for sane error messages on cross-network PSBTs. v0.2.0 is mainnet-only. */
  network: "mainnet";
}

/**
 * Decode a P2TR output scriptPubKey ("OP_1 0x20 <32-byte program>") back to
 * its Pearl bech32m address. Returns null for any non-P2TR shape so the UI
 * surfaces the raw bytes rather than silently pretending.
 *
 * This is a CRITICAL display primitive — a malicious cosigner could try to
 * sneak a non-P2TR output past the user; if we returned `null` and the UI
 * skipped showing it, the user might broadcast without noticing.
 */
function p2trScriptToPearlAddress(
  scriptBytes: Uint8Array,
  network: "mainnet",
): string | null {
  // P2TR scriptPubKey = OP_1 (0x51) PUSH_32 (0x20) <32-byte program>
  if (scriptBytes.length !== 34) return null;
  if (scriptBytes[0] !== 0x51) return null;
  if (scriptBytes[1] !== 0x20) return null;
  try {
    return encodeTaprootAddress(scriptBytes.slice(2), pearlParams(network));
  } catch {
    return null;
  }
}

/**
 * Parse a PSBT and report its signing progress + outputs. Pure local
 * analysis — no worker round-trip, no key material involved.
 *
 * The optional `validPubkeysHex` parameter MUST be passed by any caller that
 * trusts the signerCount value for a threshold-met decision. Without it,
 * `inspectPsbt` falls back to legacy behavior (count every tapScriptSig
 * entry) — useful for opportunistic "match a PSBT to a vault" lookups but
 * unsafe as a basis for "ready to broadcast" UX. See PsbtSignerInfo.
 *
 * Throws E_MULTISIG_PSBT_PARSE on a malformed PSBT, E_PEARL_NO_INPUTS on a
 * shape with zero inputs.
 */
export function inspectPsbt(
  psbtBase64: string,
  threshold: number,
  validPubkeysHex?: readonly string[],
): PsbtSignerInfo {
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

  // Collect per-input amounts so we can compute fee. Any input lacking a
  // witnessUtxo.amount means the caller can't trust the fee figure — flag
  // `feeUnknown` rather than producing a bogus number. (Audit pass 3, M1.)
  const inputAmountsGrains: bigint[] = [];
  let totalInputGrains = 0n;
  let feeUnknown = false;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i) as { witnessUtxo?: { amount: bigint } };
    const amt = inp.witnessUtxo?.amount;
    if (typeof amt !== "bigint") {
      feeUnknown = true;
      inputAmountsGrains.push(0n);
    } else {
      inputAmountsGrains.push(amt);
      totalInputGrains += amt;
    }
  }
  // Dedupe by pubkey hex; a PSBT could (maliciously or accidentally) carry
  // two tapScriptSig entries for the same pubkey, and only one of them ends
  // up in the witness on finalize. We count distinct signing keys.
  const seen = new Set<string>();
  for (const [{ pubKey }] of sigEntries) {
    seen.add(bytesToHex(pubKey));
  }

  // Split signers into "in-vault" vs "foreign" if the caller supplied the
  // valid pubkey set. Without that set, every sig counts — backward-compat
  // for any caller that hasn't been migrated. Callers driving UX off the
  // result should always pass the valid set.
  let signersHex: string[];
  let foreignSignersHex: string[];
  if (validPubkeysHex) {
    const validSet = new Set(validPubkeysHex.map((h) => h.toLowerCase()));
    signersHex = [];
    foreignSignersHex = [];
    for (const h of seen) {
      if (validSet.has(h.toLowerCase())) signersHex.push(h);
      else foreignSignersHex.push(h);
    }
  } else {
    signersHex = Array.from(seen);
    foreignSignersHex = [];
  }

  const witnessScript = input0.witnessUtxo?.script;

  // Outputs — show the user exactly what they're signing.
  const outputs: PsbtOutputInfo[] = [];
  let totalOutputGrains = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i) as { script?: Uint8Array; amount?: bigint };
    const script = o.script ?? new Uint8Array(0);
    const amt = o.amount ?? 0n;
    outputs.push({
      address: p2trScriptToPearlAddress(script, "mainnet"),
      amountGrains: amt,
      scriptHex: bytesToHex(script),
    });
    totalOutputGrains += amt;
  }

  const feeGrains = feeUnknown
    ? 0n
    : totalInputGrains > totalOutputGrains
      ? totalInputGrains - totalOutputGrains
      : 0n;

  return {
    signerCount: signersHex.length,
    signersHex,
    foreignSignersHex,
    thresholdMet: signersHex.length >= threshold,
    inputCount: tx.inputsLength,
    witnessScriptHex: witnessScript ? bytesToHex(witnessScript) : "",
    outputs,
    inputAmountsGrains,
    totalInputGrains,
    totalOutputGrains,
    feeGrains,
    feeUnknown,
    network: "mainnet",
  };
}

/**
 * Heuristic: flag a PSBT whose fee looks like a fund-extraction attempt.
 * A hostile composer can pick big inputs and pay almost everything to fee
 * (which miners receive). 20% of inputs is well above any honest feerate
 * for a small tx — past that, the user should be forced to acknowledge.
 *
 * Returns `null` when fee is in sane bounds, or a human-readable reason
 * string otherwise. `feeUnknown` is treated as suspicious (no input amounts
 * means the cosigner is blind-signing — refuse).
 */
export function feeSuspiciousReason(info: PsbtSignerInfo): string | null {
  if (info.feeUnknown) {
    return "Input amounts are missing from the PSBT — fee can't be verified, so the wallet refuses to sign.";
  }
  if (info.totalInputGrains <= 0n) return null;
  // 20% fee threshold — anything beyond is almost certainly extraction.
  // Ten grains × 5 = 50 grains; we want fee_pct = (fee × 100) / inputs <= 20.
  const feePct = (info.feeGrains * 100n) / info.totalInputGrains;
  if (feePct > 20n) {
    return `Fee is ${feePct}% of the spend (${info.feeGrains} grains of ${info.totalInputGrains}). That's far above normal — refusing.`;
  }
  return null;
}

/**
 * Assert a PSBT still matches the originator's composition preview. Throws
 * E_MULTISIG_OUTPUT_MISMATCH on the first divergence (destination address,
 * destination amount, change address, change amount, output count, or fee).
 *
 * Used by signPendingTx / broadcastPendingTx as a defence-in-depth layer
 * (audit pass 3, L1). The UI also has its own outputMismatch check, but the
 * service-level assertion prevents any future caller (CLI, dev console,
 * automated flow) from bypassing the gate.
 */
export function assertPsbtMatchesPreview(
  info: PsbtSignerInfo,
  preview: VaultPendingTxRecord["preview"],
  vaultAddress: string,
): void {
  if (info.feeUnknown) {
    throw new Error("E_MULTISIG_OUTPUT_MISMATCH: PSBT inputs are missing amount data");
  }
  const expectedAmount = BigInt(preview.amountGrains);
  const expectedChange = BigInt(preview.changeGrains);
  const expectedFee = BigInt(preview.feeGrains);
  if (info.outputs.length === 0) {
    throw new Error("E_MULTISIG_OUTPUT_MISMATCH: PSBT has no outputs");
  }
  const dest = info.outputs[0]!;
  if (dest.address !== preview.destination) {
    throw new Error(
      `E_MULTISIG_OUTPUT_MISMATCH: destination is ${dest.address ?? "non-Pearl script"} (expected ${preview.destination})`,
    );
  }
  if (dest.amountGrains !== expectedAmount) {
    throw new Error(
      `E_MULTISIG_OUTPUT_MISMATCH: destination amount is ${dest.amountGrains} (expected ${expectedAmount})`,
    );
  }
  if (expectedChange > 0n) {
    if (info.outputs.length < 2) {
      throw new Error("E_MULTISIG_OUTPUT_MISMATCH: change output is missing");
    }
    const chg = info.outputs[1]!;
    if (chg.address !== vaultAddress) {
      throw new Error(
        `E_MULTISIG_OUTPUT_MISMATCH: change goes to ${chg.address ?? "non-Pearl script"} (expected ${vaultAddress})`,
      );
    }
    if (chg.amountGrains !== expectedChange) {
      throw new Error(
        `E_MULTISIG_OUTPUT_MISMATCH: change amount is ${chg.amountGrains} (expected ${expectedChange})`,
      );
    }
  }
  const expectedCount = expectedChange > 0n ? 2 : 1;
  if (info.outputs.length > expectedCount) {
    throw new Error(
      `E_MULTISIG_OUTPUT_MISMATCH: PSBT has ${info.outputs.length} outputs (expected ${expectedCount})`,
    );
  }
  if (info.feeGrains !== expectedFee) {
    throw new Error(
      `E_MULTISIG_OUTPUT_MISMATCH: fee is ${info.feeGrains} grains (expected ${expectedFee})`,
    );
  }
}

/**
 * Compare two PSBTs' output sets and return true if they're equivalent
 * (same script, same amount, in the same position). Used on paste-back to
 * detect a hostile cosigner who returned a PSBT with mutated outputs — the
 * witnessUtxo binding catches input mutation but not output mutation.
 */
export function psbtOutputsEqual(a: PsbtOutputInfo[], b: PsbtOutputInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.scriptHex !== b[i]!.scriptHex) return false;
    if (a[i]!.amountGrains !== b[i]!.amountGrains) return false;
  }
  return true;
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
  const info = inspectPsbt(
    opts.psbtBase64,
    opts.vault.threshold,
    opts.vault.sortedPubkeysHex,
  );
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
  const pre = inspectPsbt(
    opts.pending.psbtBase64,
    opts.vault.threshold,
    opts.vault.sortedPubkeysHex,
  );
  // Defence-in-depth (audit pass 3, L1): refuse to sign a draft whose PSBT
  // has been mutated to point at different outputs / fee than the originator
  // composed. The UI also has its own outputMismatch check; this ensures
  // any future caller (CLI, automated flow, dev-console fiddling) can't
  // bypass that gate.
  assertPsbtMatchesPreview(pre, opts.pending.preview, opts.vault.pearlAddress);
  if (pre.foreignSignersHex.length > 0) {
    throw new Error("E_MULTISIG_FOREIGN_SIGNER_PRESENT");
  }
  if (pre.signersHex.includes(myHex)) {
    return opts.pending;
  }
  const { psbtBase64 } = await signVaultPsbt({
    vault: opts.vault,
    psbtBase64: opts.pending.psbtBase64,
  });
  const info = inspectPsbt(psbtBase64, opts.vault.threshold, opts.vault.sortedPubkeysHex);
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
  const info = inspectPsbt(
    opts.pending.psbtBase64,
    opts.vault.threshold,
    opts.vault.sortedPubkeysHex,
  );
  // Same service-level invariants as signPendingTx (audit pass 3, L1).
  assertPsbtMatchesPreview(info, opts.pending.preview, opts.vault.pearlAddress);
  if (info.foreignSignersHex.length > 0) {
    throw new Error("E_MULTISIG_FOREIGN_SIGNER_PRESENT");
  }
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
