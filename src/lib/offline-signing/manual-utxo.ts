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
// The poolIndex names which receive-pool address held this coin (so the
// signer knows which key to use). The scriptHex is optional — when
// omitted, the UI fills it in from the wallet's known pool scripts.
// (This module is pure parsing; the UI does the script lookup before
// handing the result to the payload encoder.)
//
// We accept whitespace and blank lines between entries. Comments
// starting with `#` are dropped. This makes the pasted list survive
// trips through chat clients, plain text editors, and paper.

export interface ParsedManualUtxo {
  txid: string;
  vout: number;
  /** Decimal string (grains). */
  valueGrains: string;
  poolIndex: number;
  /** Optional — UI fills in if missing. */
  scriptHex?: string;
}

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
    const poolIndex = Number.parseInt(poolRaw!, 10);
    if (!Number.isInteger(poolIndex) || poolIndex < 0 || poolIndex > 99) {
      errors.push({ line: lineNum, message: "poolIndex must be 0..99" });
      continue;
    }
    let scriptHex: string | undefined;
    if (scriptRaw !== undefined && scriptRaw !== "") {
      const s = scriptRaw.toLowerCase();
      if (!/^[0-9a-f]+$/.test(s) || s.length % 2 !== 0) {
        errors.push({ line: lineNum, message: "scriptHex must be even-length lowercase hex" });
        continue;
      }
      // P2TR scriptPubKey is exactly 34 bytes (OP_1 + 32-byte x-only key).
      // We don't HARD-require this — a future witness version could differ —
      // but warn-soft via the result; right now nothing checks it.
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
