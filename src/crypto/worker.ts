// Web Worker — all key material lives here. Main thread never sees raw keys.
// Verb-based RPC per docs/06-CRYPTO.md.

import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
} from "./mnemonic";
import {
  masterFromSeed,
  DEFAULT_ETH_PATH,
  RECEIVE_GAP_LIMIT,
  pearlReceivePath,
} from "./hd";
import { encryptPlaintext, decryptBlob, type EncryptedBlob } from "./keystore";
import { pearlAddressFromCompressedPubkey } from "../chains/pearl/address";
import { pearlParams, type PearlNetwork } from "../chains/pearl/network";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";

interface PearlReceiveKey {
  index: number;
  privKey: Uint8Array;
  pubKey: Uint8Array;
}

// WorkerSession deliberately does NOT carry the mnemonic past derivation.
// The mnemonic is in scope only inside the createWallet/restoreWallet/
// unlock handlers, just long enough to derive the HD keys. Keeping it
// resident here would make a worker-memory snapshot (DevTools heap dump,
// crash report, attacker with browser process access) leak the seed
// phrase — flagged by the v0.1.7 audit (opus2 H4). Re-export of the
// mnemonic still requires the password (exportMnemonic decrypts the
// stored blob), so we lose nothing by dropping it after derive.
interface WorkerSession {
  // External receive pool — RECEIVE_GAP_LIMIT entries, index 0..N-1.
  pearlReceive: PearlReceiveKey[];
  ethPrivKey: Uint8Array;
  ethPubKey: Uint8Array;
}

let session: WorkerSession | null = null;

function wipeSession(): void {
  if (!session) return;
  for (const k of session.pearlReceive) k.privKey.fill(0);
  session.ethPrivKey.fill(0);
  session = null;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  // Reject malformed hex at the boundary. parseInt silently coerces non-hex
  // chars to NaN (which Uint8Array maps to 0), and integer division of an
  // odd-length string truncates the trailing nibble. A manually edited
  // keystore JSON with a one-char-off salt/iv would decrypt to garbage on
  // an incorrect-but-valid-shaped key — fail loudly instead.
  if (clean.length === 0 || clean.length % 2 !== 0) {
    throw new Error("E_INVALID_HEX_LENGTH");
  }
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("E_INVALID_HEX_CHARS");
  }
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
  pearlReceive: PearlReceiveKey[];
  ethPrivKey: Uint8Array;
  ethPubKey: Uint8Array;
}> {
  const seed = await mnemonicToSeed(mnemonic);
  const master = masterFromSeed(seed);

  const pearlReceive: PearlReceiveKey[] = [];
  for (let i = 0; i < RECEIVE_GAP_LIMIT; i++) {
    const node = master.derive(pearlReceivePath(i));
    if (!node.privateKey || !node.publicKey) {
      throw new Error(`HD derivation failed at pearl receive index ${i}`);
    }
    pearlReceive.push({
      index: i,
      privKey: node.privateKey,
      pubKey: node.publicKey,
    });
  }

  const ethNode = master.derive(DEFAULT_ETH_PATH);
  if (!ethNode.privateKey || !ethNode.publicKey) {
    throw new Error("HD derivation failed at eth path");
  }
  return {
    pearlReceive,
    ethPrivKey: ethNode.privateKey,
    ethPubKey: ethNode.publicKey,
  };
}

function pearlAddressesFromSession(
  s: WorkerSession,
  network: PearlNetwork,
): string[] {
  const params = pearlParams(network);
  return s.pearlReceive.map((k) => pearlAddressFromCompressedPubkey(k.pubKey, params));
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
  // Primary (index 0). Kept for compatibility with code that just needs one
  // address (e.g. legacy publicData on the keystore record).
  pearl: string;
  // External receive pool, ordered by index 0..RECEIVE_GAP_LIMIT-1.
  pearlPool: string[];
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
      // Wipe any prior session before reassigning so a previously
      // unlocked wallet's private keys are zeroed before the new ones
      // replace the binding. Without this, the orphaned Uint8Arrays
      // can sit in worker heap until GC.
      wipeSession();
      const mnemonic = generateMnemonic(msg.strength);
      const keys = await seedFromMnemonic(mnemonic);
      session = { ...keys };
      const pool = pearlAddressesFromSession(session, msg.network);
      const eth = ethAddressFromPubkey(keys.ethPubKey);
      const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic }));
      const blob = await encryptPlaintext(plaintext, msg.password);
      const out: CreatedWallet = {
        mnemonic,
        blob: blobToJSON(blob),
        addresses: { pearl: pool[0]!, pearlPool: pool, eth },
      };
      return out;
    }

    case "restoreWallet": {
      if (!validateMnemonic(msg.mnemonic)) {
        throw new Error("E_INVALID_MNEMONIC");
      }
      wipeSession();
      const mnemonic = msg.mnemonic.trim().toLowerCase();
      const keys = await seedFromMnemonic(mnemonic);
      session = { ...keys };
      const pool = pearlAddressesFromSession(session, msg.network);
      const eth = ethAddressFromPubkey(keys.ethPubKey);
      const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic }));
      const blob = await encryptPlaintext(plaintext, msg.password);
      const out: CreatedWallet = {
        mnemonic,
        blob: blobToJSON(blob),
        addresses: { pearl: pool[0]!, pearlPool: pool, eth },
      };
      return out;
    }

    case "unlock": {
      wipeSession();
      const plaintext = await decryptBlob(blobFromJSON(msg.blob), msg.password);
      const { mnemonic } = JSON.parse(new TextDecoder().decode(plaintext)) as {
        mnemonic: string;
      };
      const keys = await seedFromMnemonic(mnemonic);
      session = { ...keys };
      const pool = pearlAddressesFromSession(session, msg.network);
      const eth = ethAddressFromPubkey(keys.ethPubKey);
      const out: UnlockedResult = {
        addresses: { pearl: pool[0]!, pearlPool: pool, eth },
      };
      return out;
    }

    case "lock":
      wipeSession();
      return { ok: true };

    case "deriveAddresses": {
      if (!session) throw new Error("E_LOCKED");
      const pool = pearlAddressesFromSession(session, msg.network);
      const eth = ethAddressFromPubkey(session.ethPubKey);
      const out: Addresses = { pearl: pool[0]!, pearlPool: pool, eth };
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
  // Origin guard. A same-origin worker spawned via `new Worker(url)` only
  // accepts messages from the spawning Window, so ev.origin should match
  // self.location.origin. A `""` origin appears under file:// loads and
  // some legacy test runners — accept those too (the wallet's threat
  // model assumes an active attacker would need cross-origin posting to
  // matter here). Flagged by minimax2 v0.1.7 audit as defense-in-depth.
  // We accept "" (file:// / Node test env) and the exact self.location
  // origin. Reject anything else — including a sibling iframe whose
  // origin happens to be a substring of ours.
  const expected = (self as unknown as { location?: { origin?: string } }).location?.origin;
  if (ev.origin && expected && ev.origin !== expected) {
    return;
  }
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
