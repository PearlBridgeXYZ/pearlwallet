// Unit tests for the Pearl RPC client.
//
// Live integration tests against rpc.pearlwallet.xyz are in
// pearl-rpc-live.test.ts (gated behind PEARL_LIVE=1).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchPrlBalanceGrains } from "../src/services/pearl-rpc";
import { useUI } from "../src/state/ui-store";

const ADDR = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchPrlBalanceGrains — UTXO walk", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 for an empty page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({
      jsonrpc: "2.0", id: 1, result: [], error: null,
    })));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal.grains).toBe(0n);
    expect(bal.degraded).toBe(false);
  });

  it("returns 0 when RPC reports -5 'No information available about address'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({
      jsonrpc: "2.0", id: 1, result: null,
      error: { code: -5, message: "No information available about address" },
    })));
    expect((await fetchPrlBalanceGrains(ADDR)).grains).toBe(0n);
  });

  it("sums a single unspent output", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResp({ result: [{
          txid: "aa".repeat(32),
          vin: [{ txid: "bb".repeat(32), vout: 0 }],
          vout: [{ value: 12.34567891, n: 0, scriptPubKey: { address: ADDR, hex: "5120" + "00".repeat(32) } }],
        }], error: null });
      }
      return jsonResp({ result: [], error: null });
    }));
    const bal = await fetchPrlBalanceGrains(ADDR);
    // 12.34567891 PRL = 1234567891 grains
    expect(bal.grains).toBe(1_234_567_891n);
    expect(bal.degraded).toBe(false);
  });

  it("subtracts spent UTXOs", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResp({ result: [
          // tx1 pays our address 10 PRL at vout 0
          { txid: "11".repeat(32), vin: [], vout: [
            { value: 10.0, n: 0, scriptPubKey: { address: ADDR, hex: "5120" + "00".repeat(32) } },
          ] },
          // tx2 spends tx1:0 as input — so the 10 PRL UTXO is gone
          { txid: "22".repeat(32),
            vin: [{ txid: "11".repeat(32), vout: 0 }],
            vout: [{ value: 5.0, n: 0, scriptPubKey: { address: ADDR, hex: "5120" + "00".repeat(32) } }] },
        ], error: null });
      }
      return jsonResp({ result: [], error: null });
    }));
    // Remaining UTXO: tx2:0 = 5 PRL = 500_000_000 grains
    expect((await fetchPrlBalanceGrains(ADDR)).grains).toBe(500_000_000n);
  });

  it("handles addresses[] (multisig-shape) on the scriptPubKey", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      if (call === 1) return jsonResp({ result: [{
        txid: "ff".repeat(32),
        vin: [],
        vout: [{ value: 1.0, n: 0, scriptPubKey: { addresses: [ADDR, "prl1pother…"], hex: "5120" + "01".repeat(32) } }],
      }], error: null });
      return jsonResp({ result: [], error: null });
    }));
    expect((await fetchPrlBalanceGrains(ADDR)).grains).toBe(100_000_000n);
  });

  it("paginates through multiple pages of 100 txs", async () => {
    const PAGE = 100;
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      if (call === 1) {
        // 100 txs each crediting 1 PRL — full page → fetch next page
        const txs = Array.from({ length: PAGE }, (_, i) => ({
          txid: i.toString(16).padStart(64, "0"),
          vin: [],
          vout: [{ value: 1.0, n: 0, scriptPubKey: { address: ADDR, hex: "5120" + "00".repeat(32) } }],
        }));
        return jsonResp({ result: txs, error: null });
      }
      // empty page → loop terminates
      return jsonResp({ result: [], error: null });
    }));
    expect((await fetchPrlBalanceGrains(ADDR)).grains).toBe(100n * 100_000_000n);
  });

  it("throws on non-recoverable RPC errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({
      result: null, error: { code: -32601, message: "Method not found" },
    })));
    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow(/Method not found/);
  });
});

describe("rpcUrl override settability", () => {
  it("an empty override uses the default endpoint", async () => {
    useUI.getState().setPearlRpcOverride("");
    const mock = vi.fn(async () => jsonResp({ result: [], error: null }));
    vi.stubGlobal("fetch", mock);
    await fetchPrlBalanceGrains(ADDR);
    expect(mock).toHaveBeenCalled();
    const url = (mock.mock.calls[0]![0] as string);
    expect(url).toBe("https://rpc.pearlwallet.xyz/");
    vi.restoreAllMocks();
  });

  it("a custom override (allowlisted host) is used for subsequent calls", async () => {
    // v0.1.8 added an allowlist to setPearlRpcOverride. The override
    // path is still settable for users who run their own sentry on the
    // allowlisted host with a path prefix.
    useUI.getState().setPearlRpcOverride("https://rpc.pearlwallet.xyz/v2");
    const mock = vi.fn(async () => jsonResp({ result: [], error: null }));
    vi.stubGlobal("fetch", mock);
    await fetchPrlBalanceGrains(ADDR);
    const url = (mock.mock.calls[0]![0] as string);
    expect(url).toBe("https://rpc.pearlwallet.xyz/v2");
    // Reset for other tests.
    useUI.getState().setPearlRpcOverride("");
    vi.restoreAllMocks();
  });
});
