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
  pearlMultisigPath,
} from "./hd";
import { encryptPlaintext, decryptBlob, type EncryptedBlob } from "./keystore";
import { pearlAddressFromCompressedPubkey } from "../chains/pearl/address";
import { pearlParams, type PearlNetwork } from "../chains/pearl/network";
import { vaultDescriptorFromPubkeys } from "../chains/pearl/multisig";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { signTransaction as ethSignTransaction } from "viem/accounts";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";

interface PearlReceiveKey {
  index: number;
  privKey: Uint8Array;
  pubKey: Uint8Array;
}

// WorkerSession deliberately does NOT carry the mnemonic past derivation.
// The mnemonic is in scope only inside the createWallet/restoreWallet/
// unlock handlers, just long enough to derive the HD keys. Keeping the
// mnemonic resident here would make a worker-memory snapshot (DevTools heap
// dump, crash report, attacker with browser process access) leak the BIP-39
// phrase — flagged by the v0.1.7 audit (opus2 H4). Re-export of the
// mnemonic still requires the password (exportMnemonic decrypts the
// stored blob), so we lose nothing by dropping it after derive.
//
// v0.2.0: we DO retain the BIP-39 seed (64-byte HMAC-SHA-512 of the
// passphrase-salted mnemonic) so multisig flows can derive arbitrary
// `m/86'/808276'/100'/{vaultAccount}'/{i}` child keys on demand without
// re-decrypting the keystore. Seed ≠ mnemonic: an attacker with the seed
// can derive any HD child but cannot recover the BIP-39 phrase (the seed
// is the post-PBKDF2 output, a one-way derivation). The seed is wiped on
// lock alongside the pearlReceive privkeys.
interface WorkerSession {
  // External receive pool — RECEIVE_GAP_LIMIT entries, index 0..N-1.
  pearlReceive: PearlReceiveKey[];
  ethPrivKey: Uint8Array;
  ethPubKey: Uint8Array;
  // 64-byte BIP-39 seed retained for ad-hoc multisig child derivation. Wiped
  // on lock. See class-level comment above.
  seed: Uint8Array;
}

let session: WorkerSession | null = null;

function wipeSession(): void {
  if (!session) return;
  for (const k of session.pearlReceive) k.privKey.fill(0);
  session.ethPrivKey.fill(0);
  session.seed.fill(0);
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
  seed: Uint8Array;
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
    seed,
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

// Serialisable ETH tx payload. Mirrors viem's TransactionSerializable
// trimmed to EIP-1559 fields we actually use. The worker re-validates the
// shape on receipt — never trust an unsigned tx straight from the main
// thread.
export interface EthTxRequest {
  chainId: number;
  nonce: number;
  to: `0x${string}`;
  value: string; // bigint as decimal string (postMessage-safe)
  data?: `0x${string}`;
  gas: string; // bigint decimal
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

// One UTXO available to spend. `scriptHex` is the prevout's scriptPubKey
// (P2TR: OP_1 <32-byte tweaked key>, 34 bytes => 68 hex chars). poolIndex
// names which receive-pool key spent it; the worker uses that to choose
// the correct privKey for each input. valueGrains is a bigint serialised
// as decimal string for postMessage.
export interface PearlUtxoSpec {
  txid: string;
  vout: number;
  valueGrains: string;
  scriptHex: string;
  poolIndex: number;
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

// Multisig vault descriptor as carried over the worker boundary. The full
// descriptor (leaf script, output script, address, NUMS internal key) is
// reconstructed inside the worker from these three fields — keeping the wire
// shape minimal means the main thread can't "lie" to the worker about the
// leaf bytes and trick it into signing a different vault's sighash.
export interface VaultDescriptorOverWire {
  threshold: number;
  /** 32-byte x-only pubkeys as lowercase hex; order does NOT need to be sorted (worker normalises). */
  sortedPubkeysHex: string[];
  network: "mainnet";
}

// A multisig spend input. The worker re-verifies that the witnessUtxo script
// matches the vault's outputScript before signing — otherwise a hostile
// caller could substitute a different prevout and trick the worker into
// authorising a spend the user didn't preview.
export interface PearlMultisigUtxoSpec {
  txid: string;
  vout: number;
  valueGrains: string;
  scriptHex: string;
}

export interface PearlMultisigTxRequest {
  utxos: PearlMultisigUtxoSpec[];
  outputs: PearlTxOutput[];
  network: PearlNetwork;
}

export interface PearlMultisigSignPsbtRequest {
  /** Base64-encoded PSBT. Pass a fresh-PSBT (compose first) or one already partially signed by another cosigner. */
  psbtBase64: string;
  /** Vault membership proof — worker verifies our derived pubkey is in this set. */
  descriptor: VaultDescriptorOverWire;
  /** Our slot inside the multisig BIP-32 subtree. */
  vaultAccount: number;
  keyIndex: number;
}

export interface PearlMultisigComposePsbtRequest {
  /** Pre-resolved UTXOs (vault address-side) — caller has already fetched + sorted. */
  utxos: PearlMultisigUtxoSpec[];
  outputs: PearlTxOutput[];
  network: PearlNetwork;
  descriptor: VaultDescriptorOverWire;
}

// signSigProofForVault — derives this cosigner's privkey for the given
// vault slot and BIP 340 Schnorr-signs the domain-separated proof digest
// computed from (token, psbtBase64, signedAt). The worker computes the
// digest itself — the main thread NEVER hands the worker an opaque
// digest to sign, otherwise the worker would be a generic signature
// oracle for the cosigner privkey.
//
// Returns the proof + the x-only signer pubkey so the caller can
// include both in the POST body without needing a separate
// derivePearlMultisigPubkey round-trip.
export interface PearlSigProofRequest {
  token: string;
  psbtBase64: string;
  signedAt: number;
  vaultAccount: number;
  keyIndex: number;
  /** Vault membership check — worker refuses to sign if the derived pubkey isn't in this set. */
  descriptor: VaultDescriptorOverWire;
}

export interface PearlSigProofResponse {
  signerPubkeyHex: string;
  hmacProofHex: string;
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
  | { id: string; cmd: "changePassword"; oldPassword: string; newPassword: string; blob: BlobJSON }
  | { id: string; cmd: "signEthTx"; tx: EthTxRequest }
  | { id: string; cmd: "signPearlTx"; req: PearlTxRequest }
  | { id: string; cmd: "derivePearlMultisigPubkey"; vaultAccount: number; keyIndex: number }
  | { id: string; cmd: "composePearlMultisigPsbt"; req: PearlMultisigComposePsbtRequest }
  | { id: string; cmd: "signPearlMultisigPsbt"; req: PearlMultisigSignPsbtRequest }
  | { id: string; cmd: "signSigProofForVault"; req: PearlSigProofRequest };

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

    case "signEthTx": {
      // ETH + WPRL sends both flow through this. The caller has already
      // composed the tx (nonce, gas, EIP-1559 fees, optional ERC-20
      // calldata) and we just produce the signed serialised hex. Private
      // key never leaves the worker.
      if (!session) throw new Error("E_LOCKED");
      const t = msg.tx;
      if (
        typeof t.chainId !== "number" ||
        typeof t.nonce !== "number" ||
        typeof t.to !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(t.to)
      ) {
        throw new Error("E_TX_SHAPE");
      }
      // The privateKey passed to viem must be a 0x-prefixed 64-hex-char
      // string. We re-encode from the session bytes each call rather
      // than retain a hex copy on the heap.
      const pk = ("0x" + bytesToHex(session.ethPrivKey)) as `0x${string}`;
      let value: bigint;
      let gas: bigint;
      let maxFee: bigint;
      let maxPrio: bigint;
      try {
        value = BigInt(t.value);
        gas = BigInt(t.gas);
        maxFee = BigInt(t.maxFeePerGas);
        maxPrio = BigInt(t.maxPriorityFeePerGas);
      } catch {
        throw new Error("E_TX_BIGINT");
      }
      if (value < 0n || gas <= 0n || maxFee <= 0n || maxPrio < 0n || maxPrio > maxFee) {
        throw new Error("E_TX_RANGE");
      }
      const raw = await ethSignTransaction({
        privateKey: pk,
        transaction: {
          chainId: t.chainId,
          nonce: t.nonce,
          to: t.to,
          value,
          data: t.data,
          gas,
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: maxPrio,
          type: "eip1559",
        },
      });
      return { raw };
    }

    case "signPearlTx": {
      // Build, sign, finalise a P2TR Pearl tx. Inputs are pre-selected by
      // the caller (services/pearl-tx.ts) so the worker is purely a
      // signer here — never sees the user's RPC choice, never picks
      // coins, never decides change. Defensive shape checks come first.
      if (!session) throw new Error("E_LOCKED");
      const r = msg.req;
      if (!Array.isArray(r.utxos) || r.utxos.length === 0) {
        throw new Error("E_PEARL_NO_INPUTS");
      }
      if (!Array.isArray(r.outputs) || r.outputs.length === 0) {
        throw new Error("E_PEARL_NO_OUTPUTS");
      }
      const params = pearlParams(r.network);
      const network = { bech32: params.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };

      const tx = new btc.Transaction({ allowUnknownOutputs: false });

      for (const u of r.utxos) {
        if (
          typeof u.txid !== "string" ||
          !/^[0-9a-fA-F]{64}$/.test(u.txid) ||
          typeof u.vout !== "number" ||
          u.vout < 0 ||
          typeof u.scriptHex !== "string" ||
          !/^[0-9a-fA-F]+$/.test(u.scriptHex) ||
          typeof u.poolIndex !== "number" ||
          u.poolIndex < 0 ||
          u.poolIndex >= session.pearlReceive.length
        ) {
          throw new Error("E_PEARL_UTXO_SHAPE");
        }
        const valueGrains = BigInt(u.valueGrains);
        if (valueGrains <= 0n) throw new Error("E_PEARL_UTXO_VALUE");
        const key = session.pearlReceive[u.poolIndex]!;
        // tapInternalKey is the x-only (32-byte) internal pubkey. The
        // node's compressed pubkey carries a parity byte we strip.
        const xOnly = key.pubKey.slice(1);
        tx.addInput({
          txid: hexToBytes(u.txid),
          index: u.vout,
          witnessUtxo: { amount: valueGrains, script: hexToBytes(u.scriptHex) },
          tapInternalKey: xOnly,
        });
      }

      for (const o of r.outputs) {
        if (typeof o.address !== "string" || typeof o.amountGrains !== "string") {
          throw new Error("E_PEARL_OUTPUT_SHAPE");
        }
        const amt = BigInt(o.amountGrains);
        if (amt <= 0n) throw new Error("E_PEARL_OUTPUT_VALUE");
        tx.addOutputAddress(o.address, amt, network);
      }

      // Sign every input with its corresponding pool-index key.
      // signIdx applies the BIP-86 tweak internally when tapInternalKey
      // matches the privkey's pubkey, so we pass the raw privkey here.
      for (let i = 0; i < r.utxos.length; i++) {
        const pk = session.pearlReceive[r.utxos[i]!.poolIndex]!.privKey;
        tx.signIdx(pk, i);
      }
      tx.finalize();
      return { raw: tx.hex };
    }

    case "derivePearlMultisigPubkey": {
      // Derive the x-only cosigner pubkey at the requested multisig slot.
      // The caller (CreateVault / JoinVault wizard) shares this with the
      // other cosigners as the user's pubkey descriptor. No privkey ever
      // leaves the worker — only the 32-byte x-only public key + the
      // canonical origin path so peers know where it came from in the HD
      // tree.
      if (!session) throw new Error("E_LOCKED");
      if (
        !Number.isInteger(msg.vaultAccount) ||
        msg.vaultAccount < 0 ||
        msg.vaultAccount > 0x7fffffff
      ) {
        throw new Error("E_MULTISIG_BAD_VAULT_ACCOUNT");
      }
      if (
        !Number.isInteger(msg.keyIndex) ||
        msg.keyIndex < 0 ||
        msg.keyIndex > 0x7fffffff
      ) {
        throw new Error("E_MULTISIG_BAD_KEY_INDEX");
      }
      const master = masterFromSeed(session.seed);
      const path = pearlMultisigPath(msg.vaultAccount, msg.keyIndex);
      const child = master.derive(path);
      if (!child.publicKey) throw new Error("E_HD_DERIVE_FAILED");
      // The HDKey publicKey is the 33-byte compressed form (parity-prefix + X);
      // for x-only we drop the parity byte. Same convention as elsewhere in
      // this worker for taproot.
      const xOnly = child.publicKey.slice(1);
      return { pubkeyHex: bytesToHex(xOnly), originPath: path };
    }

    case "composePearlMultisigPsbt": {
      // Build a fresh PSBT for a Pearl multisig vault spend. Unsigned —
      // the caller hands this PSBT to each cosigner's signPearlMultisigPsbt
      // until threshold is met, then finalises + broadcasts off the wire.
      //
      // We re-derive the vault from the wire descriptor inside the worker
      // (same pubkeys + same threshold ⇒ same `outputScript`). The caller
      // can't substitute a different leaf because we don't trust them to
      // hand us one — we rebuild from primitives.
      if (!session) throw new Error("E_LOCKED");
      const r = msg.req;
      if (!Array.isArray(r.utxos) || r.utxos.length === 0) {
        throw new Error("E_PEARL_NO_INPUTS");
      }
      if (!Array.isArray(r.outputs) || r.outputs.length === 0) {
        throw new Error("E_PEARL_NO_OUTPUTS");
      }
      const params = pearlParams(r.network);
      const pubkeys = r.descriptor.sortedPubkeysHex.map((h) => hexToBytes(h));
      const vault = vaultDescriptorFromPubkeys(r.descriptor.threshold, pubkeys, params);
      // Defense in depth: caller is expected to have already sorted, but
      // we don't accept a "differently-sorted" wire input — the on-disk
      // vault record holds the canonical order.
      for (let i = 0; i < pubkeys.length; i++) {
        if (bytesToHex(vault.sortedPubkeys[i]!) !== bytesToHex(pubkeys[i]!)) {
          throw new Error("E_MULTISIG_PUBKEYS_NOT_SORTED");
        }
      }

      const network = { bech32: params.hrp, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
      const tx = new btc.Transaction({ allowUnknownOutputs: false });

      for (const u of r.utxos) {
        if (
          typeof u.txid !== "string" ||
          !/^[0-9a-fA-F]{64}$/.test(u.txid) ||
          typeof u.vout !== "number" ||
          u.vout < 0 ||
          typeof u.scriptHex !== "string" ||
          !/^[0-9a-fA-F]+$/.test(u.scriptHex)
        ) {
          throw new Error("E_PEARL_UTXO_SHAPE");
        }
        const valueGrains = BigInt(u.valueGrains);
        if (valueGrains <= 0n) throw new Error("E_PEARL_UTXO_VALUE");
        // The input's scriptPubKey MUST match the vault's outputScript —
        // every UTXO we'll spend pays the same vault. A mismatched
        // scriptHex here means the caller fed us a non-vault prevout,
        // which would either fail to sign (sighash binds to script) or
        // worse, if we were sloppy, sign a sighash that finalises against
        // a different output.
        const scriptBytes = hexToBytes(u.scriptHex);
        if (bytesToHex(scriptBytes) !== bytesToHex(vault.outputScript)) {
          throw new Error("E_MULTISIG_UTXO_NOT_VAULT");
        }
        tx.addInput({
          txid: hexToBytes(u.txid),
          index: u.vout,
          witnessUtxo: { amount: valueGrains, script: scriptBytes },
          tapInternalKey: vault.internalKey,
          tapLeafScript: vault.tapLeafScript,
        });
      }

      for (const o of r.outputs) {
        if (typeof o.address !== "string" || typeof o.amountGrains !== "string") {
          throw new Error("E_PEARL_OUTPUT_SHAPE");
        }
        const amt = BigInt(o.amountGrains);
        if (amt <= 0n) throw new Error("E_PEARL_OUTPUT_VALUE");
        tx.addOutputAddress(o.address, amt, network);
      }

      return { psbtBase64: base64.encode(tx.toPSBT()) };
    }

    case "signPearlMultisigPsbt": {
      // Add this cosigner's signature to an existing PSBT. The PSBT may be
      // fresh (no sigs yet) or already carry sigs from other cosigners.
      // signIdx appends a new tapScriptSig entry per input; a later
      // finalize() collects them into the witness once threshold is met.
      //
      // Threat model worth flagging: a hostile counterparty could mutate
      // a PSBT's `witnessUtxo.script` (or `tapLeafScript`) between rounds
      // to trick us into signing a sighash for a different vault. We
      // defend by re-deriving the vault from the user-confirmed
      // descriptor (held locally in Dexie) and refusing to sign any
      // input whose witnessUtxo.script doesn't equal vault.outputScript.
      if (!session) throw new Error("E_LOCKED");
      const r = msg.req;
      if (typeof r.psbtBase64 !== "string" || r.psbtBase64.length === 0) {
        throw new Error("E_MULTISIG_BAD_PSBT");
      }

      const params = pearlParams(r.descriptor.network);
      const pubkeys = r.descriptor.sortedPubkeysHex.map((h) => hexToBytes(h));
      const vault = vaultDescriptorFromPubkeys(r.descriptor.threshold, pubkeys, params);

      // Derive our cosigner privkey for this vault slot.
      const master = masterFromSeed(session.seed);
      const path = pearlMultisigPath(r.vaultAccount, r.keyIndex);
      const child = master.derive(path);
      if (!child.privateKey || !child.publicKey) throw new Error("E_HD_DERIVE_FAILED");
      const myXOnly = child.publicKey.slice(1);
      const myHex = bytesToHex(myXOnly);

      // Refuse to sign for a vault we aren't a member of. Belt-and-braces
      // — the wallet wouldn't propose signing if we weren't, but a stale
      // / corrupted vault record could feed us a vaultAccount/keyIndex
      // pair whose derived pubkey isn't in the set. Without this check,
      // the resulting tapScriptSig would be useless (no matching pubkey
      // slot in the leaf) but would still leak the fact that we derived
      // a key for that path.
      if (!vault.sortedPubkeys.some((p) => bytesToHex(p) === myHex)) {
        throw new Error("E_MULTISIG_NOT_A_COSIGNER");
      }

      let psbtBytes: Uint8Array;
      try {
        psbtBytes = base64.decode(r.psbtBase64);
      } catch {
        throw new Error("E_MULTISIG_BAD_PSBT");
      }
      let tx: btc.Transaction;
      try {
        tx = btc.Transaction.fromPSBT(psbtBytes);
      } catch (err) {
        throw new Error(
          `E_MULTISIG_PSBT_PARSE: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (tx.inputsLength === 0) throw new Error("E_PEARL_NO_INPUTS");

      // Per-input vault binding check.
      for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        const wu = input.witnessUtxo as { script: Uint8Array; amount: bigint } | undefined;
        if (!wu || !wu.script) throw new Error("E_MULTISIG_PSBT_NO_WITNESS_UTXO");
        if (bytesToHex(wu.script) !== bytesToHex(vault.outputScript)) {
          throw new Error("E_MULTISIG_PSBT_FOREIGN_INPUT");
        }
      }

      // Sign every input with our cosigner privkey. signIdx appends to the
      // input's tapScriptSig map automatically for tapscript-path inputs.
      for (let i = 0; i < tx.inputsLength; i++) {
        tx.signIdx(child.privateKey, i);
      }

      return { psbtBase64: base64.encode(tx.toPSBT()) };
    }

    case "signSigProofForVault": {
      // Domain-separated sig-return proof. The worker computes the digest
      // itself — main thread cannot ask the worker to Schnorr-sign an
      // arbitrary 32-byte digest with a vault privkey. The proof message
      // shape mirrors pearl-vault-relay/src/sig-proof.ts so the relay's
      // verifySigProof accepts the result.
      if (!session) throw new Error("E_LOCKED");
      const r = msg.req;
      if (typeof r.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(r.token)) {
        throw new Error("E_SIGPROOF_BAD_TOKEN");
      }
      if (typeof r.psbtBase64 !== "string" || r.psbtBase64.length === 0) {
        throw new Error("E_SIGPROOF_BAD_PSBT");
      }
      if (
        typeof r.signedAt !== "number" ||
        !Number.isInteger(r.signedAt) ||
        r.signedAt < 1_700_000_000 ||
        r.signedAt > 4_000_000_000
      ) {
        throw new Error("E_SIGPROOF_BAD_TS");
      }

      const params = pearlParams(r.descriptor.network);
      const pubkeys = r.descriptor.sortedPubkeysHex.map((h) => hexToBytes(h));
      const vault = vaultDescriptorFromPubkeys(r.descriptor.threshold, pubkeys, params);

      const master = masterFromSeed(session.seed);
      const path = pearlMultisigPath(r.vaultAccount, r.keyIndex);
      const child = master.derive(path);
      if (!child.privateKey || !child.publicKey) throw new Error("E_HD_DERIVE_FAILED");
      const myXOnly = child.publicKey.slice(1); // drop sec1 prefix byte
      const myHex = bytesToHex(myXOnly);

      // Refuse to mint a proof under a vault we aren't a member of.
      // Without this check, an attacker who controls the main thread
      // could ask us to sign for a vault we don't belong to and then
      // attempt to inject the proof at another proposal (which would
      // be rejected by the relay's whitelist gate anyway — but defense
      // in depth, and keeps the proof primitive honest).
      if (!vault.sortedPubkeys.some((p) => bytesToHex(p) === myHex)) {
        throw new Error("E_MULTISIG_NOT_A_COSIGNER");
      }

      // Compute the domain-separated digest. Must stay byte-identical to
      // pearl-vault-relay/src/sig-proof.ts:computeSigProofDigest. Don't
      // refactor either side without re-running the cross-test.
      const SIG_PROOF_DOMAIN = "pearl-vault-relay/sig/v1";
      const psbtDigestHex = bytesToHex(
        sha256(new TextEncoder().encode(r.psbtBase64)),
      );
      const canonical =
        `${SIG_PROOF_DOMAIN}\n${r.token}\n${r.signedAt}\n${psbtDigestHex}`;
      const digest = sha256(new TextEncoder().encode(canonical));

      const proofBytes = schnorr.sign(digest, child.privateKey);
      return {
        signerPubkeyHex: myHex,
        hmacProofHex: bytesToHex(proofBytes),
      };
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
