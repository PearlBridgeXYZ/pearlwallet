// v0.7 — cheaper periodic PRL refetches (refresh mode).
//
// A full wallet walk is ~40+ paced requests. Periodic dashboard refetches
// skip addresses the last complete full walk found unused, more than
// PRL_REFRESH_WINDOW indexes past the last used one; any new activity in
// the walked part brings the skipped addresses back into the same scan.
// Full walks still run first, periodically and on every manual refetch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scanPrlWallet, type DeriveMoreAddresses, type PrlWalletScan } from "../src/services/discovery";
import {
  planPrlScan,
  nextScanBaseline,
  PRL_SCAN_REFETCH_MS,
  PRL_FULL_RESCAN_MS,
  PRL_REFRESH_WINDOW,
} from "../src/ui/hooks/useWalletBalances";
import type { ScanBaseline } from "../src/state/balance-memory";
import { useUI } from "../src/state/ui-store";
import type { HdBranch } from "../src/crypto/hd";

const SCRIPT = "5120" + "11".repeat(32);
interface MockTx {
  txid: string;
  vin: Array<{ txid?: string; vout?: number }>;
  vout: Array<{ value: number; n: number; scriptPubKey: { address: string; hex: string } }>;
}
let txSeq = 0;
function fund(addr: string, value: number): MockTx {
  txSeq++;
  return {
    txid: txSeq.toString(16).padStart(64, "0"),
    vin: [],
    vout: [{ value, n: 0, scriptPubKey: { address: addr, hex: SCRIPT } }],
  };
}

const searched: string[] = [];
let history: Record<string, MockTx[]> = {};
let failing = new Set<string>();
/** btcd-like searchrawtransactions; an empty first page is -5. `history`
 *  and `failing` can be changed between scans. */
function stubChain() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      if (body.method !== "searchrawtransactions") {
        return new Response(JSON.stringify({ result: null, error: { code: -32601, message: "nope" } }));
      }
      const addr = body.params[0] as string;
      const skip = body.params[2] as number;
      const count = body.params[3] as number;
      searched.push(addr);
      if (failing.has(addr)) return new Response("", { status: 503 });
      const page = (history[addr] ?? []).slice(skip, skip + count);
      if (page.length === 0) {
        return new Response(
          JSON.stringify({ result: null, error: { code: -5, message: "No information available about address" } }),
        );
      }
      return new Response(JSON.stringify({ result: page, error: null }));
    }),
  );
}

const name = (b: HdBranch, i: number) => `${b === 0 ? "ext" : "int"}-${i}`;
const list = (b: HdBranch, n: number) => Array.from({ length: n }, (_, i) => name(b, i));
const deriveMore: DeriveMoreAddresses = async (b, start, count) =>
  Array.from({ length: count }, (_, k) => name(b, start + k));

const SET = { external: list(0, 20), internal: list(1, 20) };

async function fullScan(set = SET): Promise<{ scan: PrlWalletScan; baseline: ScanBaseline }> {
  const scan = await scanPrlWallet(set, { deriveMore });
  const baseline = nextScanBaseline(undefined, scan);
  expect(baseline).toBeDefined();
  return { scan, baseline: baseline! };
}

function refreshOf(b: ScanBaseline) {
  const r = planPrlScan(b, b.fullAt + 1, false);
  expect(r).toBeDefined();
  return r!;
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
  history = {};
  failing = new Set();
  searched.length = 0;
  stubChain();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refresh cadence", () => {
  it("PRL refetch every 120 s; a full walk at least every 10 min; window 5", () => {
    expect(PRL_SCAN_REFETCH_MS).toBe(120_000);
    expect(PRL_FULL_RESCAN_MS).toBe(600_000);
    expect(PRL_REFRESH_WINDOW).toBe(5);
  });
});

describe("planPrlScan / nextScanBaseline", () => {
  const base: ScanBaseline = { fullAt: 1_000_000, lastUsed: [2, -1], knownUnused: new Set(["x"]) };

  it("full walk when there is no baseline, when forced (manual rescan) or when the baseline is old", () => {
    expect(planPrlScan(undefined, 1_000_001, false)).toBeUndefined();
    expect(planPrlScan(base, 1_000_001, true)).toBeUndefined();
    expect(planPrlScan(base, base.fullAt + PRL_FULL_RESCAN_MS, false)).toBeUndefined();
    expect(planPrlScan(base, base.fullAt + PRL_FULL_RESCAN_MS - 1, false)).toEqual({
      lastUsed: [2, -1],
      knownUnused: base.knownUnused,
      window: PRL_REFRESH_WINDOW,
    });
  });

  it("only a complete full walk replaces the baseline", async () => {
    history = { [name(0, 2)]: [fund(name(0, 2), 1)] };
    const { scan, baseline } = await fullScan();
    expect(baseline.lastUsed).toEqual([2, -1]);
    expect(baseline.fullAt).toBe(scan.startedAt);
    // Used external 2 extends that branch to 2 + 1 + 20 = 23 addresses.
    expect(scan.pool).toHaveLength(43);
    expect(baseline.knownUnused.size).toBe(42);
    expect(baseline.knownUnused.has(name(0, 2))).toBe(false);

    // A refresh (skipped > 0) keeps the previous baseline.
    const refreshed = await scanPrlWallet(scan.discovered, { deriveMore, refresh: refreshOf(baseline) });
    expect(refreshed.skipped).toBeGreaterThan(0);
    expect(nextScanBaseline(baseline, refreshed)).toBe(baseline);

    // A full walk with a read failure keeps it too.
    failing = new Set([name(1, 7)]);
    const partial = await scanPrlWallet(scan.discovered, { deriveMore });
    expect(partial.failures).toBe(1);
    expect(nextScanBaseline(baseline, partial)).toBe(baseline);
    expect(nextScanBaseline(undefined, partial)).toBeUndefined();
  });
});

describe("scanPrlWallet refresh mode", () => {
  it("skips known-unused addresses past the window; same balance, valid spendable set", async () => {
    history = {
      [name(0, 0)]: [fund(name(0, 0), 1)],
      [name(0, 2)]: [fund(name(0, 2), 2)],
      [name(1, 1)]: [fund(name(1, 1), 4)],
    };
    const { scan: full, baseline } = await fullScan();
    // Discovery extended external to 23 and internal to 22 addresses.
    expect(full.pool).toHaveLength(45);
    searched.length = 0;

    const r = await scanPrlWallet(full.discovered, { deriveMore, refresh: refreshOf(baseline) });
    // Walked: external 0..7 (last used 2 + window 5), internal 0..6 (1 + 5).
    expect(new Set(searched)).toEqual(new Set([...list(0, 8), ...list(1, 7)]));
    expect(searched).toHaveLength(15);
    expect(r.skipped).toBe(30);
    expect(r.pool).toHaveLength(15);
    expect(r.grains).toBe(full.grains);
    expect(r.source).toBe("live");
    expect(r.spendable!.utxos.map((u) => [u.branch, u.index]).sort()).toEqual(
      full.spendable!.utxos.map((u) => [u.branch, u.index]).sort(),
    );
    expect(r.discovery).toEqual({ complete: true, lastUsed: [2, 1], reasons: [] });
    expect(r.discovered).toEqual(full.discovered);
    r.refs.forEach((ref, i) => expect(r.pool[i]).toBe(name(ref.branch, ref.index)));
  });

  it("a balance change on a used address is seen by a refresh", async () => {
    history = { [name(0, 0)]: [fund(name(0, 0), 1)] };
    const { baseline } = await fullScan();
    history[name(0, 0)]!.push(fund(name(0, 0), 2));
    const r = await scanPrlWallet(SET, { deriveMore, refresh: refreshOf(baseline) });
    expect(r.grains).toBe(300_000_000n);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("new activity inside the window brings every skipped address back and re-runs discovery", async () => {
    history = { [name(0, 0)]: [fund(name(0, 0), 1)] };
    const { baseline } = await fullScan();
    // Since the full walk: a payment to external index 4 (inside the
    // window) and one to index 18 (outside it, normally skipped).
    history[name(0, 4)] = [fund(name(0, 4), 2)];
    history[name(0, 18)] = [fund(name(0, 18), 8)];
    searched.length = 0;
    const r = await scanPrlWallet(SET, { deriveMore, refresh: refreshOf(baseline) });
    expect(r.skipped).toBe(0);
    expect(r.grains).toBe(1_100_000_000n);
    expect(r.discovery).toEqual({ complete: true, lastUsed: [18, -1], reasons: [] });
    // Gap re-checked on complete data: external extended to 18 + 1 + 20.
    expect(r.discovered.external).toEqual(list(0, 39));
    expect(new Set(r.pool).size).toBe(r.pool.length);
    expect(r.pool).toHaveLength(59);
    // The baseline moves forward from this complete walk.
    const next = nextScanBaseline(baseline, r)!;
    expect(next.lastUsed).toEqual([18, -1]);
  });

  it("a payment to a skipped address is missed by a refresh but found by the next full walk", async () => {
    const { baseline } = await fullScan();
    history[name(1, 15)] = [fund(name(1, 15), 3)];
    const r = await scanPrlWallet(SET, { deriveMore, refresh: refreshOf(baseline) });
    expect(r.grains).toBe(0n);
    expect(r.pool).not.toContain(name(1, 15));
    // Manual rescan / periodic full walk: planPrlScan → full.
    expect(planPrlScan(baseline, baseline.fullAt + 1, true)).toBeUndefined();
    const full = await scanPrlWallet(SET, { deriveMore });
    expect(full.grains).toBe(300_000_000n);
    expect(full.discovery.lastUsed).toEqual([-1, 15]);
    expect(full.discovered.internal).toEqual(list(1, 36));
  });

  it("addresses added after the baseline (persisted discovery) are always walked", async () => {
    const { baseline } = await fullScan();
    const grown = { external: list(0, 26), internal: SET.internal };
    searched.length = 0;
    const r = await scanPrlWallet(grown, { deriveMore, refresh: refreshOf(baseline) });
    for (let i = 20; i < 26; i++) expect(searched).toContain(name(0, i));
    // Skipped: external 5..19 and internal 5..19 (last used -1, window 5).
    expect(r.skipped).toBe(15 + 15);
  });

  it("a read failure in refresh mode does not trigger a full walk and leaves the scan partial", async () => {
    history = { [name(0, 0)]: [fund(name(0, 0), 1)] };
    const { baseline } = await fullScan();
    failing = new Set([name(0, 3)]);
    const r = await scanPrlWallet(SET, { deriveMore, refresh: refreshOf(baseline) });
    expect(r.failures).toBe(1);
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.spendable).toBeNull();
    expect(r.discovery.complete).toBe(false);
    expect(nextScanBaseline(baseline, r)).toBe(baseline);
  });

  it("progress totals exclude skipped addresses", async () => {
    const { baseline } = await fullScan();
    const totals: number[] = [];
    const r = await scanPrlWallet(SET, {
      deriveMore,
      refresh: refreshOf(baseline),
      onProgress: (p) => totals.push(p.total),
    });
    expect(r.pool).toHaveLength(10); // ext 0..4, int 0..4 (last used -1, window 5)
    expect(new Set(totals)).toEqual(new Set([10]));
  });

  it("rejects a bad window", async () => {
    await expect(
      scanPrlWallet(SET, { refresh: { lastUsed: [0, 0], knownUnused: new Set(), window: -1 } }),
    ).rejects.toThrow("E_DISCOVERY_BAD_WINDOW");
  });
});
