// Manual UTXO entry — for the fully-offline composer flow.
//
// When a user has no live UTXO data (truly air-gapped composer) they
// still need to be able to BUILD an unsigned transaction the offline
// signer will accept. We let them paste a list of UTXOs they have on
// hand — copied from a block explorer printout, an earlier watcher
// snapshot, a manually-kept ledger, etc.
//
// The input format is one UTXO per line, colon-separated. Two shapes:
//
//   txid:vout:amountGrains:poolIndex
//   txid:vout:amountGrains:poolIndex:scriptHex
//
// The poolIndex names which wallet address held this coin (so the signer
// knows which key to use): a bare index `i` is the external (receive)
// branch, `1/i` is the internal (change) branch, `0/i` is explicit
// external. The scriptHex is optional — when
// omitted, the UI fills it in from the wallet's known pool scripts.
// (This module is pure parsing; the UI does the script lookup before
// handing the result to the payload encoder.)
//
// We accept whitespace and blank lines between entries. Comments
// starting with `#` are dropped. This makes the pasted list survive
// trips through chat clients, plain text editors, and paper.

import { formatGrains } from "../format";

export interface ParsedManualUtxo {
  txid: string;
  vout: number;
  /** Decimal string (grains). */
  valueGrains: string;
  poolIndex: number;
  /** HD branch; absent = 0 (external). */
  branch?: 0 | 1;
  /** Optional — UI fills in if missing. */
  scriptHex?: string;
}

/** Highest accepted manual index (exclusive) — the discovery cap. */
export const MANUAL_MAX_INDEX = 1000;

export interface ManualUtxoError {
  /** 1-based line number of the offending row (matches the user's editor). */
  line: number;
  message: string;
}

export interface ManualUtxoParseResult {
  utxos: ParsedManualUtxo[];
  errors: ManualUtxoError[];
}

/** Parse one block of manually-entered UTXO text. Returns both
 *  successful entries and per-line errors so the UI can highlight
 *  problems without blocking valid rows. */
export function parseManualUtxos(raw: string): ManualUtxoParseResult {
  const utxos: ParsedManualUtxo[] = [];
  const errors: ManualUtxoError[] = [];
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const stripped = lines[i]!.replace(/#.*$/, "").trim();
    if (stripped === "") continue;
    const parts = stripped.split(":").map((s) => s.trim());
    if (parts.length < 4 || parts.length > 5) {
      errors.push({
        line: lineNum,
        message: "expected 4 or 5 colon-separated fields (txid:vout:amount:poolIndex[:scriptHex])",
      });
      continue;
    }
    const [txidRaw, voutRaw, amountRaw, poolRaw, scriptRaw] = parts;
    const txid = txidRaw!.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      errors.push({ line: lineNum, message: "txid must be 64 lowercase hex chars" });
      continue;
    }
    const vout = Number.parseInt(voutRaw!, 10);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) {
      errors.push({ line: lineNum, message: "vout must be a non-negative integer ≤ 65535" });
      continue;
    }
    if (!/^[0-9]+$/.test(amountRaw!)) {
      errors.push({ line: lineNum, message: "amount must be a non-negative integer (grains)" });
      continue;
    }
    if (amountRaw === "0") {
      errors.push({ line: lineNum, message: "amount must be > 0 — a zero-value UTXO is a footgun" });
      continue;
    }
    const idxMatch = /^(?:([01])\/)?([0-9]{1,4})$/.exec(poolRaw!);
    const poolIndex = idxMatch ? Number.parseInt(idxMatch[2]!, 10) : NaN;
    if (!idxMatch || !Number.isInteger(poolIndex) || poolIndex < 0 || poolIndex >= MANUAL_MAX_INDEX) {
      errors.push({
        line: lineNum,
        message: `poolIndex must be 0..${MANUAL_MAX_INDEX - 1}, optionally prefixed 0/ (receive) or 1/ (change)`,
      });
      continue;
    }
    const branch: 0 | 1 = idxMatch[1] === "1" ? 1 : 0;
    let scriptHex: string | undefined;
    if (scriptRaw !== undefined && scriptRaw !== "") {
      const s = scriptRaw.toLowerCase();
      if (!/^[0-9a-f]+$/.test(s) || s.length % 2 !== 0) {
        errors.push({ line: lineNum, message: "scriptHex must be even-length lowercase hex" });
        continue;
      }
      // P2TR scriptPubKey is exactly 34 bytes (OP_1 + 32-byte x-only key).
      // Match the signer’s currently supported P2TR-only policy.
      if (!/^5120[0-9a-f]{64}$/.test(s)) { errors.push({line:lineNum,message:"scriptHex must be a P2TR script: 68 hex characters starting 5120"}); continue; }
      scriptHex = s;
    }
    const key = `${txid}:${vout}`;
    if (seen.has(key)) {
      errors.push({ line: lineNum, message: `duplicate ${key}` });
      continue;
    }
    seen.add(key);
    const entry: ParsedManualUtxo = {
      txid,
      vout,
      valueGrains: amountRaw!,
      poolIndex,
    };
    if (branch === 1) entry.branch = 1;
    if (scriptHex !== undefined) entry.scriptHex = scriptHex;
    utxos.push(entry);
  }
  return { utxos, errors };
}

/** Sum the values of a parsed UTXO list. Returns a bigint. */
export function sumManualUtxoValue(utxos: ParsedManualUtxo[]): bigint {
  let s = 0n;
  for (const u of utxos) s += BigInt(u.valueGrains);
  return s;
}

/** Amounts of a manually composed spend: the fee actually paid and the
 *  change output (0n = no change output). */
export interface ManualSpendPlan {
  feeGrains: bigint;
  changeGrains: bigint;
}

/**
 * Validates and plans the outputs of a manually composed spend, with the
 * same rules as Send (composePearlSend):
 *   - a destination amount at or below `dustLimitGrains` is refused (the
 *     network won't relay it);
 *   - the fee input is a whole number of grains (digits only; empty = 0);
 *   - change below the dust limit is not created: it is paid to miners as
 *     part of the fee, so inputs = outputs + fee holds exactly.
 * Throws an Error with a readable message on any refusal.
 */
export function planManualSpend(p: {
  totalInGrains: bigint;
  amountGrains: bigint;
  feeInput: string;
  dustLimitGrains: bigint;
}): ManualSpendPlan {
  if (p.amountGrains <= p.dustLimitGrains) {
    throw new Error(
      `Amount is too small: the network won't relay a payment of ${formatGrains(p.dustLimitGrains)} PRL or less.`,
    );
  }
  const feeText = p.feeInput.trim();
  if (feeText !== "" && !/^\d+$/.test(feeText)) {
    throw new Error("Fee must be a whole number of grains");
  }
  const fee = BigInt(feeText || "0");
  const change = p.totalInGrains - p.amountGrains - fee;
  if (change < 0n) {
    throw new Error(
      `Insufficient: inputs ${formatGrains(p.totalInGrains)} PRL, need ${formatGrains(p.amountGrains)} + fee ${formatGrains(fee)}`,
    );
  }
  if (change < p.dustLimitGrains) return { feeGrains: fee + change, changeGrains: 0n };
  return { feeGrains: fee, changeGrains: change };
}

/** Derive the P2TR scriptPubKey for a Pearl bech32m address. Used to
 *  fill in the `scriptHex` field for manual UTXOs when the user omitted
 *  it (we know which pool address goes with which poolIndex, so we know
 *  the script).
 *
 *  This is a thin wrapper kept here so the offline-signing module owns
 *  the dependency edge — the UI calls into ONE place for "give me the
 *  script for this address" rather than reaching into chains/pearl. */
export function p2trScriptHexForAddress(
  address: string,
  bech32mDecode: (addr: string) => { prefix: string; words: number[] },
  fromWords: (words: number[]) => Uint8Array,
): string {
  const decoded = bech32mDecode(address);
  // Pearl addresses are bech32m with witness program v0 (taproot witness
  // version is the FIRST word, separately from the bytes). Strip the
  // version word then decode the rest.
  if (decoded.words.length < 2) {
    throw new Error("E_BAD_ADDRESS");
  }
  const witnessVer = decoded.words[0]!;
  if (witnessVer !== 1) {
    throw new Error("E_NOT_P2TR");
  }
  const programBytes = fromWords(decoded.words.slice(1));
  if (programBytes.length !== 32) {
    throw new Error("E_BAD_PROGRAM_LEN");
  }
  // OP_1 (0x51) + push-32 (0x20) + 32-byte x-only key.
  let hex = "5120";
  for (let i = 0; i < programBytes.length; i++) {
    hex += programBytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
