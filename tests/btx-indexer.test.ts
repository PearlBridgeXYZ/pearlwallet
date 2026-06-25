import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchBtxBalance,
  fetchBtxUtxos,
  BtxAddressError,
  _resetBtxIndexerCooldowns,
} from "../src/services/btx-indexer";

const ADDR = "btx1zhk7rx5psazv66jcgmaqdktwv357mgwdeu39pqxmfjy2gk0pctueq2vqd6e";

function mockFetchSeq(handlers: Array<(url: string) => { status: number; body?: unknown }>) {
  let i = 0;
  return vi.fn(async (url: string) => {
    const h = handlers[Math.min(i++, handlers.length - 1)];
    const { status, body } = h(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
}

describe("btx-indexer client", () => {
  beforeEach(() => _resetBtxIndexerCooldowns());
  afterEach(() => vi.restoreAllMocks());

  it("parses balance into bigint sat", async () => {
    vi.stubGlobal("fetch", mockFetchSeq([() => ({ status: 200, body: { address: ADDR, confirmed_sat: 42236934526, utxo_count: 22, tip: 140884 } })]));
    const b = await fetchBtxBalance(ADDR);
    expect(b.confirmedSat).toBe(42236934526n);
    expect(b.utxoCount).toBe(22);
    expect(b.tip).toBe(140884);
  });

  it("parses utxos with bigint values", async () => {
    vi.stubGlobal("fetch", mockFetchSeq([() => ({ status: 200, body: [
      { txid: "aa", vout: 0, value_sat: 2000000000, height: 122228, coinbase: true, confirmations: 18000 },
    ] })]));
    const u = await fetchBtxUtxos(ADDR);
    expect(u).toHaveLength(1);
    expect(u[0].valueSat).toBe(2000000000n);
    expect(u[0].coinbase).toBe(true);
  });

  it("does NOT rotate on 400 — surfaces a deterministic address error", async () => {
    const fetchMock = mockFetchSeq([() => ({ status: 400, body: { error: "invalid" } })]);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchBtxBalance("btx1zbad")).rejects.toBeInstanceOf(BtxAddressError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one endpoint, no rotation
  });

  it("rotates past a 5xx endpoint to a healthy one", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({ address: ADDR, confirmed_sat: 100, utxo_count: 1, tip: 5 }) } as Response;
    }));
    const b = await fetchBtxBalance(ADDR);
    expect(b.confirmedSat).toBe(100n);
    expect(calls).toBe(2); // rotated once
  });
});
