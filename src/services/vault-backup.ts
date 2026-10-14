import { vaultDescriptorFromPubkeys } from '../chains/pearl/multisig';
import { pearlParams } from '../chains/pearl/network';
import { bytesToHex, hexToBytes } from '../crypto/descriptor';
import { pearlMultisigPath } from '../crypto/hd';
import { captureSigningSession, assertSigningSession, sessionWalletPrimary } from '../state/wallet-store';
import { createVault, listVaults } from './multisig';
import { db } from '../storage/db';
import type { VaultRecord } from '../storage/db';

export interface VaultBackup {
  format: 'pearl-vault-recovery'; version: 1; network: 'mainnet';
  label: string; address: string; threshold: number; pubkeys: string[];
  localSigner: { pubkey: string; account: number; index: number; path: string };
}

/** Public policy only. Never include a seed, private key or relay token. */
export function exportVaultBackup(v: VaultRecord): string {
  const backup: VaultBackup = {
    format:'pearl-vault-recovery', version:1, network:v.network,
    label:v.label, address:v.pearlAddress, threshold:v.threshold, pubkeys:[...v.sortedPubkeysHex],
    localSigner:{pubkey:v.myPubkeyHex,account:v.myVaultAccount,index:v.myKeyIndex,path:v.myOriginPath},
  };
  parseVaultBackup(JSON.stringify(backup));
  return JSON.stringify(backup, null, 2);
}

export function parseVaultBackup(text: string): VaultBackup {
  if (text.length > 16384) throw new Error('Vault backup is too large.');
  let b: VaultBackup;
  try { b = JSON.parse(text) as VaultBackup; } catch { throw new Error("Invalid vault recovery JSON."); }
  if (!b || b.format !== 'pearl-vault-recovery' || b.version !== 1 || b.network !== 'mainnet' ||
      typeof b.label !== 'string' || b.label.trim().length < 1 || b.label.length > 64 ||
      !Number.isInteger(b.threshold) || !Array.isArray(b.pubkeys) || b.pubkeys.length > 15 ||
      !b.pubkeys.every(p => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))) throw new Error('Invalid vault recovery format.');
  const signer = b.localSigner;
  if (!signer || ![signer.account,signer.index].every(n => Number.isSafeInteger(n) && n >= 0 && n < 0x80000000) ||
      !b.pubkeys.includes(signer.pubkey) || signer.path !== pearlMultisigPath(signer.account,signer.index)) throw new Error('Invalid local signer origin.');
  const descriptor = vaultDescriptorFromPubkeys(b.threshold,b.pubkeys.map(hexToBytes),pearlParams('mainnet'));
  if (descriptor.address !== b.address || descriptor.sortedPubkeys.map(bytesToHex).join() !== b.pubkeys.join()) throw new Error('Vault policy does not reproduce the saved address.');
  return {format:b.format,version:1,network:b.network,label:b.label,address:b.address,threshold:b.threshold,pubkeys:[...b.pubkeys],localSigner:{pubkey:signer.pubkey,account:signer.account,index:signer.index,path:signer.path}};
}

export async function restoreVaultBackup(text: string): Promise<VaultRecord> {
  const session = captureSigningSession();
  const b = parseVaultBackup(text);
  const existing = (await listVaults()).find(v => v.pearlAddress === b.address);
  assertSigningSession(session);
  if (existing) return existing;
  // createVault re-derives the local key, checks membership, and atomically
  // binds the saved record to the wallet which began this operation.
  return createVault({label:b.label,threshold:b.threshold,cosignerPubkeysHex:b.pubkeys,
    myPubkeyHex:b.localSigner.pubkey,myVaultAccount:b.localSigner.account,myKeyIndex:b.localSigner.index,network:b.network});
}

export function downloadVaultBackup(v: VaultRecord): void {
  const url = URL.createObjectURL(new Blob([exportVaultBackup(v)],{type:'application/json'}));
  const a = document.createElement('a'); a.href=url; a.download=`pearl-vault-${v.pearlAddress}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/** Only updates an existing vault; never resurrect a deleted/wiped record. */
export async function confirmVaultBackup(id: string): Promise<void> {
  const owner=sessionWalletPrimary();if(!owner)throw new Error('E_LOCKED');
  await db.transaction('rw',[db.keystore,db.vaults],async()=>{
    const wallet=await db.keystore.get('primary');
    if(wallet?.publicData.pearlAddress!==owner)throw new Error('E_WALLET_CHANGED');
    if(!await db.vaults.get(id))throw new Error('E_VAULT_NOT_FOUND');
    await db.vaults.update(id,{backupConfirmedAt:Date.now()});
  });
}
