// v0.7 — progressive balance data layer: split pool scan with progress,
// spendable-set isolation, keep-last-good display merging, partial
// status, price-unknown total, Send's live-walk error honesty, and the
// ported CoinGecko fallback in the price function.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  scanPrlPool,
  fetchBalances,
  type PrlPoolScan,
  type PrlPoolScanProgress,
} from "../src/services/balances";
import { composePearlSend } from "../src/services/pearl-tx";
import {
  derivePrlState,
  deriveQueryState,
  deriveTotal,
  prlScanQueryKey,
  rememberAddressResult,
  clearBalanceMemory,
  type AssetState,
} from "../src/ui/hooks/useWalletBalances";
import { useUI } from "../src/state/ui-store";

const A = "prl1paaaa";
const B = "prl1pbbbb";
const C = "prl1pcccc";
const SCRIPT = "5120" + "00".repeat(32);

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result, error: null }), { status: 200 });
}
function credit(addr: string, value: number, id = addr) {
  return {
    txid: Buffer.from(id).toString("hex").padStart(64, "0").slice(0, 64),
    vin: [],
    vout: [{ value, n: 0, scriptPubKey: { address: addr, hex: SCRIPT } }],
  };
}

/** Pearl RPC mock: per-address credit, `fail` addresses always 503. */
function stubPearl(credits: Record<string, number>, fail: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/prl-price")) {
      return new Response(JSON.stringify({ usd_per_prl: 2, source: "coingecko", n_active_asks: 0 }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    if (body.method !== "searchrawtransactions") return ok("0x0");
    const addr = body.params[0] as string;
    if (fail.includes(addr)) return new Response("", { status: 503 });
    if (body.params[2] === 0 && credits[addr] !== undefined) return ok([credit(addr, credits[addr]!)]);
    return ok([]);
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
  clearBalanceMemory();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── scanPrlPool ─────────────────────────────────────────────────────────

describe("scanPrlPool", () => {
  it("reports per-address progress and a complete spendable set", async () => {
    stubPearl({ [A]: 1, [B]: 2, [C]: 3 });
    const progress: PrlPoolScanProgress[] = [];
    const scan = await scanPrlPool([A, B, C], { onProgress: (p) => progress.push(p) });
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3]);
    expect(progress.every((p) => p.total === 3)).toBe(true);
    expect(new Set(progress.map((p) => p.index))).toEqual(new Set([0, 1, 2]));
    expect(scan.source).toBe("live");
    expect(scan.grains).toBe(600_000_000n);
    expect(scan.spendable).not.toBeNull();
    expect(scan.spendable!.utxos.map((u) => u.poolIndex).sort()).toEqual([0, 1, 2]);
    expect(scan.spendable!.fetchedAt).toBe(scan.startedAt);
  });

  it("partial scan: sum of readable addresses, source 'partial', NO spendable set", async () => {
    stubPearl({ [A]: 1, [B]: 2, [C]: 3 }, [B]);
    const scan = await scanPrlPool([A, B, C]);
    expect(scan.source).toBe("partial");
    expect(scan.failures).toBe(1);
    expect(scan.grains).toBe(400_000_000n);
    expect(scan.spendable).toBeNull();
    expect(scan.perAddress[1]!.status).toBe("error");
  });

  it("majority failure: source 'error', grains 0, no spendable set", async () => {
    stubPearl({ [A]: 1 }, [B, C]);
    const scan = await scanPrlPool([A, B, C]);
    expect(scan.source).toBe("error");
    expect(scan.grains).toBe(0n);
    expect(scan.spendable).toBeNull();
  });

  it("walks addresses with bounded concurrency (≤ scanConcurrency in flight)", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok([]);
    }));
    await scanPrlPool(Array.from({ length: 9 }, (_, i) => `prl1p${i}`));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("legacy fetchBalances never exposes prlUtxos from a partial walk", async () => {
    stubPearl({ [A]: 1, [B]: 2, [C]: 3 }, [B]);
    const out = await fetchBalances([A, B, C], "0x0000000000000000000000000000000000000001", { ethEnabled: false });
    expect(out.prlSource).toBe("partial");
    expect(out.prlUtxos).toEqual([]);
  });

  it("query key helper is stable for the same pool", () => {
    expect(prlScanQueryKey([A, B])).toEqual(prlScanQueryKey([A, B]));
    expect(prlScanQueryKey([A, B])).not.toEqual(prlScanQueryKey([B, A]));
  });
});

// ─── Display derivation (keep-last-good) ─────────────────────────────────

function scanOf(results: Array<{ addr: string; grains?: bigint; fail?: boolean; degraded?: boolean }>, at = 10_000): PrlPoolScan {
  const perAddress = results.map((r) =>
    r.fail
      ? { status: "error" as const, error: "rpc http 503" }
      : { status: "ok" as const, grains: r.grains ?? 0n, degraded: !!r.degraded, utxos: [] },
  );
  const failures = perAddress.filter((p) => p.status === "error").length;
  return {
    pool: results.map((r) => r.addr),
    perAddress,
    grains: 0n,
    failures,
    degraded: results.some((r) => r.degraded),
    source: failures > results.length / 2 ? "error" : failures > 0 ? "partial" : "live",
    spendable: null,
    startedAt: at - 100,
    finishedAt: at,
  };
}

describe("derivePrlState — keep-last-good", () => {
  it("loading before the first scan", () => {
    expect(derivePrlState(undefined, new Map()).status).toBe("loading");
  });

  it("complete scan → ok, not stale", () => {
    const s = derivePrlState(scanOf([{ addr: A, grains: 5n }, { addr: B, grains: 7n }]), new Map());
    expect(s).toMatchObject({ value: 12n, status: "ok", stale: false, updatedAt: 10_000 });
  });

  it("a failed address falls back to its last good value (stale), never 0", () => {
    const memory = new Map([[B, { grains: 700n, at: 5_000 }]]);
    const s = derivePrlState(scanOf([{ addr: A, grains: 5n }, { addr: B, fail: true }]), memory);
    expect(s.value).toBe(705n);
    expect(s.status).toBe("ok");
    expect(s.stale).toBe(true);
    expect(s.updatedAt).toBe(5_000);
    expect(s.error).toMatch(/503/);
  });

  it("whole refetch failed but every address remembered → last good total, stale", () => {
    const memory = new Map([
      [A, { grains: 100n, at: 1_000 }],
      [B, { grains: 200n, at: 1_000 }],
    ]);
    const s = derivePrlState(scanOf([{ addr: A, fail: true }, { addr: B, fail: true }]), memory);
    expect(s.value).toBe(300n);
    expect(s.stale).toBe(true);
    expect(s.status).not.toBe("error");
  });

  it("a failed address with no memory → 'partial' (value is a lower bound)", () => {
    const s = derivePrlState(
      scanOf([{ addr: A, grains: 5n }, { addr: B, grains: 1n }, { addr: C, fail: true }]),
      new Map(),
    );
    expect(s.status).toBe("partial");
    expect(s.value).toBe(6n);
  });

  it("page-cap degraded address → 'partial'", () => {
    const s = derivePrlState(scanOf([{ addr: A, grains: 5n, degraded: true }]), new Map());
    expect(s.status).toBe("partial");
  });

  it("majority unknown → 'error' with no number", () => {
    const s = derivePrlState(
      scanOf([{ addr: A, grains: 5n }, { addr: B, fail: true }, { addr: C, fail: true }]),
      new Map(),
    );
    expect(s.status).toBe("error");
    expect(s.value).toBeNull();
  });

  it("rememberAddressResult stores only complete per-address reads", () => {
    const m = new Map<string, { grains: bigint; at: number }>();
    rememberAddressResult(A, { done: 1, total: 3, index: 0, result: { status: "ok", grains: 9n, degraded: false, utxos: [] } }, 1, m);
    rememberAddressResult(B, { done: 2, total: 3, index: 1, result: { status: "ok", grains: 9n, degraded: true, utxos: [] } }, 1, m);
    rememberAddressResult(C, { done: 3, total: 3, index: 2, result: { status: "error", error: "x" } }, 1, m);
    expect([...m.keys()]).toEqual([A]);
    // Next scan: A fails → its remembered 9 is used; B, C fresh.
    const s = derivePrlState(
      scanOf([{ addr: A, fail: true }, { addr: B, grains: 1n }, { addr: C, grains: 1n }]),
      m,
    );
    expect(s.value).toBe(11n);
    expect(s.stale).toBe(true);
  });
});

describe("deriveQueryState / deriveTotal", () => {
  const okState = <T,>(v: T): AssetState<T> => ({ value: v, status: "ok", stale: false, updatedAt: 1 });

  it("failed refetch keeps previous data and marks it stale", () => {
    const s = deriveQueryState({ data: 5n, isError: true, error: new Error("boom"), dataUpdatedAt: 42 });
    expect(s).toMatchObject({ value: 5n, status: "ok", stale: true, updatedAt: 42, error: "boom" });
  });

  it("no data + error → error; no data + no error → loading", () => {
    expect(deriveQueryState({ data: undefined, isError: true, error: new Error("x"), dataUpdatedAt: 0 }).status).toBe("error");
    expect(deriveQueryState({ data: undefined, isError: false, error: null, dataUpdatedAt: 0 }).status).toBe("loading");
  });

  it("price unknown → totalUsd null (never $0.00)", () => {
    const priceErr: AssetState<number> = { value: null, status: "error", stale: false, updatedAt: null };
    const t = deriveTotal(okState(100_000_000n), null, priceErr);
    expect(t.totalUsd).toBeNull();
    expect(t.totalStatus).toBe("error");
  });

  it("price loading → totalUsd null, status loading", () => {
    const priceLoading: AssetState<number> = { value: null, status: "loading", stale: false, updatedAt: null };
    expect(deriveTotal(okState(1n), null, priceLoading)).toMatchObject({ totalUsd: null, totalStatus: "loading" });
  });

  it("PRL + WPRL at price", () => {
    const t = deriveTotal(okState(200_000_000n), okState(100_000_000n), okState(1.5));
    expect(t.totalUsd).toBeCloseTo(4.5);
    expect(t.totalStatus).toBe("ok");
  });

  it("WPRL unknown while enabled → total is partial (PRL only)", () => {
    const wprlErr: AssetState<bigint> = { value: null, status: "error", stale: false, updatedAt: null };
    const t = deriveTotal(okState(200_000_000n), wprlErr, okState(1.5));
    expect(t.totalUsd).toBeCloseTo(3);
    expect(t.totalStatus).toBe("partial");
  });

  it("stale component → totalStale", () => {
    const stalePrice: AssetState<number> = { value: 2, status: "ok", stale: true, updatedAt: 1 };
    expect(deriveTotal(okState(100_000_000n), null, stalePrice).totalStale).toBe(true);
  });
});

// ─── Send live walk honesty ──────────────────────────────────────────────

describe("composePearlSend live walk", () => {
  it("every address unreadable → E_UTXO_SCAN_INCOMPLETE, not E_NO_UTXOS", async () => {
    stubPearl({}, [A, B]);
    await expect(
      composePearlSend({
        network: "mainnet",
        pool: [A, B],
        destination: "prl1pdest",
        amountGrains: 100_000_000n,
        includeTip: false,
      }),
    ).rejects.toThrow(/E_UTXO_SCAN_INCOMPLETE/);
  });

  it("all addresses readable and empty → still E_NO_UTXOS", async () => {
    stubPearl({});
    await expect(
      composePearlSend({
        network: "mainnet",
        pool: [A, B],
        destination: "prl1pdest",
        amountGrains: 100_000_000n,
        includeTip: false,
      }),
    ).rejects.toThrow(/E_NO_UTXOS/);
  });
});
