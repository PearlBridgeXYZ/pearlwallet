// BIP-44-style address discovery for the single-sig Pearl account
// m/86'/808276'/0' — both the external (0) and internal/change (1) branch.
//
// Why: the Pearl reference wallet sends change to branch 1, and the desktop
// wallet advances the receive index every time its Receive view opens. A
// fixed window of 20 external addresses therefore misses change outputs
// entirely and any payment that landed past index 19.
//
// How: every known address of each branch is walked (balance + "used"
// flag in the same searchrawtransactions walk, so discovery costs no extra
// request per address). After each round, a branch whose highest used
// index is within DISCOVERY_GAP_LIMIT of the end is extended — more
// addresses are derived (in the crypto worker, public data only) and
// walked — until DISCOVERY_GAP_LIMIT consecutive addresses past the last
// used one have no history, or MAX_ADDRESSES_PER_BRANCH is reached. "No
// history" = the node answered "No information available about address"
// (-5) or an empty first page. Every request goes through the shared
// Pearl RPC limiter (via fetchPrlUtxos).
//
// Failure handling: an address whose walk failed is UNKNOWN — it neither
// extends the branch nor counts as unused, and it makes the scan "partial"
// (no spendable set). Discovery never extends on guesses, so an RPC outage
// cannot run the walk out to the cap. The next scan retries; discovered
// addresses are persisted by the caller, so progress is not lost.
//
// Refresh mode (`refresh`): periodic dashboard refetches may skip addresses
// that the last complete full walk read as unused AND that lie more than
// `refresh.window` indexes past that walk's last used index on their
// branch. Everything else — every address with history, the window right
// after the last used one, and anything derived since — is walked as
// usual. If any walked address turns out newly used (it was known unused,
// or lies past the baseline's last used index), the skipped addresses are
// walked in the same scan, so discovery runs on complete data whenever
// the wallet's activity moved. A skipped address is one that had no
// history at the baseline walk; funds that arrive on it are picked up by
// the next full walk (the caller schedules one periodically and on every
// manual rescan). Skipping only ever removes coins from `spendable`, never
// adds any, so a refresh-mode set stays a valid subset for coin selection.
//
// Growth bound: one scan adds at most `maxExtendPerScan` addresses per
// branch (an RPC claiming every address is used can't run the persisted
// list to MAX_ADDRESSES_PER_BRANCH in one go); hitting it leaves discovery
// incomplete and the next scan continues. Settings shows the tracked
// address counts and can reset the lists to the default window.
//
// Known gap: seeds affected by btcutil hdkeychain issue #172 (oyster's
// DeriveNonStandard) derive a different subtree in oyster; that variant is
// not emulated here (see crypto/hd.ts).

import {
  DISCOVERY_GAP_LIMIT,
  MAX_ADDRESSES_PER_BRANCH,
  MAX_DERIVE_BATCH,
  type HdBranch,
} from "../crypto/hd";
import {
  summarizePoolScan,
  walkPoolAddresses,
  type PoolAddressResult,
  type PrlPoolScan,
  type ScanPrlPoolOptions,
  type WalletAddressRef,
} from "./balances";

/** The wallet's known single-sig addresses, by branch, ordered by index. */
export interface PearlAddressSet {
  external: readonly string[];
  internal: readonly string[];
}

/** Derives `count` addresses of `branch` starting at index `start`. */
export type DeriveMoreAddresses = (branch: HdBranch, start: number, count: number) => Promise<string[]>;

export interface ScanPrlWalletOptions extends ScanPrlPoolOptions {
  /** Supplies addresses beyond the known set. Without it the scan covers
   *  only the known set and reports discovery as incomplete when the gap
   *  limit is not yet satisfied. */
  deriveMore?: DeriveMoreAddresses;
  gapLimit?: number;
  maxPerBranch?: number;
  /** Most addresses one scan may add to a branch (default
   *  MAX_EXTEND_PER_SCAN). Bounds the damage of an RPC that reports every
   *  address as used: the list grows by at most this much per scan, and
   *  the scan is reported incomplete ("extension-limit"). */
  maxExtendPerScan?: number;
  /** Refresh mode — see the header comment. Omit for a full walk. */
  refresh?: ScanRefresh;
}

/** What a previous complete full walk established, for refresh mode. */
export interface ScanRefresh {
  /** Highest index with history per branch [external, internal]. */
  lastUsed: readonly [number, number];
  /** Addresses that walk read successfully and found without history. */
  knownUnused: ReadonlySet<string>;
  /** Addresses within this many indexes past `lastUsed` are always walked:
   *  one number for both branches, or [external, internal]. */
  window: number | readonly [number, number];
}

export type DiscoveryIncompleteReason = "rpc-failures" | "cap" | "derive-failed" | "no-deriver" | "extension-limit";

/** Default per-scan, per-branch extension bound (see maxExtendPerScan). */
export const MAX_EXTEND_PER_SCAN = MAX_DERIVE_BATCH;

export interface DiscoveryState {
  /** True when every branch has `gapLimit` confirmed-unused addresses past
   *  its last used one and no address read failed. */
  complete: boolean;
  /** Highest index with history, per branch [external, internal]; -1 = none. */
  lastUsed: [number, number];
  reasons: DiscoveryIncompleteReason[];
}

export interface PrlWalletScan extends PrlPoolScan {
  /** Known set after discovery (input set plus anything derived). Always a
   *  prefix-extension of the input. */
  discovered: { external: string[]; internal: string[] };
  discovery: DiscoveryState;
  /** Addresses refresh mode skipped (not walked, not in `pool`). 0 for a
   *  full walk. */
  skipped: number;
}

const BRANCHES: readonly HdBranch[] = [0, 1];

/**
 * Scans the wallet's PRL balance across both branches with gap-limit
 * discovery. Never throws for per-address RPC failures (reported via
 * `perAddress` / `source`); throws only if `signal` aborts.
 */
export async function scanPrlWallet(set: PearlAddressSet, opts: ScanPrlWalletOptions = {}): Promise<PrlWalletScan> {
  const startedAt = Date.now();
  const gap = opts.gapLimit ?? DISCOVERY_GAP_LIMIT;
  const cap = opts.maxPerBranch ?? MAX_ADDRESSES_PER_BRANCH;
  if (!Number.isInteger(gap) || gap < 1) throw new Error("E_DISCOVERY_BAD_GAP");
  if (!Number.isInteger(cap) || cap < 1) throw new Error("E_DISCOVERY_BAD_CAP");
  const maxExtend = opts.maxExtendPerScan ?? MAX_EXTEND_PER_SCAN;
  if (!Number.isInteger(maxExtend) || maxExtend < 0) throw new Error("E_DISCOVERY_BAD_EXTEND");
  const refresh = opts.refresh;
  const windows: [number, number] = refresh
    ? typeof refresh.window === "number"
      ? [refresh.window, refresh.window]
      : [refresh.window[0], refresh.window[1]]
    : [0, 0];
  if (refresh && windows.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new Error("E_DISCOVERY_BAD_WINDOW");
  }

  const lists: [string[], string[]] = [set.external.slice(0, cap), set.internal.slice(0, cap)];
  const extendLimit: [number, number] = [lists[0].length + maxExtend, lists[1].length + maxExtend];
  let extensionLimited = false;
  const scanned: [number, number] = [0, 0];
  const lastUsed: [number, number] = [-1, -1];
  const deriveFailed: [boolean, boolean] = [false, false];
  let capped = false;
  let noDeriver = false;

  const refs: WalletAddressRef[] = [];
  const perAddress: PoolAddressResult[] = [];
  // Refresh mode: addresses held back while `skipping`; walked as soon as
  // the scan sees new activity.
  let skipping = !!refresh;
  const deferred: WalletAddressRef[] = [];
  const skippable = (ref: WalletAddressRef) =>
    !!refresh && refresh.knownUnused.has(ref.address) && ref.index > refresh.lastUsed[ref.branch] + windows[ref.branch];
  const isNewActivity = (ref: WalletAddressRef) =>
    !!refresh && (refresh.knownUnused.has(ref.address) || ref.index > refresh.lastUsed[ref.branch]);
  const total = () => lists[0].length + lists[1].length - (skipping ? deferred.length : 0);

  for (;;) {
    // 1. Extend each branch to cover the gap window past its last used index.
    for (const b of BRANCHES) {
      const need = lastUsed[b] + 1 + gap;
      if (need > cap) capped = true;
      if (need > extendLimit[b] && extendLimit[b] < cap) extensionLimited = true;
      const want = Math.min(need, cap, extendLimit[b]);
      const list = lists[b];
      if (want <= list.length || deriveFailed[b]) continue;
      if (!opts.deriveMore) {
        noDeriver = true;
        continue;
      }
      try {
        while (list.length < want) {
          const start = list.length;
          const count = Math.min(MAX_DERIVE_BATCH, want - start);
          const got = await opts.deriveMore(b, start, count);
          if (
            !Array.isArray(got) ||
            got.length !== count ||
            got.some((a) => typeof a !== "string" || a.length === 0)
          ) {
            throw new Error("E_DISCOVERY_BAD_DERIVE");
          }
          list.push(...got);
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        deriveFailed[b] = true;
      }
    }

    // 2. Walk every address not yet walked in this scan (in refresh mode,
    //    minus the skippable ones until new activity shows up).
    const batch: WalletAddressRef[] = [];
    if (!skipping) batch.push(...deferred.splice(0));
    for (const b of BRANCHES) {
      for (let i = scanned[b]; i < lists[b].length; i++) {
        const ref: WalletAddressRef = { address: lists[b][i]!, branch: b, index: i };
        if (skipping && skippable(ref)) deferred.push(ref);
        else batch.push(ref);
      }
      scanned[b] = lists[b].length;
    }
    if (batch.length === 0) break;

    const results = await walkPoolAddresses(batch, opts, {
      doneBase: perAddress.length,
      indexBase: perAddress.length,
      total,
    });
    results.forEach((r, k) => {
      const ref = batch[k]!;
      refs.push(ref);
      perAddress.push(r);
      if (r.status === "ok" && r.used && ref.index > lastUsed[ref.branch]) {
        lastUsed[ref.branch] = ref.index;
      }
      if (skipping && r.status === "ok" && r.used && isNewActivity(ref)) skipping = false;
    });
    // On new activity `skipping` is now false: the next round walks
    // everything held back, and the extension step re-checks the gap
    // window on complete data.
  }

  const failures = perAddress.some((r) => r.status === "error");
  const reasons: DiscoveryIncompleteReason[] = [];
  if (failures) reasons.push("rpc-failures");
  if (capped) reasons.push("cap");
  if (deriveFailed[0] || deriveFailed[1]) reasons.push("derive-failed");
  if (noDeriver) reasons.push("no-deriver");
  if (extensionLimited) reasons.push("extension-limit");
  const complete = reasons.length === 0;

  // Anything other than RPC failures (already counted by the summary)
  // that leaves discovery incomplete still makes the total a lower bound.
  const scan = summarizePoolScan(
    refs,
    perAddress,
    startedAt,
    capped || deriveFailed[0] || deriveFailed[1] || noDeriver || extensionLimited,
  );
  return {
    ...scan,
    discovered: { external: [...lists[0]], internal: [...lists[1]] },
    discovery: { complete, lastUsed: [lastUsed[0], lastUsed[1]], reasons },
    skipped: skipping ? deferred.length : 0,
  };
}
