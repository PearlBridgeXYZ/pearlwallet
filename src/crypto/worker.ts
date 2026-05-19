// Web Worker — all key material lives here. Main thread never sees raw keys.
// Verb-based RPC per docs/06-CRYPTO.md.

import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
} from "./mnemonic";
import { masterFromSeed, DEFAULT_PEARL_PATH, DEFAULT_ETH_PATH } from "./hd";
import { encryptPlaintext, decryptBlob, type EncryptedBlob } from "./keystore";
import { pearlAddressFromCompressedPubkey } from "../chains/pearl/address";
import { pearlParams, type PearlNetwork } from "../chains/pearl/network";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";

interface WorkerSession {
  mnemonic: string;
  pearlPrivKey: Uint8Array;
  pearlPubKey: Uint8Array;
  ethPrivKey: Uint8Array;
  ethPubKey: Uint8Array;
}

let session: WorkerSession | null = null;

function wipeSession(): void {
  if (!session) return;
  session.pearlPrivKey.fill(0);
  session.ethPrivKey.fill(0);
  session = null;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function ethAddressFromPubkey(pubKey: Uint8Array): string {
  // Uncompressed pubkey is 65 bytes (0x04 + X + Y). Strip prefix, keccak, take last 20.
  const point = secp256k1.ProjectivePoint.fromHex(pubKey);
  const uncompressed = point.toRawBytes(false); // 65 bytes with 0x04 prefix
  const hash = keccak_256(uncompressed.slice(1));
  const addr = hash.slice(-20);
  return toChecksumAddress("0x" + bytesToHex(addr));
}

function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addr)));
  let result = "0x";
  for (let i = 0; i < addr.length; i++) {
    const c = addr[i]!;
    if (parseInt(hash[i]!, 16) >= 8) {
      result += c.toUpperCase();
    } else {
      result += c;
    }
  }
  return result;
}

async function seedFromMnemonic(mnemonic: string): Promise<{
  pearlPrivKey: Uint8Array;
  pearlPubKey: Uint8Array;
  ethPrivKey: Uint8Array;
  ethPubKey: Uint8Array;
}> {
  const seed = await mnemonicToSeed(mnemonic);
  const master = masterFromSeed(seed);

  const pearlNode = master.derive(DEFAULT_PEARL_PATH);
  const ethNode = master.derive(DEFAULT_ETH_PATH);
  if (
    !pearlNode.privateKey ||
    !pearlNode.publicKey ||
    !ethNode.privateKey ||
    !ethNode.publicKey
  ) {
    throw new Error("HD derivation failed");
  }
  return {
    pearlPrivKey: pearlNode.privateKey,
    pearlPubKey: pearlNode.publicKey,
    ethPrivKey: ethNode.privateKey,
    ethPubKey: ethNode.publicKey,
  };
}

interface BlobJSON {
  version: 1;
  kdf: "PBKDF2-SHA256";
  kdfIterations: number;
  kdfSalt: string;
  cipher: "AES-256-GCM";
  iv: string;
  aad: string;
  ciphertext: string;
}

function blobToJSON(blob: EncryptedBlob): BlobJSON {
  return {
    version: blob.version,
    kdf: blob.kdf,
    kdfIterations: blob.kdfIterations,
    kdfSalt: bytesToHex(blob.kdfSalt),
    cipher: blob.cipher,
    iv: bytesToHex(blob.iv),
    aad: bytesToHex(blob.aad),
    ciphertext: bytesToHex(blob.ciphertext),
  };
}

function blobFromJSON(j: BlobJSON): EncryptedBlob {
  return {
    version: j.version,
    kdf: j.kdf,
    kdfIterations: j.kdfIterations,
    kdfSalt: hexToBytes(j.kdfSalt),
    cipher: j.cipher,
    iv: hexToBytes(j.iv),
    aad: hexToBytes(j.aad),
    ciphertext: hexToBytes(j.ciphertext),
  };
}

export type WorkerCmd =
  | { id: string; cmd: "createWallet"; strength: 128 | 256; password: string; network: PearlNetwork }
  | { id: string; cmd: "restoreWallet"; mnemonic: string; password: string; network: PearlNetwork }
  | { id: string; cmd: "unlock"; blob: BlobJSON; password: string; network: PearlNetwork }
  | { id: string; cmd: "lock" }
  | { id: string; cmd: "deriveAddresses"; network: PearlNetwork }
  | { id: string; cmd: "exportMnemonic"; password: string; blob: BlobJSON }
  | { id: string; cmd: "validateMnemonic"; mnemonic: string }
  | { id: string; cmd: "generateMnemonic"; strength: 128 | 256 }
  | { id: string; cmd: "changePassword"; oldPassword: string; newPassword: string; blob: BlobJSON };

export type WorkerResp =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

interface Addresses {
  pearl: string;
  eth: string;
}

interface CreatedWallet {
  mnemonic: string;
  blob: BlobJSON;
  addresses: Addresses;
}

interface UnlockedResult {
  addresses: Addresses;
}

async function handle(msg: WorkerCmd): Promise<unknown> {
  switch (msg.cmd) {
    case "generateMnemonic":
      return { mnemonic: generateMnemonic(msg.strength) };

    case "validateMnemonic":
      return { valid: validateMnemonic(msg.mnemonic) };

    case "createWallet": {
      const mnemonic = generateMnemonic(msg.strength);
      const keys = await seedFromMnemonic(mnemonic);
      session = { mnemonic, ...keys };
      const params = pearlParams(msg.network);
      const pearl = pearlAddressFromCompressedPubkey(keys.pearlPubKey, params);
      const eth = ethAddressFromPubkey(keys.ethPubKey);
      const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic }));
      const blob = await encryptPlaintext(plaintext, msg.password);
      const out: CreatedWallet = {
        mnemonic,
        blob: blobToJSON(blob),
        addresses: { pearl, eth },
      };
      return out;
    }

    case "restoreWallet": {
      if (!validateMnemonic(msg.mnemonic)) {
        throw new Error("E_INVALID_MNEMONIC");
      }
      const mnemonic = msg.mnemonic.trim().toLowerCase();
      const keys = await seedFromMnemonic(mnemonic);
      session = { mnemonic, ...keys };
      const params = pearlParams(msg.network);
      const pearl = pearlAddressFromCompressedPubkey(keys.pearlPubKey, params);
      const eth = ethAddressFromPubkey(keys.ethPubKey);
      const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic }));
      const blob = await encryptPlaintext(plaintext, msg.password);
      const out: CreatedWallet = {
        mnemonic,
        blob: blobToJSON(blob),
        addresses: { pearl, eth },
      };
      return out;
    }

    case "unlock": {
      const plaintext = await decryptBlob(blobFromJSON(msg.blob), msg.password);
      const { mnemonic } = JSON.parse(new TextDecoder().decode(plaintext)) as {
        mnemonic: string;
      };
      const keys = await seedFromMnemonic(mnemonic);
      session = { mnemonic, ...keys };
      const params = pearlParams(msg.network);
      const pearl = pearlAddressFromCompressedPubkey(keys.pearlPubKey, params);
      const eth = ethAddressFromPubkey(keys.ethPubKey);
      const out: UnlockedResult = { addresses: { pearl, eth } };
      return out;
    }

    case "lock":
      wipeSession();
      return { ok: true };

    case "deriveAddresses": {
      if (!session) throw new Error("E_LOCKED");
      const params = pearlParams(msg.network);
      const pearl = pearlAddressFromCompressedPubkey(session.pearlPubKey, params);
      const eth = ethAddressFromPubkey(session.ethPubKey);
      const out: Addresses = { pearl, eth };
      return out;
    }

    case "exportMnemonic": {
      // Require both: an active session AND correct password to decrypt the blob.
      const plaintext = await decryptBlob(blobFromJSON(msg.blob), msg.password);
      const { mnemonic } = JSON.parse(new TextDecoder().decode(plaintext)) as {
        mnemonic: string;
      };
      return { mnemonic };
    }

    case "changePassword": {
      const plaintext = await decryptBlob(blobFromJSON(msg.blob), msg.oldPassword);
      const newBlob = await encryptPlaintext(plaintext, msg.newPassword);
      return { blob: blobToJSON(newBlob) };
    }
  }
}

self.onmessage = async (ev: MessageEvent<WorkerCmd>) => {
  const msg = ev.data;
  try {
    const result = await handle(msg);
    const resp: WorkerResp = { id: msg.id, ok: true, result };
    (self as unknown as Worker).postMessage(resp);
  } catch (err) {
    const resp: WorkerResp = {
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(resp);
  }
};
