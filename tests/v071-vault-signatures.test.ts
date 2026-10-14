import {feeSuspiciousReason} from '../src/services/multisig';
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { tapLeafHash } from '@scure/btc-signer/payment';
import { vaultSignatureProgress } from '../src/crypto/vault-signatures';
import { assertVaultFeePolicy, vaultDescriptorFromPubkeys } from '../src/chains/pearl/multisig';
import { pearlParams } from '../src/chains/pearl/network';
const keys = [1,2,3].map(n => new Uint8Array(32).fill(n));
const vault = vaultDescriptorFromPubkeys(2, keys.map(k=>schnorr.getPublicKey(k)), pearlParams('mainnet'));
function transaction() {
 const tx = new btc.Transaction();
 for(let i=0;i<2;i++) tx.addInput({txid:new Uint8Array(32).fill(i+1),index:0,witnessUtxo:{amount:100000n,script:vault.outputScript},tapInternalKey:vault.internalKey,tapLeafScript:vault.tapLeafScript});
 tx.addOutput({amount:190000n,script:vault.outputScript});return tx;
}
describe('cryptographically verified per-input vault approvals',()=>{
 it('does not report ready when only the first input is signed',()=>{
  const t=transaction(); t.signIdx(keys[0]!,0);t.signIdx(keys[1]!,0);
  expect(vaultSignatureProgress(t)).toMatchObject({thresholdMet:false,signerCount:0,signersHex:[]});
 });
 it('supports distinct valid signer sets across inputs',()=>{
  const t=transaction();t.signIdx(keys[0]!,0);t.signIdx(keys[1]!,0);t.signIdx(keys[1]!,1);t.signIdx(keys[2]!,1);
  const p=vaultSignatureProgress(t);expect(p.thresholdMet).toBe(true);expect(p.signerCount).toBe(2);expect(p.signersHex).toHaveLength(1);
 });
 it('rejects fabricated signature entries under legitimate cosigner keys',()=>{
  const t=transaction();t.updateInput(0,{tapScriptSig:[[{pubKey:schnorr.getPublicKey(keys[0]!),leafHash:tapLeafHash(vault.leafScript)},new Uint8Array(64)]]});
  expect(()=>vaultSignatureProgress(t)).toThrow('E_MULTISIG_INVALID_SIGNATURE');
 });
 it('rejects signatures after a reviewed output changes',()=>{
  const t=transaction();t.signIdx(keys[0]!,0);
  const bad=new btc.Transaction();
  for(let i=0;i<t.inputsLength;i++){ const input=t.getInput(i); delete input.tapScriptSig; bad.addInput(input); }
  bad.addOutput({amount:180000n,script:vault.outputScript});
  bad.updateInput(0,{tapScriptSig:t.getInput(0).tapScriptSig});
  expect(()=>vaultSignatureProgress(bad)).toThrow('E_MULTISIG_INVALID_SIGNATURE');
 });
 it('rejects a forged key-path signature even with enough genuine script signatures',()=>{
  const t=transaction();for(let i=0;i<2;i++){t.signIdx(keys[0]!,i);t.signIdx(keys[1]!,i);}
  t.updateInput(0,{tapKeySig:new Uint8Array(64)});
  expect(()=>vaultSignatureProgress(t)).toThrow('E_MULTISIG_SPENDING_PATH');
 });
 it('accepts a complete valid transaction and finalizes it',()=>{
  const t=transaction();for(let i=0;i<2;i++){t.signIdx(keys[0]!,i);t.signIdx(keys[1]!,i);}
  expect(vaultSignatureProgress(t).thresholdMet).toBe(true);t.finalize();expect(t.hex.length).toBeGreaterThan(100);
 });
});


describe('shared vault fee policy',()=>{
 it('accepts exactly 20 percent and refuses one grain over',()=>{
  expect(()=>assertVaultFeePolicy(100000n,20000n)).not.toThrow();
  expect(()=>assertVaultFeePolicy(100000n,20001n)).toThrow('E_PEARL_FEE_CAP');
  expect(()=>assertVaultFeePolicy(100000n,0n)).toThrow('E_PEARL_FEE_CAP');
  expect(feeSuspiciousReason({feeUnknown:false,totalInputGrains:100000n,feeGrains:20001n} as never)).toContain('20% limit');
  expect(feeSuspiciousReason({feeUnknown:false,totalInputGrains:100000n,feeGrains:20000n} as never)).toBeNull();
 });
});
