// Progressive wallet balances for the dashboard.
//
// Replaces the single serial `fetchBalances` query with four independent
// queries so each asset renders as soon as its own source answers:
//
//   • PRL   — wallet scan over the external AND change branches with
//             gap-limit address discovery (services/discovery.ts
//             scanPrlWallet), with per-address progress ("Scanning 7/40")
//   • WPRL  — ERC-20 balance on Ethereum
//   • ETH   — native gas balance on Ethereum
//   • price — /api/prl-price
//
// Display semantics (all asset states share one shape):
//   value     best known value, or null if nothing is known yet
//   status    "loading" — nothing known yet, first fetch in flight
//             "ok"      — value is complete
//             "partial" — value is an ESTIMATE that may be high or low:
//                         unreadable addresses are left out (low), a
//                         page-capped history is walked oldest-first and
//                         can count receipts whose spends lie past the cap
//                         (high), and a remembered last-good value can be
//                         out of date either way. Never a spendable figure.
//             "error"   — no usable value (latest fetch failed and there
//                         is nothing earlier to fall back on)
//   stale     true when (part of) value comes from an EARLIER successful
//             fetch because the latest one failed — keep-last-good: a
//             failed refetch never overwrites a good value with 0
//   updatedAt ms timestamp of the oldest data contributing to value
//   error     message from the latest failed fetch, if any
//
// totalUsd is null whenever the price or the PRL balance is unknown —
// the UI must show "price unavailable", never $0.00, in that case.
//
// SAFETY: keep-last-good merging is DISPLAY ONLY. The react-query cache
// for the PRL scan holds the raw result of ONE fresh scan; its
// `spendable` field (the UTXO set Send may reuse) is non-null only when
// that single scan was complete. Nothing in this module writes merged,
// partial or remembered data anywhere Send reads from.
//
// RPC load: a full walk is ~40+ paced requests. Periodic refetches run in
// refresh mode (services/discovery.ts `refresh`): change addresses the
// last complete full walk found unused, more than PRL_REFRESH_WINDOW
// indexes past the last used one, are skipped unless the refresh sees new
// activity. External (receive) addresses use the full gap limit as their
// window, so every address the Receive screen can show is walked. A full walk runs on the first scan, every PRL_FULL_RESCAN_MS,
// and on every manual refetch (Retry / rescan). The in-memory state lives
// in state/balance-memory.ts and is cleared on lock, wipe and wallet
// switch.

import { useRef, useSyncExternalStore } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  scanPrlPool,
  fetchWprlBalance,
  fetchEthBalanceWei,
  type PrlPoolScan,
  type PrlPoolScanProgress,
} from "../../services/balances";
import { fetchPrlPriceUsd } from "../../services/prices";
import { detectFileProtocol } from "../../lib/pwa-install";
import { notePoolScan } from "../../services/broadcast-status";
import {
  scanPrlWallet,
  type DeriveMoreAddresses,
  type PrlWalletScan,
  type ScanRefresh,
} from "../../services/discovery";
import { DISCOVERY_GAP_LIMIT } from "../../crypto/hd";
import {
  clearBalanceMemory,
  getProgress,
  getScanBaseline,
  lastGoodByAddress,
  memoryEpoch,
  setProgress,
  setScanBaseline,
  subscribeProgress,
  type ScanBaseline,
  type ScanProgress,
} from "../../state/balance-memory";

export { clearBalanceMemory, type ScanProgress };

export type AssetStatus = "loading" | "ok" | "partial" | "error";

export interface AssetState<T> {
  value: T | null;
  status: AssetStatus;
  stale: boolean;
  updatedAt: number | null;
  error?: string;
  /** Why a PRL value is partial or stale (PRL only; absent when complete). */
  incomplete?: PrlIncompleteness;
}

/** What made a PRL total incomplete; each case moves it in its own way. */
export interface PrlIncompleteness {
  /** Addresses with no value this scan and none remembered (not counted). */
  unread: number;
  /** Addresses shown at their last good value from an earlier scan. */
  stale: number;
  /** A history was capped, or the scan / address discovery did not finish. */
  capped: boolean;
}

export interface WalletBalancesView {
  prl: AssetState<bigint>;
  /** null when the Ethereum surface is disabled in Settings. */
  wprl: AssetState<bigint> | null;
  /** null when the Ethereum surface is disabled in Settings. */
  eth: AssetState<bigint> | null;
  price: AssetState<number>;
  scan: ScanProgress;
  /** USD value of PRL (+ WPRL when enabled). null when unknown. */
  totalUsd: number | null;
  /** "partial" when a component is missing/partial (e.g. WPRL errored). */
  totalStatus: AssetStatus;
  totalStale: boolean;
  refetch: () => void;
}

// ─── Query keys / cadence ────────────────────────────────────────────────

/** React-query key of the PRL wallet scan. SendPRL reads `spendable` from
 *  this cache entry, so both sides must build the key with this helper.
 *  v0.7: keyed by wallet identity (external index 0), not the whole list —
 *  discovery grows the list mid-session and must not restart the scan.
 *  The scan itself records which addresses it covered (`scan.refs`). */
export function prlScanQueryKey(pool: readonly string[]): readonly [string, string] {
  return ["prl-pool-scan", pool[0] ?? ""] as const;
}

/** Periodic PRL refetch (refresh mode — see the header comment). */
export const PRL_SCAN_REFETCH_MS = 120_000;
/** A refresh-mode scan becomes a full walk once the last full walk is
 *  this old. */
export const PRL_FULL_RESCAN_MS = 10 * 60_000;
/** Change-branch addresses within this many indexes past the last used one
 *  are walked on every refresh (change is assigned sequentially). */
export const PRL_REFRESH_WINDOW = 5;
/** External-branch window: at least the whole gap limit. Discovery keeps
 *  the external list at last used + DISCOVERY_GAP_LIMIT, and Receive
 *  offers every address on it, so every address a payer may have been
 *  given is walked on every refresh. A persisted list that grew past that
 *  (an earlier extension by a faulty RPC) widens the window to its end
 *  (planPrlScan's externalLength). */
export const PRL_REFRESH_WINDOW_EXTERNAL = DISCOVERY_GAP_LIMIT;
export const ETH_REFETCH_MS = 30_000;
export const PRICE_REFETCH_MS = 60_000;

// ─── Scan planning (unit-tested) ─────────────────────────────────────────

/**
 * Refresh options for the next PRL scan, or undefined for a full walk.
 * Full when forced (manual refetch), when there is no baseline yet, or
 * when the baseline's full walk is PRL_FULL_RESCAN_MS old.
 */
export function planPrlScan(
  baseline: ScanBaseline | undefined,
  now: number,
  forceFull: boolean,
  /** Length of the persisted external list (every address Receive may
   *  have offered). The external window reaches its last index. */
  externalLength: number = 0,
): ScanRefresh | undefined {
  if (forceFull || !baseline) return undefined;
  if (now - baseline.fullAt >= PRL_FULL_RESCAN_MS) return undefined;
  const toEnd = Number.isInteger(externalLength) ? externalLength - baseline.lastUsed[0] - 1 : 0;
  return {
    lastUsed: baseline.lastUsed,
    knownUnused: baseline.knownUnused,
    window: [Math.max(PRL_REFRESH_WINDOW_EXTERNAL, toEnd), PRL_REFRESH_WINDOW],
  };
}

/**
 * Addresses the activity scan walks: every external address, and the
 * change addresses a refresh-mode balance scan walks too. Change addresses
 * the last full walk found unused past lastUsed + PRL_REFRESH_WINDOW are
 * left out (change is assigned sequentially, so they can only gain history
 * after the ones before them; the next full walk moves the window).
 */
export function activityPool(
  external: readonly string[],
  change: readonly string[],
  baseline: ScanBaseline | undefined,
): string[] {
  const walked = baseline
    ? change.filter((a, i) => !(baseline.knownUnused.has(a) && i > baseline.lastUsed[1] + PRL_REFRESH_WINDOW))
    : change;
  return [...external, ...walked];
}

/**
 * Baseline after a scan: replaced only by a full (nothing skipped) walk
 * with no read failures and complete discovery; otherwise the previous
 * one stands.
 */
export function nextScanBaseline(
  prev: ScanBaseline | undefined,
  scan: PrlWalletScan,
): ScanBaseline | undefined {
  if (scan.skipped > 0 || scan.failures > 0 || scan.degraded || !scan.discovery.complete) return prev;
  const knownUnused = new Set<string>();
  scan.perAddress.forEach((r, i) => {
    if (r.status === "ok" && !r.used) knownUnused.add(scan.pool[i]!);
  });
  return {
    fullAt: scan.startedAt,
    lastUsed: [scan.discovery.lastUsed[0], scan.discovery.lastUsed[1]],
    knownUnused,
  };
}

// ─── Per-address last-good ───────────────────────────────────────────────

/** Records a complete per-address read into the display memory
 *  (failed and page-capped reads are never remembered). */
export function rememberAddressResult(
  address: string,
  p: PrlPoolScanProgress,
  at: number,
  memory: Map<string, { grains: bigint; at: number }> = lastGoodByAddress,
): void {
  if (p.result.status === "ok" && !p.result.degraded) {
    memory.set(address, { grains: p.result.grains, at });
  }
}

// ─── Pure state derivation (unit-tested) ─────────────────────────────────

/**
 * Display state for PRL from the latest raw scan plus remembered
 * per-address values. An address that failed in this scan falls back to
 * its last good value (marked stale) instead of counting as 0.
 */
export function derivePrlState(
  scan: PrlPoolScan | undefined,
  memory: ReadonlyMap<string, { grains: bigint; at: number }>,
  queryError?: unknown,
): AssetState<bigint> {
  if (!scan) {
    if (queryError) {
      return { value: null, status: "error", stale: false, updatedAt: null, error: errMsg(queryError) };
    }
    return { value: null, status: "loading", stale: false, updatedAt: null };
  }
  let total = 0n;
  let unknown = 0;
  let staleCount = 0;
  let degraded = false;
  let oldest = scan.finishedAt;
  let firstError: string | undefined;
  scan.perAddress.forEach((r, i) => {
    if (r.status === "ok") {
      total += r.grains;
      if (r.degraded) degraded = true;
      return;
    }
    firstError ??= r.error;
    const lg = memory.get(scan.pool[i]!);
    if (lg) {
      total += lg.grains;
      staleCount++;
      if (lg.at < oldest) oldest = lg.at;
    } else {
      unknown++;
    }
  });
  // Scan-level incompleteness (discovery cap, derive failure, no deriver,
  // page caps) makes the total an estimate even if every address read ok.
  // Not a lower bound: a capped walk is oldest-first, so it can count
  // receipts whose spends lie beyond the cap.
  const wallet = scan as Partial<PrlWalletScan>;
  if (scan.degraded || (wallet.discovery !== undefined && !wallet.discovery.complete)) degraded = true;
  const n = scan.perAddress.length;
  const error = firstError ?? (queryError ? errMsg(queryError) : undefined);
  if (unknown > n / 2) {
    // Too little is known to show a number at all.
    return { value: null, status: "error", stale: false, updatedAt: null, error };
  }
  const status: AssetStatus = unknown > 0 || degraded ? "partial" : "ok";
  const stale = staleCount > 0 || !!queryError;
  return {
    value: total,
    status,
    stale,
    updatedAt: oldest,
    ...(error ? { error } : {}),
    ...(status === "partial" || stale
      ? { incomplete: { unread: unknown, stale: staleCount, capped: degraded } }
      : {}),
  };
}

/**
 * Warning text for a partial or stale PRL value. Truthful in both
 * directions: the figure is an estimate, never the spendable balance.
 * Null when the value is complete and current.
 */
export function prlIncompleteNote(state: AssetState<bigint>): string | null {
  if (state.status !== "partial" && !state.stale) return null;
  const inc = state.incomplete ?? { unread: 0, stale: 0, capped: false };
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const reasons: string[] = [];
  if (inc.unread > 0) {
    reasons.push(`${inc.unread} ${plural(inc.unread, "address couldn't be read and is", "addresses couldn't be read and are")} not counted.`);
  }
  if (inc.capped) reasons.push("Some address histories weren't read in full.");
  if (inc.stale > 0) {
    reasons.push(`${inc.stale} ${plural(inc.stale, "address shows its", "addresses show their")} last known balance.`);
  }
  if (reasons.length === 0) reasons.push("The latest scan failed; showing the previous result.");
  return `${reasons.join(" ")} This is an estimate that may be higher or lower than your real balance, not the amount you can send.`;
}

/** Display state for a simple react-query-backed asset. React-query keeps
 *  the previous `data` when a refetch fails — that is our last-good. */
export function deriveQueryState<T>(
  q: Pick<UseQueryResult<T>, "data" | "isError" | "error" | "dataUpdatedAt">,
): AssetState<T> {
  if (q.data !== undefined && q.data !== null) {
    return {
      value: q.data,
      status: "ok",
      stale: q.isError,
      updatedAt: q.dataUpdatedAt || null,
      ...(q.isError ? { error: errMsg(q.error) } : {}),
    };
  }
  if (q.isError) return { value: null, status: "error", stale: false, updatedAt: null, error: errMsg(q.error) };
  return { value: null, status: "loading", stale: false, updatedAt: null };
}

/** Total in USD. null whenever price or PRL is unknown (never $0.00 for
 *  "don't know"). WPRL missing while enabled ⇒ total is "partial". */
export function deriveTotal(
  prl: AssetState<bigint>,
  wprl: AssetState<bigint> | null,
  price: AssetState<number>,
): { totalUsd: number | null; totalStatus: AssetStatus; totalStale: boolean } {
  const stale = prl.stale || price.stale || !!wprl?.stale;
  if (price.value === null || prl.value === null) {
    const loading = prl.status === "loading" || price.status === "loading";
    return { totalUsd: null, totalStatus: loading ? "loading" : "error", totalStale: false };
  }
  let usd = (Number(prl.value) / 1e8) * price.value;
  let partial = prl.status === "partial";
  if (wprl) {
    if (wprl.value === null) partial = true;
    else usd += (Number(wprl.value) / 1e8) * price.value;
  }
  return { totalUsd: usd, totalStatus: partial ? "partial" : "ok", totalStale: stale };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── Hook ────────────────────────────────────────────────────────────────

export interface UseWalletBalancesArgs {
  /** External (receive) branch addresses, ordered by index. */
  pool: readonly string[];
  /** Internal (change) branch addresses. When given, the scan covers both
   *  branches with gap-limit discovery. */
  changePool?: readonly string[];
  /** Derives addresses past the known set (discovery). */
  deriveMore?: DeriveMoreAddresses;
  /** Persists a discovered (extended) address set. */
  onDiscovered?: (set: { external: string[]; internal: string[] }) => unknown;
  /** Preferred over onDiscovered: called when a scan STARTS and returns
   *  the persist callback for that scan (bound to the wallet's address
   *  generation, so a scan that raced an address reset persists nothing). */
  bindOnDiscovered?: () => (set: { external: string[]; internal: string[] }) => unknown;
  ethAddr?: string;
  ethEnabled: boolean;
}

export function useWalletBalances({
  pool,
  changePool,
  deriveMore,
  onDiscovered,
  bindOnDiscovered,
  ethAddr,
  ethEnabled,
}: UseWalletBalancesArgs): WalletBalancesView {
  const key = prlScanQueryKey(pool);
  const poolKey = key[1];
  // The query is keyed by wallet identity; the scan reads the CURRENT
  // address lists and callbacks at run time so a list extended by
  // discovery is picked up by the next refetch without restarting this one.
  const latest = useRef({ pool, changePool, deriveMore, onDiscovered, bindOnDiscovered });
  latest.current = { pool, changePool, deriveMore, onDiscovered, bindOnDiscovered };
  // Set by the returned `refetch` (user-initiated): the next scan walks
  // every address instead of running in refresh mode.
  const forceFull = useRef(false);

  const prlQ = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const cur = latest.current;
      const persistDiscovered = cur.bindOnDiscovered ? cur.bindOnDiscovered() : cur.onDiscovered;
      const ext = [...cur.pool];
      const int = cur.changePool ? [...cur.changePool] : null;
      // A lock / wipe / wallet switch during this scan bumps the epoch;
      // from then on the scan writes nothing to the display memory.
      const epoch = memoryEpoch();
      const current = () => epoch === memoryEpoch();
      setProgress(poolKey, { done: 0, total: ext.length + (int?.length ?? 0), running: true });
      let lastTotal = ext.length + (int?.length ?? 0);
      const onProgress = (p: PrlPoolScanProgress) => {
        if (!current()) return;
        rememberAddressResult(p.ref.address, p, Date.now());
        lastTotal = p.total;
        setProgress(poolKey, { done: p.done, total: p.total, running: true });
      };
      try {
        if (!int) {
          const pooled = await scanPrlPool(ext, { signal, onProgress });
          notePoolScan(pooled);
          return pooled;
        }
        const refresh = planPrlScan(getScanBaseline(poolKey), Date.now(), forceFull.current, ext.length);
        forceFull.current = false;
        const scan = await scanPrlWallet(
          { external: ext, internal: int },
          { signal, onProgress, deriveMore: cur.deriveMore, ...(refresh ? { refresh } : {}) },
        );
        // Complete reads settle broadcast records they prove spent.
        notePoolScan(scan);
        const baseline = nextScanBaseline(getScanBaseline(poolKey), scan);
        if (baseline && current()) setScanBaseline(poolKey, baseline);
        if (
          persistDiscovered &&
          (scan.discovered.external.length > ext.length || scan.discovered.internal.length > int.length)
        ) {
          try {
            await persistDiscovered(scan.discovered);
          } catch {
            /* best-effort persistence; the scan result stands */
          }
        }
        return scan;
      } finally {
        if (current()) {
          const p = getProgress(poolKey);
          setProgress(poolKey, { done: p?.done ?? 0, total: lastTotal, running: false });
        }
      }
    },
    enabled: pool.length > 0,
    refetchInterval: PRL_SCAN_REFETCH_MS,
    staleTime: 30_000,
    // The RPC client already backs off and retries each request.
    retry: false,
  });

  const wprlQ = useQuery({
    queryKey: ["wprl-balance", ethAddr],
    queryFn: () => fetchWprlBalance(ethAddr!),
    enabled: ethEnabled && !!ethAddr,
    refetchInterval: ETH_REFETCH_MS,
    retry: 1,
  });

  const ethQ = useQuery({
    queryKey: ["eth-balance", ethAddr],
    queryFn: () => fetchEthBalanceWei(ethAddr as `0x${string}`, "mainnet"),
    enabled: ethEnabled && !!ethAddr,
    refetchInterval: ETH_REFETCH_MS,
    retry: 1,
  });

  // The price proxy is a same-origin route (/api/prl-price). Opened from
  // file:// (the offline single-file build) there is no origin to serve it,
  // so don't fire a fetch that can only fail and log on every refetch.
  const priceQ = useQuery({
    queryKey: ["prl-price"],
    queryFn: () => fetchPrlPriceUsd(),
    enabled: !detectFileProtocol(),
    staleTime: PRICE_REFETCH_MS,
    refetchInterval: PRICE_REFETCH_MS,
    retry: 1,
  });

  const progress = useSyncExternalStore(
    subscribeProgress,
    () => getProgress(poolKey),
    () => undefined,
  );

  // Cheap pure derivation; recomputed each render so per-address memory
  // written during a scan is picked up as progress re-renders arrive.
  const prl = derivePrlState(prlQ.data, lastGoodByAddress, prlQ.isError ? prlQ.error : undefined);
  const wprl = ethEnabled ? deriveQueryState(wprlQ) : null;
  const eth = ethEnabled ? deriveQueryState(ethQ) : null;
  const price = deriveQueryState(priceQ);
  const total = deriveTotal(prl, wprl, price);

  return {
    prl,
    wprl,
    eth,
    price,
    scan: {
      done: progress?.done ?? 0,
      total: progress?.total ?? pool.length,
      running: progress?.running ?? prlQ.isFetching,
    },
    ...total,
    refetch: () => {
      forceFull.current = true;
      void prlQ.refetch();
      if (ethEnabled) {
        void wprlQ.refetch();
        void ethQ.refetch();
      }
      void priceQ.refetch();
    },
  };
}
