// Shared request pacing for the public Pearl RPC.
//
// The origin in front of rpc.pearlbridge.xyz rate-limits per client at
// about 1 request/second sustained with a burst of about 10 (measured
// 2026-10-07; beyond that nginx answers 503). The wallet paces itself at
// 0.9 req/s with a burst of 8 (DEFAULT_PEARL_RPC_TUNING in pearl-rpc.ts,
// which records the measurement). Every Pearl RPC request the
// wallet makes — balance walk pages, activity pages, Send's UTXO walk,
// broadcasts — draws from ONE module-level token bucket so independent
// scans can never add up to more than the budget.
//
// Priority lanes: when the bucket is empty, "high" waiters (balance scan,
// Send, broadcast) are served before "low" waiters (activity). That stops
// the activity scan from racing the balance scan for tokens without
// having to coordinate the two callers explicitly.
//
// Also home to the small helpers every scan shares: a bounded-concurrency
// map and an abort-aware sleep.

export type RpcPriority = "high" | "low";

export interface TokenBucketOptions {
  /** Sustained refill rate. `Infinity` disables pacing entirely. */
  ratePerSec: number;
  /** Bucket capacity — how many requests may go out back to back. */
  burst: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface Waiter {
  priority: RpcPriority;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class TokenBucket {
  readonly ratePerSec: number;
  readonly burst: number;
  private readonly now: () => number;
  private tokens: number;
  private last: number;
  private readonly high: Waiter[] = [];
  private readonly low: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TokenBucketOptions) {
    if (!(opts.ratePerSec > 0)) throw new Error("TokenBucket: ratePerSec must be > 0");
    if (!(opts.burst >= 1)) throw new Error("TokenBucket: burst must be >= 1");
    this.ratePerSec = opts.ratePerSec;
    this.burst = opts.burst;
    this.now = opts.now ?? (() => Date.now());
    this.tokens = opts.burst;
    this.last = this.now();
  }

  /** Number of callers currently waiting for a token. */
  get pending(): number {
    return this.high.length + this.low.length;
  }

  private refill(): void {
    if (!Number.isFinite(this.ratePerSec)) {
      this.tokens = this.burst;
      return;
    }
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSec) / 1000);
  }

  /** Resolves when the caller may send one request. FIFO within a lane;
   *  the high lane always drains before the low lane. */
  take(priority: RpcPriority = "high", signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    this.refill();
    if (this.pending === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { priority, resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const lane = w.priority === "high" ? this.high : this.low;
          const i = lane.indexOf(w);
          if (i >= 0) lane.splice(i, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      (priority === "high" ? this.high : this.low).push(w);
      this.pump();
    });
  }

  private pump(): void {
    this.refill();
    while (this.tokens >= 1) {
      const w = this.high.shift() ?? this.low.shift();
      if (!w) return;
      this.tokens -= 1;
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      w.resolve();
    }
    if (this.pending === 0 || this.timer) return;
    const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) * 1000) / this.ratePerSec));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, waitMs);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** setTimeout as a promise; rejects early if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight.
 * Results keep input order. Errors are NOT swallowed here — callers that
 * tolerate per-item failure catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
