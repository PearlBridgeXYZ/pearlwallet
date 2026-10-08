// Single-sig Pearl P2TR signing — pure over the BIP-39 seed so the crypto
// worker and the test suite run the exact same code.
//
// Every input names the HD (branch, index) whose key spends it. The signer
// derives that key itself and REFUSES (E_PEARL_FOREIGN_INPUT) unless the
// key's BIP-86 P2TR scriptPubKey equals the prevout script the caller
// supplied — the main thread can never get a signature over a prevout this
// wallet does not own, nor make us sign with a key other than the one that
// controls that output. Mirrors the BTX (E_BTX_FOREIGN_INPUT) and multisig
// (E_MULTISIG_UTXO_NOT_VAULT) prevout-binding checks.
//
// Scope: only the single-sig account m/86'/808276'/0'/{0,1}/i. The multisig
// cosigner subtree (m/86'/808276'/100'/…) is not reachable from here —
// account and purpose are fixed, branch is 0|1.

import * as btc from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { bip86Tweak, decodeTaprootAddress } from "../chains/pearl/address";
import { pearlParams, type PearlNetwork } from "../chains/pearl/network";
import { isHdBranch, pearlAccountPath, pearlBranchPath, type HdBranch } from "./hd";

// One UTXO to spend. `scriptHex` is the prevout's scriptPubKey (P2TR:
// OP_1 <32-byte output key>, 34 bytes). (branch, index) names the key
// that controls it. valueGrains is a bigint as a decimal string.
export interface PearlUtxoSpec {
  txid: string;
  vout: number;
  valueGrains: string;
  scriptHex: string;
  branch: HdBranch;
  index: number;
}

export interface PearlTxOutput {
  address: string;
  amountGrains: string;
}

export interface PearlTxRequest {
  utxos: PearlUtxoSpec[];
  outputs: PearlTxOutput[];
  network: PearlNetwork;
}

/** Max inputs per signing request (bounds key derivations per call). */
export const MAX_PEARL_SIGN_INPUTS = 500;

function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** BIP-86 key-path P2TR scriptPubKey for a 32-byte x-only internal key,
 *  computed with the wallet's own tweak (independent of the signer lib). */
export function p2trScriptForInternalKey(xOnlyInternal: Uint8Array): Uint8Array {
  const out = new Uint8Array(34);
  out[0] = 0x51;
  out[1] = 0x20;
  out.set(bip86Tweak(xOnlyInternal), 2);
  return out;
}

/**
 * Build, sign and finalise a Pearl P2TR transaction spending single-sig
 * UTXOs from `seed`'s account m/86'/808276'/0'. Throws on any malformed
 * field or on an input whose script does not match its derived key.
 * Derived private material is wiped before returning or throwing.
 */
export function signPearlTxWithSeed(seed: Uint8Array, r: PearlTxRequest): { raw: string } {
  if (!r || !Array.isArray(r.utxos) || r.utxos.length === 0) {
    throw new Error("E_PEARL_NO_INPUTS");
  }
  if (r.utxos.length > MAX_PEARL_SIGN_INPUTS) throw new Error("E_PEARL_TOO_MANY_INPUTS");
  if (!Array.isArray(r.outputs) || r.outputs.length === 0) {
    throw new Error("E_PEARL_NO_OUTPUTS");
  }
  const params = pearlParams(r.network);
  const network = { bech32: params.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };

  // Shape checks first — no key derivation for a malformed request.
  const seen = new Set<string>();
  for (const u of r.utxos) {
    if (
      !u ||
      typeof u.txid !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(u.txid) ||
      typeof u.vout !== "number" ||
      !Number.isInteger(u.vout) ||
      u.vout < 0 ||
      typeof u.scriptHex !== "string" ||
      !/^[0-9a-fA-F]+$/.test(u.scriptHex) ||
      u.scriptHex.length % 2 !== 0 ||
      typeof u.valueGrains !== "string" ||
      !/^[0-9]+$/.test(u.valueGrains) ||
      !isHdBranch(u.branch) ||
      typeof u.index !== "number" ||
      !Number.isInteger(u.index) ||
      u.index < 0 ||
      u.index > 0x7fffffff
    ) {
      throw new Error("E_PEARL_UTXO_SHAPE");
    }
    if (BigInt(u.valueGrains) <= 0n) throw new Error("E_PEARL_UTXO_VALUE");
    const key = `${u.txid.toLowerCase()}:${u.vout}`;
    if (seen.has(key)) throw new Error("E_PEARL_DUPLICATE_INPUT");
    seen.add(key);
  }
  for (const o of r.outputs) {
    if (!o || typeof o.address !== "string" || typeof o.amountGrains !== "string" || !/^[0-9]+$/.test(o.amountGrains)) {
      throw new Error("E_PEARL_OUTPUT_SHAPE");
    }
    if (BigInt(o.amountGrains) <= 0n) throw new Error("E_PEARL_OUTPUT_VALUE");
  }

  const toWipe: HDKey[] = [];
  try {
    const master = HDKey.fromMasterSeed(seed);
    toWipe.push(master);
    const account = master.derive(pearlAccountPath());
    toWipe.push(account);
    const chains = new Map<HdBranch, HDKey>();
    const keys = new Map<string, HDKey>();
    const keyFor = (branch: HdBranch, index: number): HDKey => {
      const id = `${branch}/${index}`;
      let k = keys.get(id);
      if (!k) {
        let chain = chains.get(branch);
        if (!chain) {
          chain = account.deriveChild(branch);
          chains.set(branch, chain);
          toWipe.push(chain);
        }
        k = chain.deriveChild(index);
        toWipe.push(k);
        if (!k.privateKey || !k.publicKey) throw new Error("E_HD_DERIVE_FAILED");
        keys.set(id, k);
      }
      return k;
    };

    const tx = new btc.Transaction({ allowUnknownOutputs: false });
    const signers: HDKey[] = [];
    for (const u of r.utxos) {
      const k = keyFor(u.branch, u.index);
      const xOnly = k.publicKey!.slice(1);
      const expected = p2trScriptForInternalKey(xOnly);
      // Input binding: the prevout must pay exactly this key's P2TR output.
      if (toHex(expected) !== u.scriptHex.toLowerCase()) {
        throw new Error("E_PEARL_FOREIGN_INPUT");
      }
      tx.addInput({
        txid: fromHex(u.txid),
        index: u.vout,
        witnessUtxo: { amount: BigInt(u.valueGrains), script: expected },
        tapInternalKey: xOnly,
      });
      signers.push(k);
    }
    for (const o of r.outputs) {
      tx.addOutputAddress(o.address, BigInt(o.amountGrains), network);
    }
    // signIdx applies the BIP-86 tweak internally when tapInternalKey
    // matches the key's pubkey, so the raw child privkey is passed.
    for (let i = 0; i < signers.length; i++) {
      tx.signIdx(signers[i]!.privateKey!, i);
    }
    tx.finalize();
    return { raw: tx.hex };
  } finally {
    for (const k of toWipe) k.wipePrivateData();
  }
}

// ── Consolidation (self-transfer) ─────────────────────────────────────────

/** Most a consolidation may pay in fees, as a fraction of its inputs
 *  (numerator / denominator): 2 %. Mirrors services/pearl-consolidate. */
export const CONSOLIDATION_MAX_FEE_NUM = 2n;
export const CONSOLIDATION_MAX_FEE_DEN = 100n;

/** A consolidation: many of this wallet's coins into ONE output paying
 *  this wallet's own address at (branch, index). */
export interface PearlConsolidationRequest {
  utxos: PearlUtxoSpec[];
  outputs: PearlTxOutput[];
  /** HD position of the destination; the signer derives that address
   *  itself and refuses unless outputs[0] pays exactly it. */
  destination: { branch: HdBranch; index: number };
  network: PearlNetwork;
}

/**
 * Signs a consolidation after checking, independently of the caller,
 * that it really is one: exactly one output (so no tip and no third
 * party), paying the P2TR address of this seed's key at the given
 * (branch, index) (E_CONSOLIDATION_FOREIGN_OUTPUT), with a positive fee
 * no larger than 2 % of the inputs (E_CONSOLIDATION_FEE). Input binding
 * and all other checks are signPearlTxWithSeed's.
 */
export function signPearlConsolidationWithSeed(seed: Uint8Array, r: PearlConsolidationRequest): { raw: string } {
  if (!r || !Array.isArray(r.outputs) || r.outputs.length !== 1) {
    throw new Error("E_CONSOLIDATION_OUTPUTS");
  }
  const d = r.destination;
  if (
    !d ||
    !isHdBranch(d.branch) ||
    typeof d.index !== "number" ||
    !Number.isInteger(d.index) ||
    d.index < 0 ||
    d.index > 0x7fffffff
  ) {
    throw new Error("E_CONSOLIDATION_DESTINATION");
  }
  const out = r.outputs[0]!;
  if (!out || typeof out.address !== "string" || typeof out.amountGrains !== "string" || !/^[0-9]+$/.test(out.amountGrains)) {
    throw new Error("E_PEARL_OUTPUT_SHAPE");
  }
  if (!Array.isArray(r.utxos) || r.utxos.length === 0) throw new Error("E_PEARL_NO_INPUTS");

  // Destination binding: the one output must pay our own key.
  let program: Uint8Array;
  try {
    program = decodeTaprootAddress(out.address, pearlParams(r.network));
  } catch {
    throw new Error("E_CONSOLIDATION_FOREIGN_OUTPUT");
  }
  const master = HDKey.fromMasterSeed(seed);
  let expected: Uint8Array;
  try {
    const k = master.derive(pearlBranchPath(d.branch, d.index));
    try {
      if (!k.publicKey) throw new Error("E_HD_DERIVE_FAILED");
      expected = bip86Tweak(k.publicKey.slice(1));
    } finally {
      k.wipePrivateData();
    }
  } finally {
    master.wipePrivateData();
  }
  if (toHex(expected) !== toHex(program)) throw new Error("E_CONSOLIDATION_FOREIGN_OUTPUT");

  // Fee bounds: inputs = output + fee, 0 < fee ≤ 2 % of inputs.
  let inSum = 0n;
  for (const u of r.utxos) {
    if (!u || typeof u.valueGrains !== "string" || !/^[0-9]+$/.test(u.valueGrains)) {
      throw new Error("E_PEARL_UTXO_SHAPE");
    }
    inSum += BigInt(u.valueGrains);
  }
  const fee = inSum - BigInt(out.amountGrains);
  if (fee <= 0n || fee * CONSOLIDATION_MAX_FEE_DEN > inSum * CONSOLIDATION_MAX_FEE_NUM) {
    throw new Error("E_CONSOLIDATION_FEE");
  }
  return signPearlTxWithSeed(seed, { utxos: r.utxos, outputs: [out], network: r.network });
}
