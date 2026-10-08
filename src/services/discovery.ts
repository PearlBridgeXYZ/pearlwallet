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
}

export type DiscoveryIncompleteReason = "rpc-failures" | "cap" | "derive-failed" | "no-deriver";

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

  const lists: [string[], string[]] = [set.external.slice(0, cap), set.internal.slice(0, cap)];
  const scanned: [number, number] = [0, 0];
  const lastUsed: [number, number] = [-1, -1];
  const deriveFailed: [boolean, boolean] = [false, false];
  let capped = false;
  let noDeriver = false;

  const refs: WalletAddressRef[] = [];
  const perAddress: PoolAddressResult[] = [];
  const total = () => lists[0].length + lists[1].length;

  for (;;) {
    // 1. Extend each branch to cover the gap window past its last used index.
    for (const b of BRANCHES) {
      const need = lastUsed[b] + 1 + gap;
      if (need > cap) capped = true;
      const want = Math.min(need, cap);
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

    // 2. Walk every address not yet walked in this scan.
    const batch: WalletAddressRef[] = [];
    for (const b of BRANCHES) {
      for (let i = scanned[b]; i < lists[b].length; i++) {
        batch.push({ address: lists[b][i]!, branch: b, index: i });
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
    });
  }

  const failures = perAddress.some((r) => r.status === "error");
  const reasons: DiscoveryIncompleteReason[] = [];
  if (failures) reasons.push("rpc-failures");
  if (capped) reasons.push("cap");
  if (deriveFailed[0] || deriveFailed[1]) reasons.push("derive-failed");
  if (noDeriver) reasons.push("no-deriver");
  const complete = reasons.length === 0;

  // Anything other than RPC failures (already counted by the summary)
  // that leaves discovery incomplete still makes the total a lower bound.
  const scan = summarizePoolScan(refs, perAddress, startedAt, capped || deriveFailed[0] || deriveFailed[1] || noDeriver);
  return {
    ...scan,
    discovered: { external: [...lists[0]], internal: [...lists[1]] },
    discovery: { complete, lastUsed: [lastUsed[0], lastUsed[1]], reasons },
  };
}
