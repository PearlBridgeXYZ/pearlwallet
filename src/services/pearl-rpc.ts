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

// v0.2.6: per-endpoint attempt count. A single 5xx burst on the primary
// used to immediately rotate to the next pool entry — fine in theory, but
// until the fleet sentries are provisioned the "next entry" is NXDOMAIN
// and the user just sees "Pearl RPC unreachable." Re-introduce a bounded
// intra-endpoint retry (the v0.1.x shape, with the v0.2.5 rotation
// wrapped around it) so a transient one-off failure on the live primary
// doesn't cascade to the dead pool entries.
const PER_ENDPOINT_ATTEMPTS = 2;
const INTRA_ENDPOINT_BACKOFF_MS = 250;

/**
 * One transport attempt against a single endpoint. Returns the parsed
 * result on success; throws on any failure. Caller decides whether to
 * retry (same endpoint), rotate (next endpoint), or surface to the user.
 *
 * Classification of throws:
 *   • `TypeError` — fetch() rejected (DNS, CORS, TLS, partition). Transient.
 *   • `Error("rpc http 5xx")` / 408 / 429 — endpoint speaking, ill. Transient.
 *   • `Error("rpc http 4xx")` (other) — request malformed/disallowed. Hard.
 *   • `Error("rpc N: msg")` — chain-level JSON-RPC error. Hard (endpoint is fine).
 *   • `Error("rpc null result")` — protocol violation. Hard.
 */
async function fetchOnce<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) {
    throw new Error(`rpc http ${res.status}`);
  }
  const body = (await res.json()) as RpcResult<T>;
  if (body.error) {
    // Chain-level error (-5 zero-activity, -32601 method-not-found).
    // Endpoint is fine; surface directly so caller can swallow as needed.
    throw new Error(`rpc ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === null) throw new Error("rpc null result");
  return body.result;
}

/** True if the error means "this same endpoint might still work — retry." */
function isRetryableSameEndpoint(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    const m = /^rpc http (\d+)$/.exec(err.message);
    if (m) return isTransientHttpStatus(Number(m[1]));
  }
  return false;
}

/** True if the error is a JSON-RPC body error — never rotate, never retry. */
function isChainLevelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // `rpc <signed-int>: <message>` is the chain's voice. `rpc http <code>`
  // and `rpc null result` are transport voices.
  return /^rpc -?\d+:/.test(err.message);
}

async function call<T>(method: string, params: unknown[]): Promise<T> {
  // v0.2.5 + v0.2.6: layered failure strategy.
  //   1. Intra-endpoint: each endpoint gets PER_ENDPOINT_ATTEMPTS shots
  //      with INTRA_ENDPOINT_BACKOFF_MS between them. A one-off 503 on a
  //      healthy primary recovers without rotating.
  //   2. Inter-endpoint: if all attempts on an endpoint fail transiently,
  //      mark it unhealthy and rotate to the next.
  //   3. Pool-exhausted: throw the last error so the caller can surface
  //      "RPC unreachable" — only after every endpoint × every attempt
  //      failed transiently.
  // Chain-level errors (`rpc -5: ...`) and hard 4xx short-circuit out
  // immediately — rotating won't change the chain's answer, and a
  // malformed request won't suddenly be valid on the next endpoint.
  const now = Date.now();
  const attempts = orderedAttempts(candidateEndpoints(), now);
  let lastErr: unknown;
  for (const url of attempts) {
    let endpointFailedAllAttempts = true;
    for (let attempt = 0; attempt < PER_ENDPOINT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, INTRA_ENDPOINT_BACKOFF_MS));
      }
      try {
        return await fetchOnce<T>(url, method, params);
      } catch (err) {
        lastErr = err;
        if (isChainLevelError(err)) {
          // The chain answered with an RPC error — endpoint is healthy,
          // request is well-formed, the data just doesn't exist (or the
          // method is gone). Surface to caller; do NOT mark unhealthy.
          throw err;
        }
        if (isRetryableSameEndpoint(err)) {
          // Try the same endpoint once more after a short backoff.
          continue;
        }
        // Non-retryable transport error (e.g. 4xx-other). Mark unhealthy
        // is too punitive — the request is the problem, not the host —
        // so just surface directly without parking the endpoint.
        endpointFailedAllAttempts = false;
        throw err;
      }
    }
    if (endpointFailedAllAttempts) {
      markEndpointUnhealthy(url, Date.now());
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

// Default pagination depth. A hostile or buggy sentry that returns
// `page.length === PAGE` on every request (looping cursor, dummy data,
// reorg replay) would otherwise spin the tab indefinitely — 100% CPU,
// memory growth, no observable error.
//
// v0.3.1: raised from 20 → 60. The old 2000-tx ceiling was masking
// spendable funds on high-activity wallets — balance walks would
// degrade and Send would throw E_INSUFFICIENT_FUNDS even though the
// chain held more coins than the cap-truncated walk found. Callers
// that *need* to go deeper (e.g. a Send retry after E_INSUFFICIENT_FUNDS
// on a degraded walk) can pass a higher `maxPages` to ratchet up to
// MAX_UTXO_WALK_PAGES_HARD before we genuinely give up.
export const MAX_UTXO_WALK_PAGES = 60;

// Hard ceiling. Callers passing larger maxPages are clamped here.
// 200 pages × 100 = 20,000 txs per address. At 20 addresses in the
// pool that's 400k txs — beyond which we refuse to spin further to
// keep the tab responsive even on a hostile-sentry tarpit. A retail
// wallet hitting this number genuinely needs a desktop client.
export const MAX_UTXO_WALK_PAGES_HARD = 200;

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
 * Returns the confirmed + mempool balance (in grains) for `address`.
 *
 * v0.3.1: now a thin wrapper around fetchPrlUtxos so balance and spend
 * walks can never diverge. Previously balance walked one way and Send
 * walked another; a sentry returning some vouts without scriptPubKey.hex
 * (which Send can't sign against) would inflate the displayed balance
 * over what was actually spendable, producing the mysterious "500k PRL
 * displayed but Send says insufficient" failure mode.
 *
 * `degraded` here means either the walk hit the page cap OR at least
 * one vout was dropped for missing scriptHex. Both are signals that
 * the displayed total is a lower bound on the chain's real balance.
 */
export async function fetchPrlBalanceGrains(
  address: string,
  opts: FetchUtxosOptions = {},
): Promise<PrlBalanceResult> {
  const { utxos, degraded, droppedNoScript } = await fetchPrlUtxos(address, opts);
  let total = 0n;
  for (const u of utxos) total += u.valueGrains;
  return { grains: total, degraded: degraded || droppedNoScript > 0 };
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
  /** Number of vouts dropped because scriptPubKey.hex was missing/invalid.
   *  When nonzero the visible chain balance exceeds spendable — the UI
   *  surfaces it so a "500k displayed but Send says insufficient" gap
   *  becomes legible instead of mysterious. */
  droppedNoScript: number;
}

export interface FetchUtxosOptions {
  /** Override the default walk depth. Clamped to MAX_UTXO_WALK_PAGES_HARD.
   *  Use this when a previous walk came back `degraded:true` and the
   *  caller wants to dig deeper before throwing E_INSUFFICIENT_FUNDS. */
  maxPages?: number;
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
export async function fetchPrlUtxos(
  address: string,
  opts: FetchUtxosOptions = {},
): Promise<PrlUtxoSet> {
  const PAGE = 100;
  const maxPages = Math.min(
    Math.max(1, opts.maxPages ?? MAX_UTXO_WALK_PAGES),
    MAX_UTXO_WALK_PAGES_HARD,
  );
  let skip = 0;
  type Held = { valueGrains: bigint; scriptHex: string };
  const utxo = new Map<string, Held>();
  const seenOutputs = new Set<string>();
  let pageCount = 0;
  let degraded = false;
  let droppedNoScript = 0;

  while (true) {
    if (pageCount >= maxPages) {
      degraded = true;
      break;
    }
    let page: RawTx[];
    try {
      page = await call<RawTx[]>("searchrawtransactions", [address, 1, skip, PAGE]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No information available about address")) {
        return { utxos: [], degraded: false, droppedNoScript: 0 };
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
        if (!scriptHex || !/^[0-9a-fA-F]+$/.test(scriptHex)) {
          droppedNoScript++;
          continue;
        }
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
  return { utxos: out, degraded, droppedNoScript };
}

/** Broadcasts a signed raw transaction. Returns the txid on success. */
export async function broadcastPearlTx(rawHex: string): Promise<string> {
  return await call<string>("sendrawtransaction", [rawHex]);
}
