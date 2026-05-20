// Pubkey descriptor format for multisig cosigner exchange.
//
// When a user adds a cosigner to a Pearl vault they need to hand the
// other side a single self-describing payload that says "I am
// cosigner X for vault Y; here is my x-only pubkey at BIP-86 path Z."
// This module is the canonical shape of that payload — JSON serialise +
// parse + validate.
//
// We intentionally keep the format flat and human-readable:
// - JSON, not binary, so a copy-paste survives email / Signal / chat
//   without base64-mangle hazards.
// - x-only pubkey carried as lowercase hex, 64 chars (32 bytes).
// - originPath carried verbatim so the receiver knows where to look
//   in their own wallet if they want to verify their share.
// - `network` carried explicitly so a mainnet descriptor never silently
//   loads into a hypothetical future testnet vault.
//
// Format version is `1`. Future breaking changes will bump it and the
// parser will refuse mismatched versions rather than guess.

export interface PearlMultisigPubkeyDescriptor {
  version: 1;
  type: "pearl-multisig-pubkey";
  network: "mainnet";
  /** 64 lowercase hex chars = 32 bytes. */
  xOnlyPubkey: string;
  /** BIP-86 path the pubkey came from (e.g. `m/86'/808276'/100'/0'/0`). */
  originPath: string;
  /** User-supplied label. Trimmed; ≤ 64 chars. */
  label: string;
}

const HEX_RE = /^[0-9a-f]{64}$/;
const PATH_RE = /^m(\/\d+'?)+$/;
// BIP-86-style paths in Pearl multisig are 5 levels deep
// (m/86'/808276'/100'/account'/index). Cap at 12 levels + 128 chars to
// reject pathological inputs without rejecting any legitimate variant.
// (audit pass 4, L2)
const PATH_MAX_LEN = 128;
const PATH_MAX_DEPTH = 12;
function isValidOriginPath(s: string): boolean {
  if (s.length > PATH_MAX_LEN) return false;
  if (!PATH_RE.test(s)) return false;
  // depth = number of '/' separators
  let depth = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 47 /* '/' */) depth++;
  return depth <= PATH_MAX_DEPTH;
}

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const byte of b) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!HEX_RE.test(hex)) throw new Error("E_DESCRIPTOR_BAD_HEX");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

export function encodePubkeyDescriptor(d: {
  xOnlyPubkey: Uint8Array;
  originPath: string;
  label: string;
  network?: "mainnet";
}): string {
  if (d.xOnlyPubkey.length !== 32) throw new Error("E_DESCRIPTOR_BAD_PUBKEY_LEN");
  if (!isValidOriginPath(d.originPath)) throw new Error("E_DESCRIPTOR_BAD_PATH");
  const label = d.label.trim();
  if (label.length === 0 || label.length > 64) throw new Error("E_DESCRIPTOR_BAD_LABEL");
  const obj: PearlMultisigPubkeyDescriptor = {
    version: 1,
    type: "pearl-multisig-pubkey",
    network: d.network ?? "mainnet",
    xOnlyPubkey: bytesToHex(d.xOnlyPubkey),
    originPath: d.originPath,
    label,
  };
  // Two-space pretty-print — descriptors are read by humans before they
  // are read by the import code path. The bytes-on-wire cost is trivial.
  return JSON.stringify(obj, null, 2);
}

/**
 * Strict parse: returns the descriptor + its decoded pubkey, throws on
 * any shape / type / range violation. We never accept a partial parse —
 * the cost of a silently-truncated descriptor is funding the wrong
 * vault.
 */
export function parsePubkeyDescriptor(json: string): {
  descriptor: PearlMultisigPubkeyDescriptor;
  xOnlyPubkey: Uint8Array;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("E_DESCRIPTOR_BAD_JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("E_DESCRIPTOR_BAD_SHAPE");
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new Error("E_DESCRIPTOR_BAD_VERSION");
  if (o.type !== "pearl-multisig-pubkey") throw new Error("E_DESCRIPTOR_BAD_TYPE");
  if (o.network !== "mainnet") throw new Error("E_DESCRIPTOR_BAD_NETWORK");
  if (typeof o.xOnlyPubkey !== "string") throw new Error("E_DESCRIPTOR_BAD_PUBKEY");
  if (typeof o.originPath !== "string" || !isValidOriginPath(o.originPath)) {
    throw new Error("E_DESCRIPTOR_BAD_PATH");
  }
  if (typeof o.label !== "string") throw new Error("E_DESCRIPTOR_BAD_LABEL");
  const labelTrim = o.label.trim();
  if (labelTrim.length === 0 || labelTrim.length > 64) {
    throw new Error("E_DESCRIPTOR_BAD_LABEL");
  }
  const xOnlyPubkey = hexToBytes(o.xOnlyPubkey);
  return {
    descriptor: {
      version: 1,
      type: "pearl-multisig-pubkey",
      network: "mainnet",
      xOnlyPubkey: o.xOnlyPubkey,
      originPath: o.originPath,
      label: labelTrim,
    },
    xOnlyPubkey,
  };
}
