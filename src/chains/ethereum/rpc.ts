import { createPublicClient, http, fallback, HttpRequestError } from "viem";
import { ethChain, ETH_RPC_DEFAULTS, type EthNetwork } from "./network";
import { useUI, isAllowedEthRpcOverride } from "../../state/ui-store";

/**
 * Public ETH client. If a user-configured ETH RPC override is set in the
 * UI store, the override is preferred as the primary transport and the
 * built-in primary becomes the first fallback (with drpc still the
 * second). The override URL is allowlist-validated at the store
 * boundary, but we re-check here as a defence-in-depth: a future
 * persistence-shape regression must not silently turn into "user RPC
 * override points at attacker-controlled host".
 */
/** Per-request timeout for every Ethereum JSON-RPC call. */
export const ETH_RPC_TIMEOUT_MS = 10_000;

/**
 * Optional per-client cancellation. Only the activity scan passes one
 * (tests/v07-activity-eth-cancel.test.ts pins that); every value-path
 * caller constructs the same transport without the cancellation hook.
 */
export interface EthClientOptions {
  /** Once aborted, no NEW JSON-RPC request leaves this client (viem's own
   *  retries and fallback hops included). A request already in flight
   *  completes or times out; the caller discards its result. */
  signal?: AbortSignal;
  /** Sees every fetch this client makes (each retry and fallback hop):
   *  `request` before it leaves, `response` when an HTTP response arrives
   *  (a timeout or network error produces no `response` call). Only
   *  services/eth-tx.ts broadcastRaw passes one, to tell whether ANY
   *  eth_sendRawTransaction attempt failed ambiguously. Must not throw. */
  observe?: {
    request: (req: Request) => void;
    response: (res: Response) => Promise<void> | void;
  };
  /** One attempt per URL with this per-request timeout: no http retry and
   *  no fallback re-walk. Only broadcastRaw's post-error lookups by hash
   *  use it, so a status-unknown verdict is reached promptly; every other
   *  caller (the send itself included) keeps the transport above. */
  singleAttemptTimeoutMs?: number;
}

export function ethClient(net: EthNetwork, opts: EthClientOptions = {}) {
  const override = readEthRpcOverride();
  const defaults = ETH_RPC_DEFAULTS[net];
  // Override (if set + allowlisted) goes first, then the full diversified
  // default chain as fallback. dedupe so an override that equals a default
  // doesn't appear twice.
  const urls = override ? [override, ...defaults.filter((u) => u !== override)] : [...defaults];
  const guard = opts.signal ? cancellationGuard(opts.signal) : undefined;
  if (guard && opts.observe) throw new Error("ethClient: signal and observe are exclusive");
  const observe = opts.observe;
  const single = opts.singleAttemptTimeoutMs;
  return createPublicClient({
    chain: ethChain(net),
    // Explicit per-request timeout so one hung provider can't stall the
    // dashboard; fallback moves on to the next URL on timeout.
    //
    // Retry configuration (viem 2.21): each http transport retries a
    // retryable failure (HTTP 403/408/413/429/500/502/503/504, timeouts
    // and network errors, JSON-RPC -1/-32005/-32603) once (retryCount 1:
    // up to 2 attempts per URL); the fallback walks the URLs in order and
    // the whole walk is retried once more (fallback retryCount 1). So one
    // call makes up to 2 × 2 × N fetches for N URLs — 8 across the two
    // defaults, 12 with an override in front. Builds up to v0.6.x used
    // viem's http default (3) inside fallback retryCount 2.
    // Calls that pass their own retryCount override only the outer
    // (fallback) retry: eth_sendRawTransaction (viem passes retryCount 0)
    // makes at most 2 × N attempts — each of which may have delivered the
    // tx, which is why services/eth-tx.ts broadcastRaw probes by hash
    // after any failure instead of reporting it as a plain failure.
    transport: fallback(
      urls.map((u) => http(u, {
        timeout: single ?? ETH_RPC_TIMEOUT_MS,
        retryCount: single !== undefined ? 0 : 1,
        // Conditional spread: without a signal the config object is
        // exactly the pre-cancellation one (no `onFetchRequest` key).
        ...(guard ? { onFetchRequest: guard } : {}),
        ...(observe ? { onFetchRequest: observe.request, onFetchResponse: observe.response } : {}),
      })),
      { rank: false, retryCount: single !== undefined ? 0 : 1 },
    ),
  });
}

/**
 * Stops NEW requests once `signal` is aborted. viem calls `onFetchRequest`
 * before every fetch — on the first attempt, on each retry and on each
 * fallback hop — so throwing here means the retry / fallback stack issues
 * zero further requests after cancellation.
 *
 * Why not `fetchOptions: { signal }`: viem's http rpc client uses that
 * signal INSTEAD of its own per-request timeout controller
 * (`signal_ || (timeout > 0 ? signal : null)`), which silently disables
 * ETH_RPC_TIMEOUT_MS; and a pre-aborted signal still produces a full
 * retry cascade of (instantly failing) fetch() calls.
 *
 * Why status 499: an HttpRequestError with a status outside viem's retry
 * list is not retried, and carries no JSON-RPC code so the fallback moves
 * to the next (equally guarded) transport without delay; the outer
 * request rejects at once. Throwing `signal.reason` instead would also
 * issue no fetch, but viem would sleep through its retry schedule first
 * and surface a TimeoutError.
 *
 * Scope: one request already in flight when the signal aborts completes
 * (or times out under ETH_RPC_TIMEOUT_MS) on its own; its result is
 * discarded by the caller's cancellation checks.
 */
function cancellationGuard(signal: AbortSignal): (req: Request) => void {
  return (req: Request) => {
    if (!signal.aborted) return;
    const reason: unknown = signal.reason;
    throw new HttpRequestError({
      url: req.url,
      status: 499,
      details: "Request cancelled",
      cause: reason instanceof Error ? reason : new Error(String(reason ?? "aborted")),
    });
  };
}

function readEthRpcOverride(): string | undefined {
  try {
    const ov = useUI.getState().ethRpcOverride;
    if (ov && isAllowedEthRpcOverride(ov)) return ov;
  } catch {
    // Store may not have hydrated yet (SSR/test environments without
    // localStorage); fall back to defaults silently.
  }
  return undefined;
}
