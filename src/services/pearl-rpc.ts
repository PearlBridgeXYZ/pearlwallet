// Thin JSON-RPC client for the Pearl sentry endpoint. Only methods
// the public sentry allowlist exposes are used (see
// docs/SENTRY-RPC-REQUIREMENTS.md). PRL balance is computed by
// walking searchrawtransactions and folding inputs/outputs into a
// UTXO set keyed by `${txid}:${vout}`.

import { PEARL_RPC_POOL, pearlParams } from "../chains/pearl/network";
import { useUI } from "../state/ui-store";

interface RpcResult<T> {
  jsonrpc?: string;
  result: T | null;
  error: { code: number; message: string } | null;
  id: number | string | null;
}

interface RawTxVout {
  value: number; // PRL as float — converted via toFixed(8) to avoid IEEE drift
  n: number;
  scriptPubKey: {
    address?: string;
    addresses?: string[];
    // Raw scriptPubKey bytes as hex. btcd-derived sentries include this.
    // The signer needs it as the witnessUtxo.script of every input
    // (taproot signing binds the prevout script into the sighash).
    hex?: string;
  };
}

interface RawTxVin {
  txid?: string; // absent on coinbase
  vout?: number;
}

interface RawTx {
  txid: string;
  vin: RawTxVin[];
  vout: RawTxVout[];
  confirmations?: number;
}

// v0.2.5: per-endpoint failure tracking. An endpoint that just returned a
// 5xx / network error / DNS failure is parked for COOLDOWN_MS so the
// rotation skips it on the next call rather than re-burning the same
// timeout. Module-scope so a single tab's open requests share the health
// view — across-tab coordination isn't needed since each tab's traffic
// pattern is independent and the cooldowns are short.
const ENDPOINT_COOLDOWN_MS = 60_000;
const endpointUnhealthyUntil = new Map<string, number>();

// Test hook: reset module state. Not exported in production type — keep
// the surface area small.
export function _resetPearlRpcHealthForTests(): void {
  endpointUnhealthyUntil.clear();
}

function isEndpointHealthy(url: string, now: number): boolean {
  const until = endpointUnhealthyUntil.get(url) ?? 0;
  return now >= until;
}

function markEndpointUnhealthy(url: string, now: number): void {
  endpointUnhealthyUntil.set(url, now + ENDPOINT_COOLDOWN_MS);
}

/**
 * Returns the candidate endpoint list, in priority order, for a single
 * call(). When an override is set it is tried FIRST (user-explicit choice
 * wins), then the pool falls through in declared order. The override URL
 * is also re-validated against the allowlist; if it doesn't validate we
 * silently skip it and fall back to the pool — defense in depth against
 * a tampered localStorage that bypassed the setter's check.
 */
function candidateEndpoints(): string[] {
  const override = useUI.getState().pearlRpcOverride.trim();
  const resolvedOverride = override ? pearlParams("mainnet", override).rpcUrl : "";
  // pearlParams returns the canonical default when the override fails
  // validation, so a literally-equal-to-default override is a no-op.
  const overrideIsCustom = !!override && resolvedOverride !== PEARL_RPC_POOL[0];
  const seen = new Set<string>();
  const out: string[] = [];
  if (overrideIsCustom) {
    out.push(resolvedOverride);
    seen.add(resolvedOverride);
  }
  for (const url of PEARL_RPC_POOL) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Returns the endpoint that should be tried first this call. Healthy
 * candidates win over cooled-down ones; if every endpoint is currently
 * cooled down we still try them (in priority order) because the cooldown
 * is a soft signal — better to take a chance on a maybe-recovered host
 * than refuse the user's request outright.
 */
function orderedAttempts(candidates: string[], now: number): string[] {
  const healthy: string[] = [];
  const cooled: string[] = [];
  for (const url of candidates) {
    if (isEndpointHealthy(url, now)) healthy.push(url);
    else cooled.push(url);
  }
  return healthy.length > 0 ? [...healthy, ...cooled] : cooled;
}

/**
 * Classifies an error/response as "rotate to next endpoint" vs "this
 * endpoint is fine, the request itself is wrong." 5xx, network errors
 * (TypeError on fetch), DNS failures, and aborts are transient. 4xx
 * (other than 408/429) is a hard error — the next endpoint will likely
 * respond identically because the request is malformed/disallowed.
 *
 * The `body.error` returned for valid JSON-RPC errors (e.g. -5 "No
 * information about address") is NOT rotation-worthy — that's the chain
 * speaking, not the endpoint failing.
 */
function isTransientHttpStatus(status: number): boolean {
  if (status >= 500 && status < 600) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

async function call<T>(method: string, params: unknown[]): Promise<T> {
  // v0.2.5: rotate across the sentry pool. Each endpoint gets one shot
  // per call(); transient failures move us to the next endpoint rather
  // than re-spinning the same one. A retry-on-same-endpoint approach
  // (the v0.1.x design) burns wall-clock against a degraded sentry while
  // a healthy peer sits idle. Rotation amortises the failure across the
  // pool and surfaces the chain-state error (`body.error`) without
  // wrapping it in a "rpc exhausted retries" the caller can't unwind.
  const now = Date.now();
  const attempts = orderedAttempts(candidateEndpoints(), now);
  let lastErr: unknown;
  for (const url of attempts) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
      if (!res.ok) {
        lastErr = new Error(`rpc http ${res.status}`);
        if (isTransientHttpStatus(res.status)) {
          markEndpointUnhealthy(url, Date.now());
          continue;
        }
        // 4xx other than 408/429 — request is malformed/disallowed.
        // Rotating won't help; surface the error directly.
        throw lastErr;
      }
      const body = (await res.json()) as RpcResult<T>;
      if (body.error) {
        // Chain-level JSON-RPC error (e.g. -5 zero-activity address).
        // The endpoint is fine — the chain just doesn't have the data.
        // Caller catches and decides; do NOT mark the endpoint unhealthy.
        throw new Error(`rpc ${body.error.code}: ${body.error.message}`);
      }
      if (body.result === null) throw new Error("rpc null result");
      return body.result;
    } catch (err) {
      // fetch() rejects with TypeError on DNS failure, network error,
      // CORS rejection, certificate failure, etc. All transient from
      // the wallet's perspective — try the next endpoint.
      if (err instanceof TypeError) {
        lastErr = err;
        markEndpointUnhealthy(url, Date.now());
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("rpc pool exhausted");
}

// PRL float → grains. Round via toFixed(8) string to dodge float drift.
// A malicious or buggy sentry could send NaN/Infinity (toFixed throws),
// or a negative value (would poison the running total in the pool walk).
// Reject those at the boundary so a single bad vout can't crash a 20-
// address walk or under-report balance.
function prlToGrains(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("E_INVALID_RPC_VALUE");
  }
  const [whole, frac = ""] = value.toFixed(8).split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole) * 100_000_000n + BigInt(fracPadded);
}

function voutPaysAddress(vout: RawTxVout, address: string): boolean {
  if (vout.scriptPubKey.address === address) return true;
  return Array.isArray(vout.scriptPubKey.addresses) &&
    vout.scriptPubKey.addresses.includes(address);
}

// Hard cap on pagination depth. A hostile or buggy sentry that returns
// `page.length === PAGE` on every request (looping cursor, dummy data,
// reorg replay) would otherwise spin the tab indefinitely — 100% CPU,
// memory growth, no observable error. 20 pages × 100 = 2000 txs is
// already more activity than any reasonable retail wallet sees, and
// well past the point where we should stop trusting the RPC anyway.
export const MAX_UTXO_WALK_PAGES = 20;

// Per-page item cap. A sentry that returns 50k entries in a single page
// (intentional flood, JSON-RPC misconfig) would blow the worker heap
// even before we hit MAX_UTXO_WALK_PAGES. Hard-reject anything 5×
// the requested page size — that's a server bug, not a tx history.
export const MAX_RPC_PAGE_LENGTH = 500;

export interface PrlBalanceResult {
  grains: bigint;
  // `true` when the walk hit MAX_UTXO_WALK_PAGES / MAX_RPC_PAGE_LENGTH
  // before exhausting the address history. The returned grain total is
  // a best-effort partial sum; the caller should surface a "partial"
  // label so the user doesn't act on under-reported funds.
  degraded: boolean;
}

/**
 * Returns the confirmed + mempool balance (in grains) for `address`,
 * by walking searchrawtransactions in pages and tracking a UTXO set.
 *
 * The per-page walk runs in TWO passes (vouts first, vins second).
 * A hostile sentry could otherwise order vins before their funding
 * vouts on the same page — the vin delete would no-op against an
 * uncredited UTXO and the later vout credit would survive, leaving
 * a spent UTXO in the running total. Two-pass guarantees every vin
 * sees the page's full vout set before deleting.
 *
 * On hitting the pagination/page-length caps we return `degraded:true`
 * instead of throwing. A throw caused a single hostile-sentry-tarpitted
 * address to flip the entire pool walk to `error` (failures >= 1 was
 * enough on a 20-address pool where most other addresses returned
 * empty), masking real funds. v0.1.7 audit (opus1 M-3 + minimax cross).
 */
export async function fetchPrlBalanceGrains(address: string): Promise<PrlBalanceResult> {
  const PAGE = 100;
  let skip = 0;
  const utxo = new Map<string, bigint>();
  // Some sentry paginators have been observed to re-emit a tx across
  // page boundaries during a reorg, or skip-then-replay during cursor
  // drift. Deduping outputs by `${txid}:${vout}` across the whole walk
  // — not just within a page — prevents double-counting a UTXO that we
  // already credited in an earlier page.
  const seenOutputs = new Set<string>();
  let pageCount = 0;
  let degraded = false;

  while (true) {
    if (pageCount >= MAX_UTXO_WALK_PAGES) {
      degraded = true;
      break;
    }
    let page: RawTx[];
    try {
      page = await call<RawTx[]>("searchrawtransactions", [address, 1, skip, PAGE]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Zero-activity addresses come back as -5; treat as empty wallet.
      if (msg.includes("No information available about address")) {
        return { grains: 0n, degraded: false };
      }
      throw err;
    }
    if (!page || page.length === 0) break;
    if (page.length > MAX_RPC_PAGE_LENGTH) {
      // Server returned a flood. Don't iterate further — that page
      // alone is already past the policy ceiling — but still process
      // up to the cap so we surface a partial total rather than 0.
      degraded = true;
      page = page.slice(0, MAX_RPC_PAGE_LENGTH);
    }

    // Pass 1: credit every vout that pays this address.
    for (const tx of page) {
      for (const vout of tx.vout) {
        if (!voutPaysAddress(vout, address)) continue;
        const key = `${tx.txid}:${vout.n}`;
        if (seenOutputs.has(key)) continue;
        seenOutputs.add(key);
        utxo.set(key, prlToGrains(vout.value));
      }
    }
    // Pass 2: debit every vin's referenced output. After pass 1, any
    // funding vout that appears later in the same page is already in
    // `utxo`, so the delete is correct.
    for (const tx of page) {
      for (const vin of tx.vin) {
        if (!vin.txid || vin.vout === undefined) continue;
        utxo.delete(`${vin.txid}:${vin.vout}`);
      }
    }

    pageCount++;
    if (degraded) break;
    if (page.length < PAGE) break;
    skip += page.length;
  }

  let total = 0n;
  for (const amt of utxo.values()) total += amt;
  return { grains: total, degraded };
}

export interface PrlUtxo {
  txid: string;
  vout: number;
  valueGrains: bigint;
  scriptHex: string;
}

export interface PrlUtxoSet {
  utxos: PrlUtxo[];
  degraded: boolean;
}

/**
 * Like fetchPrlBalanceGrains but returns the full UTXO set instead of a
 * grain sum — needed by the send flow so the signer knows which prev-
 * outs to consume and bind into the taproot sighash. Same two-pass
 * walk, same MAX_UTXO_WALK_PAGES / MAX_RPC_PAGE_LENGTH guards, same
 * degraded fallback. Returns `degraded:true` rather than throwing on
 * cap-hit so a hostile sentry can't deny the user spending capability
 * — they'll spend what they can prove instead of nothing.
 *
 * Any vout missing scriptPubKey.hex is silently dropped: the signer
 * can't bind it into the sighash without the script, and sending a
 * tx with a fabricated scriptPubKey would simply be rejected by the
 * mempool. Visible-balance numbers diverging from spendable-utxo
 * numbers is the safer failure mode (user notices, sentry is asked
 * for full data) than silently broadcasting an invalid tx.
 */
export async function fetchPrlUtxos(address: string): Promise<PrlUtxoSet> {
  const PAGE = 100;
  let skip = 0;
  type Held = { valueGrains: bigint; scriptHex: string };
  const utxo = new Map<string, Held>();
  const seenOutputs = new Set<string>();
  let pageCount = 0;
  let degraded = false;

  while (true) {
    if (pageCount >= MAX_UTXO_WALK_PAGES) {
      degraded = true;
      break;
    }
    let page: RawTx[];
    try {
      page = await call<RawTx[]>("searchrawtransactions", [address, 1, skip, PAGE]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No information available about address")) {
        return { utxos: [], degraded: false };
      }
      throw err;
    }
    if (!page || page.length === 0) break;
    if (page.length > MAX_RPC_PAGE_LENGTH) {
      degraded = true;
      page = page.slice(0, MAX_RPC_PAGE_LENGTH);
    }

    for (const tx of page) {
      for (const vout of tx.vout) {
        if (!voutPaysAddress(vout, address)) continue;
        const key = `${tx.txid}:${vout.n}`;
        if (seenOutputs.has(key)) continue;
        seenOutputs.add(key);
        const scriptHex = vout.scriptPubKey.hex;
        if (!scriptHex || !/^[0-9a-fA-F]+$/.test(scriptHex)) continue;
        utxo.set(key, { valueGrains: prlToGrains(vout.value), scriptHex });
      }
    }
    for (const tx of page) {
      for (const vin of tx.vin) {
        if (!vin.txid || vin.vout === undefined) continue;
        utxo.delete(`${vin.txid}:${vin.vout}`);
      }
    }

    pageCount++;
    if (degraded) break;
    if (page.length < PAGE) break;
    skip += page.length;
  }

  const out: PrlUtxo[] = [];
  for (const [key, held] of utxo) {
    const [txid, voutStr] = key.split(":");
    out.push({
      txid: txid!,
      vout: Number(voutStr),
      valueGrains: held.valueGrains,
      scriptHex: held.scriptHex,
    });
  }
  return { utxos: out, degraded };
}

/** Broadcasts a signed raw transaction. Returns the txid on success. */
export async function broadcastPearlTx(rawHex: string): Promise<string> {
  return await call<string>("sendrawtransaction", [rawHex]);
}
