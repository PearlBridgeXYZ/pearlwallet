// Pool-aggregation tests for fetchBalances.
//
// Pearl L1 is UTXO and an HD wallet may hold balances at any of its
// derived receive indexes — fetchBalances must accept the full pool and
// sum across it. A regression here would surface as "missing" funds
// after a restore.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchBalances } from "../src/services/balances";
import { useUI } from "../src/state/ui-store";

const POOL = [
  "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs",
  "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
  "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm",
];
const ETH = "0x0000000000000000000000000000000000000001";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchBalances — Pearl pool aggregation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sums grains across every address in the pool", async () => {
    // Each address gets one credit of N PRL, where N matches its 1-based
    // position. Total = (1 + 2 + 3) PRL = 6 PRL = 600_000_000 grains.
    const credits: Record<string, number> = {
      [POOL[0]!]: 1.0,
      [POOL[1]!]: 2.0,
      [POOL[2]!]: 3.0,
    };
    const seenSearchRaw = new Set<string>();

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      // Pearl RPC: searchrawtransactions returns credits then [] terminator.
      if (u.startsWith("https://rpc.pearlwallet.xyz")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method: string;
          params: unknown[];
        };
        if (body.method === "searchrawtransactions") {
          const addr = body.params[0] as string;
          const skip = body.params[2] as number;
          // First call (skip=0) returns the credit; subsequent calls empty.
          if (skip === 0 && credits[addr] !== undefined) {
            seenSearchRaw.add(addr);
            return jsonResp({
              result: [{
                txid: addr.slice(-32).padStart(64, "0"),
                vin: [],
                vout: [{ value: credits[addr], n: 0, scriptPubKey: { address: addr, hex: "5120" + "00".repeat(32) } }],
              }],
              error: null,
            });
          }
          return jsonResp({ result: [], error: null });
        }
      }
      // WPRL balance — return zero.
      // Price — return a fixed USD/PRL.
      // Both default to 0 in the catch-all below.
      return jsonResp({ result: "0x0", error: null });
    }));

    const out = await fetchBalances(POOL, ETH);
    expect(out.prl).toBe(600_000_000n);
    expect(out.prlSource).toBe("live");
    // Every pool address was queried.
    expect(seenSearchRaw.size).toBe(POOL.length);
    for (const a of POOL) expect(seenSearchRaw.has(a)).toBe(true);
  });

  it("accepts a single string (legacy single-address callers)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://rpc.pearlwallet.xyz")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
        if (body.method === "searchrawtransactions") {
          const skip = body.params[2] as number;
          if (skip === 0) {
            return jsonResp({
              result: [{
                txid: "aa".repeat(32),
                vin: [],
                vout: [{ value: 7.0, n: 0, scriptPubKey: { address: POOL[0], hex: "5120" + "00".repeat(32) } }],
              }],
              error: null,
            });
          }
          return jsonResp({ result: [], error: null });
        }
      }
      return jsonResp({ result: "0x0", error: null });
    }));

    const out = await fetchBalances(POOL[0]!, ETH);
    expect(out.prl).toBe(700_000_000n);
    expect(out.prlSource).toBe("live");
  });

  it("tolerates a single transient failure (returns the sum of the rest)", async () => {
    // One address out of three returns a JSON-RPC error; pool walk
    // tolerates it and reports the sum across the addresses that did
    // succeed. This matches the live behavior where the sentry
    // occasionally 503s a single request under burst load — we don't
    // want a one-shot blip to hide real balances.
    const credits: Record<string, number> = {
      [POOL[0]!]: 4.0,
      [POOL[2]!]: 5.0,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://rpc.pearlwallet.xyz")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
        if (body.method === "searchrawtransactions") {
          const addr = body.params[0] as string;
          const skip = body.params[2] as number;
          if (addr === POOL[1]) {
            return jsonResp({ result: null, error: { code: -32601, message: "Method not found" } });
          }
          if (skip === 0 && credits[addr] !== undefined) {
            return jsonResp({
              result: [{
                txid: addr.slice(-32).padStart(64, "0"),
                vin: [],
                vout: [{ value: credits[addr], n: 0, scriptPubKey: { address: addr, hex: "5120" + "00".repeat(32) } }],
              }],
              error: null,
            });
          }
          return jsonResp({ result: [], error: null });
        }
      }
      return jsonResp({ result: "0x0", error: null });
    }));

    const out = await fetchBalances(POOL, ETH);
    // v0.1.7: label partial walks explicitly so the UI can warn instead
    // of presenting a degraded sum as authoritative.
    expect(out.prlSource).toBe("partial");
    // 4.0 + 5.0 PRL = 900_000_000 grains. POOL[1] silently contributed 0.
    expect(out.prl).toBe(900_000_000n);
  });

  it("flips prlSource to 'error' if MORE than half the pool fails", async () => {
    // 2 of 3 (a majority) fail → balance is too suspect to surface.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://rpc.pearlwallet.xyz")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
        if (body.method === "searchrawtransactions") {
          const addr = body.params[0] as string;
          if (addr !== POOL[0]) {
            return jsonResp({ result: null, error: { code: -32601, message: "Method not found" } });
          }
          return jsonResp({ result: [], error: null });
        }
      }
      return jsonResp({ result: "0x0", error: null });
    }));
    const out = await fetchBalances(POOL, ETH);
    expect(out.prlSource).toBe("error");
    expect(out.prl).toBe(0n);
  });
});
