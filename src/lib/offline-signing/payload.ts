// Offline-signing wire format (v0.2.8 — experimental).
//
// The Armory-style flow has three actors:
//   * Watcher  — online wallet that knows current UTXOs but no private key
//   * Signer   — offline wallet that holds the private key
//   * Broadcaster — online wallet that pushes the signed tx
//
// They communicate by passing payloads between machines (QR or copy/paste).
// Payloads MUST be:
//   1. Versioned (so we can evolve the format without breaking old offline
//      signers that the user can no longer easily update — air-gapped boxes
//      are the whole point).
//   2. Self-describing (the signer should be able to render exactly what
//      the watcher built, so the user can verify before signing).
//   3. Free of any private material (signer NEVER puts a key into a payload).
//
// The envelope is plain JSON. We avoid CBOR/protobuf because:
//   * Debugging an offline-signing payload from a copy-paste is a real
//     scenario; JSON is grep-able.
//   * The bytes-on-the-wire cost is small relative to the QR animation
//     latency on a phone camera.
//
// The envelope is base64url-encoded for QR transport. Multi-frame chunking
// lives in qr-frames.ts — this module is JUST the schema + encode/decode.

export const PAYLOAD_VERSION = 1 as const;

export type PayloadKind =
  | "pearl-unsigned"
  | "pearl-signed"
  | "eth-unsigned"
  | "eth-signed";

// ── Pearl ────────────────────────────────────────────────────────────────

export interface PearlUnsignedPayload {
  v: 1;
  k: "pearl-unsigned";
  /** "mainnet" | "testnet" — must match the signer's loaded network. */
  network: "mainnet" | "testnet";
  utxos: Array<{
    txid: string;
    vout: number;
    /** Decimal string (grains). bigint-safe. */
    valueGrains: string;
    /** Hex P2TR scriptPubKey, lowercase. */
    scriptHex: string;
    /** Receive-pool index (0..gap-limit). Signer derives the matching key. */
    poolIndex: number;
  }>;
  outputs: Array<{
    address: string;
    /** Decimal string (grains). */
    amountGrains: string;
  }>;
  /** Optional context the signer can DISPLAY to the user, but must NOT
   *  trust as authoritative — the only authoritative values are
   *  utxos + outputs above. */
  meta?: {
    /** Watcher-side wall-clock — diagnostic only. */
    composedAt?: number;
    /** "Send X PRL to Y, change to Z, tip W" — pre-rendered summary. */
    summary?: string;
    /** Watcher's address pool snapshot, so the signer can sanity-check
     *  that the change address (output #N) belongs to the same wallet. */
    pool?: string[];
    /** Implied fee = sum(utxos.valueGrains) - sum(outputs.amountGrains). */
    feeGrains?: string;
    /** Tip recipient + amount (if any) — surfaced separately so the
     *  signer UI can flag it loudly. */
    tipAddress?: string;
    tipGrains?: string;
  };
}

export interface PearlSignedPayload {
  v: 1;
  k: "pearl-signed";
  network: "mainnet" | "testnet";
  /** Hex-encoded fully-signed transaction. */
  raw: string;
  /** Optional txid the signer pre-computed — broadcaster verifies. */
  txid?: string;
}

// ── Ethereum / WPRL ──────────────────────────────────────────────────────

export interface EthUnsignedPayload {
  v: 1;
  k: "eth-unsigned";
  chainId: number;
  nonce: number;
  to: string;
  /** Decimal string (wei). */
  value: string;
  /** Optional hex calldata; absent for a plain ETH transfer. */
  data?: string;
  /** Decimal strings (wei / gas). */
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  meta?: {
    composedAt?: number;
    summary?: string;
    /** Watcher's loaded eth address. Signer can verify a match before
     *  signing — refuse if the signer's eth address ≠ this. */
    from?: string;
  };
}

export interface EthSignedPayload {
  v: 1;
  k: "eth-signed";
  chainId: number;
  /** Hex 0x-prefixed serialized signed tx. */
  raw: string;
}

export type OfflinePayload =
  | PearlUnsignedPayload
  | PearlSignedPayload
  | EthUnsignedPayload
  | EthSignedPayload;

// ── Codec ────────────────────────────────────────────────────────────────

/** Base64url encode UTF-8 string. URL-safe alphabet, no padding. */
export function base64urlEncode(s: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Node fallback (tests).
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Base64url decode → UTF-8 string. */
export function base64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf-8");
}

/** Encode a payload → base64url-encoded JSON string. */
export function encodePayload(p: OfflinePayload): string {
  return base64urlEncode(JSON.stringify(p));
}

/** Decode a base64url-encoded JSON string → typed payload.
 *
 *  Throws on any structural problem (not-JSON, wrong version, missing
 *  required fields, wrong types). Validation is strict because the signer
 *  is going to feed the result to the crypto worker, and the worker's
 *  rejection messages are not useful to end users — better to surface a
 *  clear "this isn't a valid offline-signing payload" than a downstream
 *  hex-parse error. */
export function decodePayload(s: string): OfflinePayload {
  let json: unknown;
  try {
    json = JSON.parse(base64urlDecode(s.trim()));
  } catch {
    throw new Error("E_PAYLOAD_DECODE: not a valid offline-signing payload");
  }
  return validatePayload(json);
}

/** Validate an already-parsed object → typed payload. Exported so the
 *  test suite (and any future raw-JSON ingress) can reuse the rules. */
export function validatePayload(json: unknown): OfflinePayload {
  if (!json || typeof json !== "object") {
    throw new Error("E_PAYLOAD_SHAPE: payload must be an object");
  }
  const o = json as Record<string, unknown>;
  if (o.v !== PAYLOAD_VERSION) {
    throw new Error(`E_PAYLOAD_VERSION: expected v=${PAYLOAD_VERSION}, got v=${String(o.v)}`);
  }
  switch (o.k) {
    case "pearl-unsigned":
      return validatePearlUnsigned(o);
    case "pearl-signed":
      return validatePearlSigned(o);
    case "eth-unsigned":
      return validateEthUnsigned(o);
    case "eth-signed":
      return validateEthSigned(o);
    default:
      throw new Error(`E_PAYLOAD_KIND: unknown kind ${String(o.k)}`);
  }
}

function isStr(x: unknown): x is string {
  return typeof x === "string";
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

function isDecimalStr(x: unknown): x is string {
  return typeof x === "string" && /^[0-9]+$/.test(x);
}

function isHexStr(x: unknown): x is string {
  return typeof x === "string" && /^[0-9a-f]*$/i.test(x) && x.length % 2 === 0;
}

function isPrefixedHex(x: unknown): x is string {
  return typeof x === "string" && /^0x[0-9a-f]*$/i.test(x) && (x.length - 2) % 2 === 0;
}

function isNetwork(x: unknown): x is "mainnet" | "testnet" {
  return x === "mainnet" || x === "testnet";
}

function validatePearlUnsigned(o: Record<string, unknown>): PearlUnsignedPayload {
  if (!isNetwork(o.network)) throw new Error("E_PAYLOAD_FIELD: network");
  if (!Array.isArray(o.utxos) || o.utxos.length === 0) {
    throw new Error("E_PAYLOAD_FIELD: utxos must be a non-empty array");
  }
  const utxos = o.utxos.map((u, i) => {
    if (!u || typeof u !== "object") throw new Error(`E_PAYLOAD_FIELD: utxos[${i}]`);
    const x = u as Record<string, unknown>;
    if (!isStr(x.txid) || !/^[0-9a-f]{64}$/i.test(x.txid)) {
      throw new Error(`E_PAYLOAD_FIELD: utxos[${i}].txid`);
    }
    if (!isInt(x.vout) || x.vout < 0) throw new Error(`E_PAYLOAD_FIELD: utxos[${i}].vout`);
    if (!isDecimalStr(x.valueGrains)) {
      throw new Error(`E_PAYLOAD_FIELD: utxos[${i}].valueGrains`);
    }
    if (!isHexStr(x.scriptHex)) {
      throw new Error(`E_PAYLOAD_FIELD: utxos[${i}].scriptHex`);
    }
    if (!isInt(x.poolIndex) || x.poolIndex < 0) {
      throw new Error(`E_PAYLOAD_FIELD: utxos[${i}].poolIndex`);
    }
    return {
      txid: x.txid.toLowerCase(),
      vout: x.vout,
      valueGrains: x.valueGrains,
      scriptHex: x.scriptHex.toLowerCase(),
      poolIndex: x.poolIndex,
    };
  });
  if (!Array.isArray(o.outputs) || o.outputs.length === 0) {
    throw new Error("E_PAYLOAD_FIELD: outputs must be a non-empty array");
  }
  const outputs = o.outputs.map((u, i) => {
    if (!u || typeof u !== "object") throw new Error(`E_PAYLOAD_FIELD: outputs[${i}]`);
    const x = u as Record<string, unknown>;
    if (!isStr(x.address) || x.address.length === 0) {
      throw new Error(`E_PAYLOAD_FIELD: outputs[${i}].address`);
    }
    if (!isDecimalStr(x.amountGrains)) {
      throw new Error(`E_PAYLOAD_FIELD: outputs[${i}].amountGrains`);
    }
    return { address: x.address, amountGrains: x.amountGrains };
  });
  const result: PearlUnsignedPayload = {
    v: 1,
    k: "pearl-unsigned",
    network: o.network,
    utxos,
    outputs,
  };
  if (o.meta && typeof o.meta === "object") {
    const m = o.meta as Record<string, unknown>;
    const meta: NonNullable<PearlUnsignedPayload["meta"]> = {};
    if (typeof m.composedAt === "number") meta.composedAt = m.composedAt;
    if (typeof m.summary === "string") meta.summary = m.summary;
    if (Array.isArray(m.pool) && m.pool.every(isStr)) meta.pool = m.pool as string[];
    if (isDecimalStr(m.feeGrains)) meta.feeGrains = m.feeGrains;
    if (typeof m.tipAddress === "string") meta.tipAddress = m.tipAddress;
    if (isDecimalStr(m.tipGrains)) meta.tipGrains = m.tipGrains;
    result.meta = meta;
  }
  return result;
}

function validatePearlSigned(o: Record<string, unknown>): PearlSignedPayload {
  if (!isNetwork(o.network)) throw new Error("E_PAYLOAD_FIELD: network");
  if (!isHexStr(o.raw) || o.raw.length === 0) throw new Error("E_PAYLOAD_FIELD: raw");
  const r: PearlSignedPayload = {
    v: 1,
    k: "pearl-signed",
    network: o.network,
    raw: o.raw.toLowerCase(),
  };
  if (typeof o.txid === "string" && /^[0-9a-f]{64}$/i.test(o.txid)) {
    r.txid = o.txid.toLowerCase();
  }
  return r;
}

function validateEthUnsigned(o: Record<string, unknown>): EthUnsignedPayload {
  if (!isInt(o.chainId) || o.chainId <= 0) throw new Error("E_PAYLOAD_FIELD: chainId");
  if (!isInt(o.nonce) || o.nonce < 0) throw new Error("E_PAYLOAD_FIELD: nonce");
  if (!isPrefixedHex(o.to) || (o.to.length - 2) !== 40) {
    throw new Error("E_PAYLOAD_FIELD: to");
  }
  if (!isDecimalStr(o.value)) throw new Error("E_PAYLOAD_FIELD: value");
  if (!isDecimalStr(o.gas)) throw new Error("E_PAYLOAD_FIELD: gas");
  if (!isDecimalStr(o.maxFeePerGas)) throw new Error("E_PAYLOAD_FIELD: maxFeePerGas");
  if (!isDecimalStr(o.maxPriorityFeePerGas)) {
    throw new Error("E_PAYLOAD_FIELD: maxPriorityFeePerGas");
  }
  if (o.data !== undefined && !isPrefixedHex(o.data)) {
    throw new Error("E_PAYLOAD_FIELD: data");
  }
  const r: EthUnsignedPayload = {
    v: 1,
    k: "eth-unsigned",
    chainId: o.chainId,
    nonce: o.nonce,
    to: o.to.toLowerCase(),
    value: o.value,
    gas: o.gas,
    maxFeePerGas: o.maxFeePerGas,
    maxPriorityFeePerGas: o.maxPriorityFeePerGas,
  };
  if (o.data !== undefined) r.data = (o.data as string).toLowerCase();
  if (o.meta && typeof o.meta === "object") {
    const m = o.meta as Record<string, unknown>;
    const meta: NonNullable<EthUnsignedPayload["meta"]> = {};
    if (typeof m.composedAt === "number") meta.composedAt = m.composedAt;
    if (typeof m.summary === "string") meta.summary = m.summary;
    if (typeof m.from === "string") meta.from = (m.from as string).toLowerCase();
    r.meta = meta;
  }
  return r;
}

function validateEthSigned(o: Record<string, unknown>): EthSignedPayload {
  if (!isInt(o.chainId) || o.chainId <= 0) throw new Error("E_PAYLOAD_FIELD: chainId");
  if (!isPrefixedHex(o.raw) || o.raw.length === 0) {
    throw new Error("E_PAYLOAD_FIELD: raw");
  }
  return {
    v: 1,
    k: "eth-signed",
    chainId: o.chainId,
    raw: o.raw.toLowerCase(),
  };
}
