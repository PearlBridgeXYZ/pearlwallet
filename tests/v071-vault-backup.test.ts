import { describe, expect, it, vi } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { vaultDescriptorFromPubkeys } from '../src/chains/pearl/multisig';
import { pearlParams } from '../src/chains/pearl/network';
import { bytesToHex } from '../src/crypto/descriptor';
import { pearlMultisigPath } from '../src/crypto/hd';
import { confirmVaultBackup, exportVaultBackup, parseVaultBackup, restoreVaultBackup } from '../src/services/vault-backup';
import * as multisig from '../src/services/multisig';
import { useWallet } from '../src/state/wallet-store';
import { cryptoWorker } from '../src/crypto/worker-client';
import { db } from '../src/storage/db';
import type { VaultRecord } from '../src/storage/db';
const pubkeys = [1,2,3].map(n=>schnorr.getPublicKey(new Uint8Array(32).fill(n)));
const d=vaultDescriptorFromPubkeys(2,pubkeys,pearlParams('mainnet'));
const record: VaultRecord={id:'test',version:1,label:'Family',threshold:2,total:3,sortedPubkeysHex:d.sortedPubkeys.map(bytesToHex),myPubkeyHex:bytesToHex(pubkeys[0]!),myOriginPath:pearlMultisigPath(7,2),myVaultAccount:7,myKeyIndex:2,pearlAddress:d.address,network:'mainnet',createdAt:1};
describe('vault recovery backup',()=>{
 it('round trips full policy, address and origin with no private material',()=>{
  const text=exportVaultBackup(record), b=parseVaultBackup(text);
  expect(b).toMatchObject({address:record.pearlAddress,threshold:2,pubkeys:record.sortedPubkeysHex,localSigner:{account:7,index:2,path:record.myOriginPath}});
  expect(Object.keys(b).sort()).toEqual(['address','format','label','localSigner','network','pubkeys','threshold','version']);
 });
 it.each(['threshold','address','pubkeys','localSigner'])('rejects mutated %s',field=>{
  const b=JSON.parse(exportVaultBackup(record));
  if(field==='threshold')b.threshold=1;
  if(field==='address')b.address+='x';
  if(field==='pubkeys')b.pubkeys[0]='00'.repeat(32);
  if(field==='localSigner')b.localSigner.index++;
  expect(()=>parseVaultBackup(JSON.stringify(b))).toThrow();
 });
 it('rejects oversized input before parsing',()=>expect(()=>parseVaultBackup(' '.repeat(16385))).toThrow('too large'));
 it('refuses a backup whose claimed local key is not held by this wallet',async()=>{
  useWallet.setState({status:'unlocked',addresses:{pearl:'test',eth:'0x123'} as never});
  const list=vi.spyOn(multisig,'listVaults').mockResolvedValue([]);
  const call=vi.spyOn(cryptoWorker,'call').mockResolvedValue({pubkeyHex:bytesToHex(pubkeys[1]!),originPath:record.myOriginPath});
  try { await expect(restoreVaultBackup(exportVaultBackup(record))).rejects.toThrow('E_VAULT_PUBKEY_PATH_MISMATCH'); }
  finally {list.mockRestore();call.mockRestore();useWallet.setState({status:'locked',addresses:null});}
 });
});


describe('backup confirmation and restore lifecycle',()=>{
 it('discards unexpected fields instead of retaining supplied secrets',()=>{
  const b=JSON.parse(exportVaultBackup(record));b.mnemonic='never retain';b.localSigner.privateKey='never retain';
  expect(JSON.stringify(parseVaultBackup(JSON.stringify(b)))).not.toContain('never retain');
 });
 it('opens an existing vault rather than restoring a duplicate',async()=>{
  useWallet.setState({status:'unlocked',addresses:{pearl:'test',eth:'0x123'} as never});
  const list=vi.spyOn(multisig,'listVaults').mockResolvedValue([record]);
  try{expect(await restoreVaultBackup(exportVaultBackup(record))).toBe(record);}finally{list.mockRestore();useWallet.setState({status:'locked',addresses:null});}
 });
 it('does not confirm a backup for a wallet replaced in another tab',async()=>{
  useWallet.setState({status:'unlocked',addresses:{pearl:'old',eth:'0x123'} as never});
  const tx=vi.spyOn(db,'transaction').mockImplementation((async(...args:unknown[])=>(args.at(-1) as ()=>Promise<void>)()) as never);
  const get=vi.spyOn(db.keystore,'get').mockResolvedValue({publicData:{pearlAddress:'new'}} as never);
  const update=vi.spyOn(db.vaults,'update').mockResolvedValue(1);
  try{await expect(confirmVaultBackup(record.id)).rejects.toThrow('E_WALLET_CHANGED');expect(update).not.toHaveBeenCalled();}
  finally{tx.mockRestore();get.mockRestore();update.mockRestore();useWallet.setState({status:'locked',addresses:null});}
 });
});
