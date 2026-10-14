import * as btc from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from './descriptor';
import { MAX_VAULT_INPUTS, vaultDescriptorFromPubkeys } from '../chains/pearl/multisig';
import { pearlParams } from '../chains/pearl/network';

/** Verify the actual vault commitment and every signature on every input.
 * Only DEFAULT/ALL signatures are accepted: a cosigner must commit to all
 * reviewed outputs. Invalid entries never count as approval. */
export function vaultSignatureProgress(tx: btc.Transaction) {
  if (tx.inputsLength < 1 || tx.inputsLength > MAX_VAULT_INPUTS) throw new Error('E_MULTISIG_INPUT_COUNT');
  const first = tx.getInput(0).tapLeafScript;
  if (!first || first.length !== 1) throw new Error('E_MULTISIG_LEAF');
  const script = first[0]![1].slice(0, -1);
  const decoded = btc.OutScript.decode(script);
  if (decoded.type !== 'tr_ms') throw new Error('E_MULTISIG_LEAF');
  const vault = vaultDescriptorFromPubkeys(decoded.m, decoded.pubkeys, pearlParams('mainnet'));
  const hex = bytesToHex;
  const leafHash = tapLeafHash(vault.leafScript, vault.leafVersion);
  const scripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i), leaf = input.tapLeafScript;
    // NUMS vaults are script-path only. Finalizers otherwise prioritize an
    // unverified key-path witness over the validated script signatures.
    if (input.tapKeySig || input.finalScriptWitness?.length || input.finalScriptSig?.length) throw new Error('E_MULTISIG_SPENDING_PATH');
    if (!input.witnessUtxo || input.witnessUtxo.amount <= 0n ||
        hex(input.witnessUtxo.script) !== hex(vault.outputScript) ||
        !leaf || leaf.length !== 1 || hex(leaf[0]![1]) !== hex(vault.tapLeafScript[0]![1]) ||
        leaf[0]![0].version !== vault.tapLeafScript[0]![0].version ||
        hex(leaf[0]![0].internalKey) !== hex(vault.internalKey) || leaf[0]![0].merklePath.length !== 0) {
      throw new Error('E_MULTISIG_VAULT_BINDING');
    }
    scripts.push(input.witnessUtxo.script); amounts.push(input.witnessUtxo.amount);
  }
  const members = new Set(vault.sortedPubkeys.map(hex));
  const perInput: Set<string>[] = [];
  const foreign = new Set<string>();
  for (let i = 0; i < tx.inputsLength; i++) {
    const valid = new Set<string>();
    for (const [key, signature] of tx.getInput(i).tapScriptSig ?? []) {
      const pub = hex(key.pubKey);
      if (!members.has(pub)) { foreign.add(pub); continue; }
      const type = signature.length === 64 ? 0 : signature.length === 65 && signature[64] === 1 ? 1 : -1;
      let ok = false;
      if (type >= 0 && hex(key.leafHash) === hex(leafHash)) {
        const digest = tx.preimageWitnessV1(i, scripts, type, amounts, undefined, vault.leafScript, vault.leafVersion);
        try { ok = schnorr.verify(signature.slice(0, 64), digest, key.pubKey); } catch { /* invalid */ }
      }
      if (!ok) throw new Error('E_MULTISIG_INVALID_SIGNATURE');
      valid.add(pub);
    }
    perInput.push(valid);
  }
  return {
    vault,
    signersHex: [...perInput[0]!].filter(key => perInput.every(s => s.has(key))),
    signerCount: Math.min(...perInput.map(s => s.size)),
    thresholdMet: perInput.every(s => s.size >= vault.threshold) && foreign.size === 0,
    foreignSignersHex: [...foreign],
  };
}
