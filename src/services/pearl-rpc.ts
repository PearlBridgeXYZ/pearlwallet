// Thin JSON-RPC client for the Pearl sentry endpoint. Only methods
// the public sentry allowlist exposes are used (see
// docs/SENTRY-RPC-REQUIREMENTS.md). PRL balance is computed by
// walking searchrawtransactions and folding inputs/outputs into a
// UTXO set keyed by `${txid}:${vout}`.

import * as btc from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils";
import { PEARL_RPC_POOL, pearlParams } from "../chains/pearl/network";
import { useUI } from "../state/ui-store";
import { TokenBucket, sleep, type RpcPriority } from "./rpc-limiter";
import { onBalanceMemoryClear } from "../state/balance-memory";

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

export interface RawTx {
  txid: string;
  vin: RawTxVin[];
  vout: RawTxVout[];
  confirmations?: number;
  time?: number;
  blocktime?: number;
}

// v0.2.5: per-endpoint failure tracking. An endpoint whose backoff budget
// was exhausted is parked for COOLDOWN_MS so the rotation tries healthy
// candidates first on the next call. Module-scope so a single tab's open
// requests share the health view.
const ENDPOINT_COOLDOWN_MS = 60_000;
const endpointUnhealthyUntil = new Map<string, number>();

// ─── Transport tuning ─────────────────────────────────────────────────────
// v0.7: one shared pacing + backoff policy for every Pearl RPC request.
// Origin limit, measured live 2026-10-07 with fixed-rate request trains
// after a 60 s idle: 1 req/s x30 → all 200; 1.5 req/s → first 503 at
// request 31; 2 req/s → first 503 at request 21, then every other request
// (i.e. exactly 1 req/s gets through). That is nginx limit_req with
// rate ≈ 1 r/s and burst ≈ 10 per client; an earlier "~4 req/s" reading
// was the burst being spent, not the sustained rate. 503s carry no
// Retry-After. We stay under it — 0.9 req/s, burst 8 — applied to EVERY
// request including consecutive pages of one address walk.
export interface PearlRpcTuning {
  /** Token-bucket refill rate shared by all Pearl RPC requests. */
  ratePerSec: number;
  /** Token-bucket capacity. */
  burst: number;
  /** First backoff delay after a transient failure; doubles each retry. */
  backoffBaseMs: number;
  /** Largest single backoff delay (also caps an honoured Retry-After). */
  backoffMaxMs: number;
  /** Retries per endpoint after the first attempt (0.5,1,2,4,8 s = 5). */
  maxRetries: number;
  /** Wall-clock budget per request per endpoint, including backoff. */
  retryBudgetMs: number;
  /** Per-attempt fetch timeout for read calls. */
  requestTimeoutMs: number;
  /** Per-attempt fetch timeout for sendrawtransaction. Generous on
   *  purpose; a timeout here is reported as "status unknown", never as
   *  a failure. */
  broadcastTimeoutMs: number;
  /** Retry budget for sendrawtransaction (longer than reads so one
   *  timed-out attempt can still be followed by an idempotent retry). */
  broadcastRetryBudgetMs: number;
  /** Addresses walked in parallel by a pool scan. The token bucket still
   *  bounds the aggregate request rate. */
  scanConcurrency: number;
}

const MIN_ATTEMPT_TIMEOUT_MS = 3_000;

export const DEFAULT_PEARL_RPC_TUNING: Readonly<PearlRpcTuning> = Object.freeze({
  ratePerSec: 0.9,
  burst: 8,
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
  maxRetries: 5,
  retryBudgetMs: 20_000,
  requestTimeoutMs: 12_000,
  broadcastTimeoutMs: 20_000,
  broadcastRetryBudgetMs: 30_000,
  scanConcurrency: 3,
});

let tuning: PearlRpcTuning = { ...DEFAULT_PEARL_RPC_TUNING };
let limiter = new TokenBucket({ ratePerSec: tuning.ratePerSec, burst: tuning.burst });

/** Current transport tuning (read-only copy). */
export function pearlRpcTuning(): Readonly<PearlRpcTuning> {
  return tuning;
}

/** Test hook: override tuning (and rebuild the shared limiter). Passing
 *  no argument restores production defaults. */
export function _setPearlRpcTuningForTests(patch?: Partial<PearlRpcTuning>): void {
  tuning = patch ? { ...tuning, ...patch } : { ...DEFAULT_PEARL_RPC_TUNING };
  limiter = new TokenBucket({ ratePerSec: tuning.ratePerSec, burst: tuning.burst });
}

/** The module-level limiter every Pearl RPC request draws from. */
export function pearlRpcLimiter(): TokenBucket {
  return limiter;
}

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
 * Classifies an error/response as "back off and retry" vs "this endpoint
 * is fine, the request itself is wrong." 5xx, 408, 429, network errors
 * (TypeError on fetch) and client timeouts are transient. Other 4xx are
 * hard errors — retrying a malformed/disallowed request won't help.
 *
 * The `body.error` returned for valid JSON-RPC errors (e.g. -5 "No
 * information about address") is NOT retry-worthy — that's the chain
 * speaking, not the endpoint failing.
 */
function isTransientHttpStatus(status: number): boolean {
  if (status >= 500 && status < 600) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

/** Transport-level HTTP failure. Carries the status and any Retry-After
 *  hint (ms) so the backoff loop can honour it. */
export class PearlRpcHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    /** True when the response is the reverse proxy's own rate-limit page
     *  (nginx limit_req answers 503 with its stock error page): the
     *  request was refused at the edge and never forwarded to the node. */
    readonly edgeLimited: boolean = false,
  ) {
    super(`rpc http ${status}`);
    this.name = "PearlRpcHttpError";
  }
}

/** A 2xx response whose body is not a usable JSON-RPC answer (invalid or
 *  truncated JSON, not an object, null result). The request DID reach a
 *  server that answered "OK" — for a broadcast the outcome is unknown,
 *  never a plain failure. */
export class PearlRpcMalformedResponseError extends Error {
  constructor(readonly detail: string) {
    super(detail === "null result" ? "rpc null result" : `rpc malformed response: ${detail}`);
    this.name = "PearlRpcMalformedResponseError";
  }
}

// nginx's stock 503 page ("503 Service Temporarily Unavailable" … "nginx"),
// which is what limit_req returns. An upstream (node) 503 is proxied with
// the node's own body and does not match.
const NGINX_LIMIT_PAGE_TITLE_RE = /<title>\s*503 Service Temporarily Unavailable\s*<\/title>/i;
const NGINX_SIGNATURE_RE = /<center>\s*nginx(\/[0-9.]+)?\s*<\/center>/i;

/** True when `body` is nginx's own 503 error page (edge rate limit). */
export function isEdgeRateLimitPage(body: string): boolean {
  return NGINX_LIMIT_PAGE_TITLE_RE.test(body) && NGINX_SIGNATURE_RE.test(body);
}

/** Largest error body we read to classify a 503. */
const MAX_ERROR_BODY_CHARS = 4_096;

/** The client gave up waiting for a response. The request may still have
 *  reached the node — callers that are not idempotent must treat this as
 *  "outcome unknown". */
export class PearlRpcTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`rpc timeout after ${timeoutMs}ms`);
    this.name = "PearlRpcTimeoutError";
  }
}

/** Parses a Retry-After header (delta-seconds or HTTP date) into ms. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * One transport attempt against a single endpoint. Returns the parsed
 * result on success; throws on any failure. Caller decides whether to
 * back off and retry, rotate, or surface to the user.
 *
 * Classification of throws:
 *   • `TypeError` — fetch() rejected (DNS, CORS, TLS, partition). Transient.
 *   • `PearlRpcTimeoutError` — no answer within the timeout. Transient.
 *   • `PearlRpcHttpError` 5xx / 408 / 429 — endpoint speaking, ill. Transient.
 *   • `PearlRpcHttpError` (other 4xx) — request malformed/disallowed. Hard.
 *   • `Error("rpc N: msg")` — chain-level JSON-RPC error. Hard (endpoint is fine).
 *   • `PearlRpcMalformedResponseError` — 2xx with an unusable body
 *     (invalid/truncated JSON, null result). Hard for reads; a broadcast
 *     treats it as "status unknown".
 */
async function fetchOnce<T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (timedOut) throw new PearlRpcTimeoutError(timeoutMs);
      if (signal?.aborted) throw err;
      // Normalise every other fetch rejection to TypeError (transient).
      throw err instanceof TypeError ? err : new TypeError(String((err as Error)?.message ?? err));
    }
    if (!res.ok) {
      let edgeLimited = false;
      if (res.status === 503) {
        try {
          edgeLimited = isEdgeRateLimitPage((await res.text()).slice(0, MAX_ERROR_BODY_CHARS));
        } catch {
          /* unreadable body: not identifiable, stay conservative */
        }
      }
      throw new PearlRpcHttpError(res.status, parseRetryAfterMs(res.headers.get("retry-after")), edgeLimited);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (timedOut) throw new PearlRpcTimeoutError(timeoutMs);
      if (signal?.aborted) throw err;
      throw new PearlRpcMalformedResponseError("unreadable body");
    }
    let body: RpcResult<T>;
    try {
      body = JSON.parse(text) as RpcResult<T>;
    } catch {
      throw new PearlRpcMalformedResponseError("invalid JSON");
    }
    if (!body || typeof body !== "object") throw new PearlRpcMalformedResponseError("not an object");
    if (body.error) {
      // Chain-level error (-5 zero-activity, -32601 method-not-found).
      // Endpoint is fine; surface directly so caller can swallow as needed.
      throw new Error(`rpc ${body.error.code}: ${body.error.message}`);
    }
    if (body.result === null || body.result === undefined) throw new PearlRpcMalformedResponseError("null result");
    return body.result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** True if the error means "this same endpoint might still work — retry." */
function isRetryableSameEndpoint(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof PearlRpcTimeoutError) return true;
  if (err instanceof PearlRpcHttpError) return isTransientHttpStatus(err.status);
  return false;
}

/** True if the error is a JSON-RPC body error — never rotate, never retry. */
function isChainLevelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // `rpc <signed-int>: <message>` is the chain's voice. `rpc http <code>`
  // and `rpc null result` are transport voices.
  return /^rpc -?\d+:/.test(err.message);
}

/** Exponential backoff with jitter: base·2^n scaled by a random factor in
 *  [0.5, 1.0], capped at backoffMaxMs. A Retry-After hint wins when
 *  present (still capped). */
function backoffDelayMs(retryIndex: number, err: unknown): number {
  if (err instanceof PearlRpcHttpError && err.retryAfterMs !== null) {
    return Math.min(err.retryAfterMs, tuning.backoffMaxMs);
  }
  const raw = Math.min(tuning.backoffBaseMs * 2 ** retryIndex, tuning.backoffMaxMs);
  return Math.round(raw * (0.5 + Math.random() * 0.5));
}

export interface PearlCallOptions {
  /** Token-bucket lane. Activity uses "low" so balance/Send go first. */
  priority?: RpcPriority;
  /** Per-attempt timeout; defaults to tuning.requestTimeoutMs. */
  timeoutMs?: number;
  /** Per-endpoint retry budget; defaults to tuning.retryBudgetMs. */
  retryBudgetMs?: number;
  /** Cancels waiting/backoff/in-flight fetch. */
  signal?: AbortSignal;
  /** Observer for every attempt outcome (broadcast uses it to decide
   *  whether an earlier attempt may have reached the node). */
  onAttemptError?: (err: unknown) => void;
}

/**
 * Shared JSON-RPC call used by every Pearl RPC consumer (balance walk,
 * activity scan, Send, broadcast).
 *
 *   1. Every attempt first takes a token from the shared limiter.
 *   2. Transient failures (5xx/408/429/network/timeout) back off
 *      exponentially with jitter (≈0.5,1,2,4,8 s, honouring Retry-After)
 *      and retry the SAME request on the same endpoint, up to maxRetries
 *      or retryBudgetMs, whichever comes first.
 *   3. Only once that budget is exhausted is the endpoint marked unhealthy
 *      and the next candidate (override → pool) tried.
 *   4. Chain-level errors and hard 4xx surface immediately.
 */
export async function callPearlRpc<T>(
  method: string,
  params: unknown[],
  opts: PearlCallOptions = {},
): Promise<T> {
  const priority = opts.priority ?? "high";
  const timeoutMs = opts.timeoutMs ?? tuning.requestTimeoutMs;
  const budgetMs = opts.retryBudgetMs ?? tuning.retryBudgetMs;
  const attempts = orderedAttempts(candidateEndpoints(), Date.now());
  let lastErr: unknown;
  for (const url of attempts) {
    // Budget = time spent in attempts + backoff sleeps. Time queued in the
    // limiter is NOT counted: a low-priority request that waited behind a
    // balance scan still gets its full retry allowance.
    let spent = 0;
    for (let attempt = 0; ; attempt++) {
      await limiter.take(priority, opts.signal);
      // A retry never runs past the budget: its timeout shrinks to what
      // is left (floor MIN_ATTEMPT_TIMEOUT_MS so it can still succeed).
      const attemptTimeout = attempt === 0
        ? timeoutMs
        : Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(timeoutMs, budgetMs - spent));
      const attemptStart = Date.now();
      try {
        return await fetchOnce<T>(url, method, params, attemptTimeout, opts.signal);
      } catch (err) {
        spent += Date.now() - attemptStart;
        lastErr = err;
        if (opts.signal?.aborted) throw err;
        opts.onAttemptError?.(err);
        // Chain answered (endpoint healthy) or the request itself is
        // wrong: surface without parking the endpoint.
        if (isChainLevelError(err) || !isRetryableSameEndpoint(err)) throw err;
        if (attempt >= tuning.maxRetries) break;
        const delay = backoffDelayMs(attempt, err);
        if (spent + delay > budgetMs) break;
        await sleep(delay, opts.signal);
        spent += delay;
      }
    }
    markEndpointUnhealthy(url, Date.now());
  }
  throw lastErr ?? new Error("rpc pool exhausted");
}

async function call<T>(method: string, params: unknown[], opts?: PearlCallOptions): Promise<T> {
  return callPearlRpc<T>(method, params, opts);
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

// ─── Complete-history cache (activity reuse) ───────────────────────────
// When a balance walk sees an address's ENTIRE history in its first page
// (or the address has no history at all), keep those raw txs briefly so
// the activity scan can classify them without asking the RPC again. With
// the origin at ~1 req/s this roughly halves dashboard RPC traffic for a
// typical wallet. Display-only consumer; never used for coin selection.
export interface AddressHistory {
  txs: readonly RawTx[];
  at: number;
}
const historyCache = new Map<string, AddressHistory>();
const HISTORY_CACHE_MAX = 200;

function rememberCompleteHistory(address: string, txs: RawTx[]): void {
  if (historyCache.size >= HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value;
    if (oldest !== undefined) historyCache.delete(oldest);
  }
  historyCache.delete(address);
  historyCache.set(address, { txs, at: Date.now() });
}

/** Complete raw history of `address` captured by a recent balance walk,
 *  or undefined if none is fresher than `maxAgeMs`. */
export function getFreshAddressHistory(address: string, maxAgeMs: number): AddressHistory | undefined {
  const h = historyCache.get(address);
  if (!h || Date.now() - h.at > maxAgeMs) return undefined;
  return h;
}

/** Drops every cached address history (lock / wipe / wallet switch). */
export function clearAddressHistory(): void {
  historyCache.clear();
}
onBalanceMemoryClear(clearAddressHistory);

/** Test hook. */
export function _clearAddressHistoryForTests(): void {
  historyCache.clear();
}

/** Test hook: number of cached address histories. */
export function _addressHistorySizeForTests(): number {
  return historyCache.size;
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
  /** True when the address has ANY transaction history (spent or not).
   *  Address discovery uses this as "used" for the BIP-44 gap limit; an
   *  address the node reports as "No information available" (-5) or with
   *  an empty first page is unused. */
  used: boolean;
}

export interface FetchUtxosOptions {
  /** Override the default walk depth. Clamped to MAX_UTXO_WALK_PAGES_HARD.
   *  Use this when a previous walk came back `degraded:true` and the
   *  caller wants to dig deeper before throwing E_INSUFFICIENT_FUNDS. */
  maxPages?: number;
  /** Token-bucket lane for this walk's requests (default "high"). */
  priority?: RpcPriority;
  /** Cancels the walk between/within pages. */
  signal?: AbortSignal;
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
      // A transient failure (503/429/timeout) on this page is retried
      // with backoff INSIDE call(), so the walk resumes at the same
      // `skip` with everything gathered so far intact — one busy page no
      // longer throws away the whole address.
      page = await call<RawTx[]>("searchrawtransactions", [address, 1, skip, PAGE], {
        priority: opts.priority,
        signal: opts.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No information available about address")) {
        if (pageCount === 0) {
          rememberCompleteHistory(address, []);
          return { utxos: [], degraded: false, droppedNoScript: 0, used: false };
        }
        // -5 after earlier non-empty pages: history ended exactly at a
        // page boundary. Keep what the walk already gathered.
        break;
      }
      throw err;
    }
    if (!page || page.length === 0) {
      if (pageCount === 0) rememberCompleteHistory(address, []);
      break;
    }
    if (pageCount === 0 && page.length < PAGE && page.length <= MAX_RPC_PAGE_LENGTH) {
      rememberCompleteHistory(address, page);
    }
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
  return { utxos: out, degraded, droppedNoScript, used: pageCount > 0 };
}

/**
 * Thrown when a broadcast's outcome cannot be determined: the request may
 * or may not have reached the node (timeout, dropped connection, gateway
 * error after send). The UI must NOT present this as a failure — the tx
 * may be in the mempool. Re-broadcasting the same raw tx is safe (the node
 * answers "already have transaction", which we treat as success).
 */
export class BroadcastStatusUnknownError extends Error {
  readonly code = "E_BROADCAST_STATUS_UNKNOWN" as const;
  constructor(
    readonly txid: string | null,
    readonly cause: unknown,
  ) {
    super(
      `E_BROADCAST_STATUS_UNKNOWN: broadcast status unknown — check the explorer` +
        (txid ? ` for txid ${txid}` : "") +
        ` before retrying`,
    );
    this.name = "BroadcastStatusUnknownError";
  }
}

// btcd: "already have transaction <id>" (mempool) / "transaction already
// exists" (mined). Core-style nodes: "txn-already-in-mempool",
// "txn-already-known", "transaction already in block chain".
const ALREADY_KNOWN_RE =
  /already have transaction|transaction already exists|txn-already-(in-mempool|known)|already in (the )?(mempool|block ?chain)/i;

/** True when a sendrawtransaction rejection means the node already holds
 *  this exact transaction — i.e. the broadcast effectively succeeded. */
export function isAlreadyKnownBroadcastError(err: unknown): boolean {
  return err instanceof Error && /^rpc -?\d+:/.test(err.message) && ALREADY_KNOWN_RE.test(err.message);
}

function parseRawTx(rawHex: string): btc.Transaction | null {
  try {
    return btc.Transaction.fromRaw(hexToBytes(rawHex), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
      disableScriptCheck: true,
    });
  } catch {
    return null;
  }
}

/** Local txid of a raw tx (non-witness double-SHA256), or null if it
 *  can't be parsed. Used to report "already known" as success and to
 *  give the user an explorer handle when the outcome is unknown. */
export function rawTxId(rawHex: string): string | null {
  const tx = parseRawTx(rawHex);
  if (!tx) return null;
  try {
    return tx.id;
  } catch {
    return null;
  }
}

/** Outpoints a raw tx spends, or null if it can't be parsed. */
export function rawTxInputs(rawHex: string): { txid: string; vout: number }[] | null {
  const tx = parseRawTx(rawHex);
  if (!tx || tx.inputsLength === 0) return null;
  const out: { txid: string; vout: number }[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (!inp.txid || inp.index === undefined) return null;
    let hex = "";
    for (const b of inp.txid) hex += b.toString(16).padStart(2, "0");
    out.push({ txid: hex, vout: inp.index });
  }
  return out;
}

export type PearlTxProbe = "found" | "absent" | "unknown";

// btcd: "No information available about transaction"; Core-style: "No such
// mempool or blockchain transaction". Both are code -5.
const NO_TX_INFO_RE = /^rpc -5:.*(no information available about transaction|no such mempool (or blockchain )?transaction)/i;

/**
 * Asks the node whether it holds `txid` (mempool or chain) via
 * getrawtransaction. "found" only when the returned raw tx really hashes
 * to `txid`; "absent" only on the node's explicit "no such transaction";
 * anything else (transport failure, odd answer) is "unknown".
 */
export async function probePearlTx(txid: string | null, opts: { signal?: AbortSignal } = {}): Promise<PearlTxProbe> {
  if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) return "unknown";
  const want = txid.toLowerCase();
  try {
    const raw = await call<unknown>("getrawtransaction", [want, 0], {
      priority: "high",
      signal: opts.signal,
    });
    if (typeof raw === "string" && /^[0-9a-f]+$/i.test(raw) && rawTxId(raw) === want) return "found";
    return "unknown";
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (err instanceof Error && NO_TX_INFO_RE.test(err.message)) return "absent";
    return "unknown";
  }
}

/**
 * Broadcasts a signed raw transaction. Returns the txid on success.
 *
 * Broadcast is idempotent (same raw tx ⇒ same txid; the node answers
 * "already have transaction" for a duplicate), so transient failures are
 * retried with the shared backoff. Outcome rules:
 *   • node returns txid                         → success
 *   • node says it already has this transaction → success (local txid)
 *   • node rejects on the FIRST contact          → failure (thrown as-is)
 *   • node rejects AFTER an earlier attempt that may have reached it →
 *     the local txid is probed (getrawtransaction): found → success,
 *     absent → the rejection stands (plain failure), else
 *     BroadcastStatusUnknownError
 *   • 2xx with an unusable body (invalid/truncated JSON, null result) →
 *     probed: found → success, else BroadcastStatusUnknownError
 *   • every attempt failed transiently (and at least one may have been
 *     delivered)                                 → BroadcastStatusUnknownError
 *   • only edge refusals (429, nginx rate-limit 503 page; never
 *     forwarded)                                 → failure
 * A client timeout is never reported as a plain failure.
 */
export async function broadcastPearlTx(rawHex: string): Promise<string> {
  const localTxid = rawTxId(rawHex);
  let maybeReachedNode = false;
  try {
    return await call<string>("sendrawtransaction", [rawHex], {
      priority: "high",
      timeoutMs: tuning.broadcastTimeoutMs,
      retryBudgetMs: tuning.broadcastRetryBudgetMs,
      onAttemptError: (err) => {
        // 429 and the edge's own rate-limit page mean the request was
        // refused before forwarding. Everything else transient (timeout,
        // network drop, other 5xx) may have been delivered.
        if (err instanceof PearlRpcHttpError && (err.status === 429 || err.edgeLimited)) return;
        if (isRetryableSameEndpoint(err) || err instanceof PearlRpcMalformedResponseError) maybeReachedNode = true;
      },
    });
  } catch (err) {
    if (isAlreadyKnownBroadcastError(err)) {
      if (localTxid) return localTxid;
      throw new BroadcastStatusUnknownError(null, err);
    }
    if (err instanceof PearlRpcMalformedResponseError) {
      // A server answered 2xx: the node may well have accepted the tx.
      if ((await probePearlTx(localTxid)) === "found") return localTxid!;
      throw new BroadcastStatusUnknownError(localTxid, err);
    }
    if (isChainLevelError(err) || (err instanceof PearlRpcHttpError && !isTransientHttpStatus(err.status))) {
      // Definitive rejection. If an earlier attempt may already have
      // delivered the tx, the rejection could be about our own tx (e.g.
      // inputs now spent by it): ask the node whether it holds the tx.
      if (!maybeReachedNode) throw err;
      const probe = await probePearlTx(localTxid);
      if (probe === "found") return localTxid!;
      if (probe === "absent") throw err;
      throw new BroadcastStatusUnknownError(localTxid, err);
    }
    // Transport never produced a definitive answer. If no attempt can
    // have been delivered (only edge refusals), it is a plain failure.
    if (!maybeReachedNode) throw err;
    throw new BroadcastStatusUnknownError(localTxid, err);
  }
}
