// v0.1.13 — activity scanner. Classifies pool-touched Pearl txs as in/out
// and pulls WPRL Transfer logs via viem. Covers:
//   - Pearl: in / out / self-spend skip / cross-address dedupe / partial source on per-addr failure / 5xx retry succeeds (v0.1.14)
//   - WPRL: in / out / self-transfer collapse to out / source error on RPC throw
//   - Merge: combined items sorted by timeSec descending and trimmed to `limit`

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchActivity } from "../src/services/activity";
import * as ethRpc from "../src/chains/ethereum/rpc";

const POOL = ["prl1pAAA", "prl1pBBB"];
const ETH_ADDR = "0x0000000000000000000000000000000000000001" as const;
const PEER_PRL = "prl1pPEER";
const PEER_ETH = "0x0000000000000000000000000000000000000099";
const WPRL = "0x07696DcaB55E62cfef953666b29Fe1970518cB00";

// ─── Pearl fetch mock ─────────────────────────────────────────────────────
// Tests script the sentry's responses on a per-address basis. The mock
// reads the request body, finds the `address` in the searchrawtransactions
// params, and returns whatever the test queued for that address.

type AddrResponses = Record<string, unknown[]>;

let queued: AddrResponses = {};
let pearlForceError: string | null = null;
// Per-address transient 5xx counter. Used by the v0.1.14 retry test:
// the mock returns 503 for the first N calls on a given address, then
// flips back to normal. Proves the retry layer absorbs transient sentry
// overload without flagging pearlSource='partial'.
let pearlTransient5xx: Record<string, number> = {};
let originalFetch: typeof globalThis.fetch;

function mockFetchOnce(
  responses: AddrResponses,
  forceErrorAddr?: string,
  transient5xx: Record<string, number> = {},
) {
  queued = responses;
  pearlForceError = forceErrorAddr ?? null;
  pearlTransient5xx = { ...transient5xx };
}

beforeEach(() => {
  vi.restoreAllMocks();
  originalFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.method !== "searchrawtransactions") {
      return new Response(JSON.stringify({ result: null, error: { code: -32601, message: "method not found" } }));
    }
    const addr = body.params[0] as string;
    if (pearlForceError && addr === pearlForceError) {
      return new Response("", { status: 503 });
    }
    if ((pearlTransient5xx[addr] ?? 0) > 0) {
      pearlTransient5xx[addr] = (pearlTransient5xx[addr] ?? 0) - 1;
      return new Response("", { status: 503 });
    }
    const result = queued[addr] ?? [];
    return new Response(JSON.stringify({ result, error: null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function rawTx(
  txid: string,
  opts: {
    vin?: Array<{ txid?: string; vout?: number }>;
    vout?: Array<{ value: number; address: string }>;
    time?: number;
  } = {},
) {
  return {
    txid,
    vin: (opts.vin ?? []).map((v) => ({ txid: v.txid, vout: v.vout })),
    vout: (opts.vout ?? []).map((v, n) => ({
      value: v.value,
      n,
      scriptPubKey: { address: v.address },
    })),
    time: opts.time ?? 0,
  };
}

// ─── Pearl classification tests ───────────────────────────────────────────

describe("v0.1.13 / activity — Pearl classification", () => {
  it("classifies an incoming Pearl tx (peer → us) as 'in' with received sum", async () => {
    // Pool addr A receives 1.5 PRL from peer in tx T1.
    mockFetchOnce({
      [POOL[0]!]: [
        rawTx("T1", { vout: [{ value: 1.5, address: POOL[0]! }], time: 1_700_000_000 }),
      ],
      [POOL[1]!]: [],
    });
    // No WPRL — viem doesn't get called when no logs. Spy ethClient to throw if invoked unexpectedly.
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(result.pearlSource).toBe("live");
    const pearlItems = result.items.filter((i) => i.chain === "pearl");
    expect(pearlItems).toHaveLength(1);
    expect(pearlItems[0]!.direction).toBe("in");
    expect(pearlItems[0]!.amount).toBe(150_000_000n);  // 1.5 PRL in grains
    expect(pearlItems[0]!.txid).toBe("T1");
  });

  it("classifies an outgoing Pearl tx (we spend our utxo) as 'out' with non-pool sum", async () => {
    // Pool addr A first received tx T0 (paying us 5 PRL).
    // Then in tx T1, that vout (T0:0) is spent; outputs are 3 PRL to peer
    // and 1.9 PRL change back to pool addr B.
    mockFetchOnce({
      [POOL[0]!]: [
        rawTx("T1", {
          vin: [{ txid: "T0", vout: 0 }],
          vout: [
            { value: 3.0, address: PEER_PRL },
            { value: 1.9, address: POOL[1]! },
          ],
          time: 1_700_001_000,
        }),
        rawTx("T0", {
          vout: [{ value: 5.0, address: POOL[0]! }],
          time: 1_699_000_000,
        }),
      ],
      [POOL[1]!]: [
        // addr B also sees T1 because it receives change.
        rawTx("T1", {
          vin: [{ txid: "T0", vout: 0 }],
          vout: [
            { value: 3.0, address: PEER_PRL },
            { value: 1.9, address: POOL[1]! },
          ],
          time: 1_700_001_000,
        }),
      ],
    });
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    const pearlItems = result.items.filter((i) => i.chain === "pearl");
    // Two unique txids: T0 (in) and T1 (out). Dedupe across pool addresses
    // for T1.
    expect(pearlItems).toHaveLength(2);
    const t1 = pearlItems.find((i) => i.txid === "T1")!;
    expect(t1.direction).toBe("out");
    // "leaving" = vouts to non-pool addresses = 3 PRL (the 1.9 to pool[1] is change).
    expect(t1.amount).toBe(300_000_000n);
    expect(t1.counterparty).toBe(PEER_PRL);
    const t0 = pearlItems.find((i) => i.txid === "T0")!;
    expect(t0.direction).toBe("in");
    expect(t0.amount).toBe(500_000_000n);
  });

  it("skips a self-spend (all outputs back to pool) — pool consolidation isn't activity", async () => {
    // T0 funds pool[0] with 2 PRL. T1 spends T0:0 entirely back to pool[1].
    mockFetchOnce({
      [POOL[0]!]: [
        rawTx("T1", {
          vin: [{ txid: "T0", vout: 0 }],
          vout: [{ value: 1.95, address: POOL[1]! }],  // 0.05 PRL fee
          time: 1_700_002_000,
        }),
        rawTx("T0", {
          vout: [{ value: 2.0, address: POOL[0]! }],
          time: 1_699_000_000,
        }),
      ],
      [POOL[1]!]: [
        rawTx("T1", {
          vin: [{ txid: "T0", vout: 0 }],
          vout: [{ value: 1.95, address: POOL[1]! }],
          time: 1_700_002_000,
        }),
      ],
    });
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    const pearlItems = result.items.filter((i) => i.chain === "pearl");
    // T1 is filtered (self-spend), only T0 (in) remains.
    expect(pearlItems).toHaveLength(1);
    expect(pearlItems[0]!.txid).toBe("T0");
    expect(pearlItems[0]!.direction).toBe("in");
  });

  it("marks pearlSource='partial' when a pool address errors but the rest succeed", async () => {
    mockFetchOnce(
      {
        [POOL[0]!]: [rawTx("T_in", { vout: [{ value: 1.0, address: POOL[0]! }], time: 1 })],
        [POOL[1]!]: [],
      },
      POOL[1]!,  // forces 503 on addr B
    );
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(result.pearlSource).toBe("partial");
    expect(result.items.filter((i) => i.chain === "pearl")).toHaveLength(1);
  });

  // v0.1.14 hotfix: under concurrent load the public sentry emits
  // transient nginx 503s on otherwise healthy pool addresses. Without
  // the 3-attempt retry mirror, a single 503 would flip the pool walk
  // to 'partial' and surface "sentry errors on some addresses" to users
  // with a perfectly fine wallet. With the retry, 2 transient 5xx
  // followed by a 200 must round-trip live without raising 'partial'.
  it("retries transient 5xx and keeps pearlSource='live' when sentry recovers", async () => {
    mockFetchOnce(
      {
        [POOL[0]!]: [rawTx("T_in", { vout: [{ value: 1.0, address: POOL[0]! }], time: 1 })],
        [POOL[1]!]: [rawTx("T_in2", { vout: [{ value: 0.5, address: POOL[1]! }], time: 2 })],
      },
      undefined,
      { [POOL[1]!]: 2 },  // POOL[1] flaps 503 twice then succeeds
    );
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(result.pearlSource).toBe("live");
    expect(result.items.filter((i) => i.chain === "pearl")).toHaveLength(2);
  });
});

// ─── WPRL classification ──────────────────────────────────────────────────

describe("v0.1.13 / activity — WPRL classification", () => {
  it("classifies out logs as 'out' and in logs as 'in'", async () => {
    mockFetchOnce({ [POOL[0]!]: [], [POOL[1]!]: [] });
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async ({ args }: any) => {
        if (args.from === ETH_ADDR) {
          return [{
            transactionHash: "0xOUT1",
            blockNumber: 18_000_000n - 10n,
            args: { from: ETH_ADDR, to: PEER_ETH, value: 1_000_000_000_000_000_000n },
          }];
        }
        if (args.to === ETH_ADDR) {
          return [{
            transactionHash: "0xIN1",
            blockNumber: 18_000_000n - 5n,
            args: { from: PEER_ETH, to: ETH_ADDR, value: 5_000_000_000_000_000_000n },
          }];
        }
        return [];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlock: async () => ({ timestamp: 1_700_100_000n }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(result.wprlSource).toBe("live");
    const wprlItems = result.items.filter((i) => i.chain === "wprl");
    expect(wprlItems).toHaveLength(2);
    const out = wprlItems.find((i) => i.txid === "0xOUT1")!;
    const inn = wprlItems.find((i) => i.txid === "0xIN1")!;
    expect(out.direction).toBe("out");
    expect(out.amount).toBe(1_000_000_000_000_000_000n);
    expect(out.counterparty).toBe(PEER_ETH);
    expect(inn.direction).toBe("in");
    expect(inn.amount).toBe(5_000_000_000_000_000_000n);
    expect(inn.counterparty).toBe(PEER_ETH);
  });

  it("collapses self-transfer to a single 'out' item (user perspective)", async () => {
    mockFetchOnce({ [POOL[0]!]: [], [POOL[1]!]: [] });
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async ({ args }: any) => {
        // Same tx hash shows up on both filters when user sends to self.
        if (args.from === ETH_ADDR || args.to === ETH_ADDR) {
          return [{
            transactionHash: "0xSELF",
            blockNumber: 18_000_000n - 1n,
            args: { from: ETH_ADDR, to: ETH_ADDR, value: 42n },
          }];
        }
        return [];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlock: async () => ({ timestamp: 1_700_200_000n }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    const wprlItems = result.items.filter((i) => i.chain === "wprl");
    expect(wprlItems).toHaveLength(1);
    expect(wprlItems[0]!.direction).toBe("out");
    expect(wprlItems[0]!.txid).toBe("0xSELF");
  });

  it("marks wprlSource='error' when the Eth RPC throws on getBlockNumber", async () => {
    mockFetchOnce({ [POOL[0]!]: [], [POOL[1]!]: [] });
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => { throw new Error("network down"); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 10);
    expect(result.wprlSource).toBe("error");
    expect(result.items.filter((i) => i.chain === "wprl")).toHaveLength(0);
  });

  it("skips the WPRL scan entirely when the contract address is zeroed (e.g. sepolia)", async () => {
    mockFetchOnce({ [POOL[0]!]: [], [POOL[1]!]: [] });
    // ethClient should NOT be called at all on the zero-address path.
    const ethSpy = vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => { throw new Error("should not be called"); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "sepolia", 10);
    expect(result.wprlSource).toBe("live");
    expect(result.items.filter((i) => i.chain === "wprl")).toHaveLength(0);
    expect(ethSpy).not.toHaveBeenCalled();
  });
});

// ─── Merge + trim ─────────────────────────────────────────────────────────

describe("v0.1.13 / activity — merge + sort + trim", () => {
  it("returns items sorted by timeSec descending, then trims to `limit`", async () => {
    // Three Pearl txs, three WPRL logs, limit 4 → top 4 by time.
    mockFetchOnce({
      [POOL[0]!]: [
        rawTx("PA", { vout: [{ value: 1, address: POOL[0]! }], time: 100 }),
        rawTx("PB", { vout: [{ value: 1, address: POOL[0]! }], time: 300 }),
        rawTx("PC", { vout: [{ value: 1, address: POOL[0]! }], time: 500 }),
      ],
      [POOL[1]!]: [],
    });
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlockNumber: async () => 18_000_000n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async ({ args }: any) => {
        if (args.to === ETH_ADDR) {
          return [
            { transactionHash: "0xW1", blockNumber: 1n, args: { from: PEER_ETH, to: ETH_ADDR, value: 1n } },
            { transactionHash: "0xW2", blockNumber: 2n, args: { from: PEER_ETH, to: ETH_ADDR, value: 1n } },
            { transactionHash: "0xW3", blockNumber: 3n, args: { from: PEER_ETH, to: ETH_ADDR, value: 1n } },
          ];
        }
        return [];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlock: async ({ blockNumber }: any) => ({ timestamp: BigInt(200 + Number(blockNumber) * 100) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await fetchActivity(POOL, ETH_ADDR, "mainnet", 4);
    expect(result.items).toHaveLength(4);
    // Most-recent first.
    const times = result.items.map((i) => i.timeSec);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

// Suppress unused-import warning for symbols imported only for type contracts.
void WPRL;
