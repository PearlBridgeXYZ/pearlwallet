import { describe, it, expect, vi, afterEach } from "vitest";
import { broadcastBtxTx, BtxBroadcastReject, planBtxSpend } from "../src/services/btx-send";
import { p2mrScriptPubKey } from "../src/chains/btx/tx";
import type { BtxUtxo } from "../src/services/btx-indexer";

const ADDR = "btx1zj2f5nmhzqlf007snw0h563lrsalm2s6r0damwuzs7272hnlh4yjqvgw2fs";
const TXID = "a".repeat(64);

afterEach(() => vi.restoreAllMocks());

describe("broadcastBtxTx pool rotation", () => {
  it("returns the txid on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ result: TXID }) }) as unknown as Response));
    expect(await broadcastBtxTx("00")).toBe(TXID);
  });

  it("surfaces a node reject immediately (does NOT rotate)", async () => {
    const f = vi.fn(async () => ({ status: 200, json: async () => ({ error: { message: "bad-txns-inputs-missingorspent" } }) }) as unknown as Response);
    vi.stubGlobal("fetch", f);
    await expect(broadcastBtxTx("00")).rejects.toBeInstanceOf(BtxBroadcastReject);
    expect(f).toHaveBeenCalledTimes(1); // no rotation on a deterministic reject
  });

  it("rotates past a non-JSON 5xx (HTML error page) to a healthy endpoint", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) return { status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response;
      return { status: 200, json: async () => ({ result: TXID }) } as unknown as Response;
    }));
    expect(await broadcastBtxTx("00")).toBe(TXID);
    expect(n).toBeGreaterThan(1); // rotated past the HTML 5xx
  });
});

describe("planBtxSpend coin selection", () => {
  const from = ADDR;
  const utxos: BtxUtxo[] = [
    { txid: "11".repeat(32), vout: 0, valueSat: 100_000_000n, height: 1, coinbase: false, confirmations: 10 },
    { txid: "22".repeat(32), vout: 0, valueSat: 50_000_000n, height: 2, coinbase: false, confirmations: 10 },
  ];

  it("selects inputs, all bound to the from-address scriptPubKey", () => {
    const plan = planBtxSpend(from, utxos, ADDR, 30_000_000n);
    const ownSpk = p2mrScriptPubKey(from);
    for (const i of plan.ins) expect(i.scriptPubKey).toEqual(ownSpk);
    expect(plan.feeSat).toBeGreaterThan(0n);
    // value conservation: inputs = amount + fee + change
    const inSum = plan.ins.reduce((s, i) => s + i.valueSat, 0n);
    const outSum = plan.outs.reduce((s, o) => s + o.valueSat, 0n);
    expect(inSum).toBe(outSum + plan.feeSat);
  });

  it("throws on insufficient funds", () => {
    expect(() => planBtxSpend(from, utxos, ADDR, 999_000_000n)).toThrow(/insufficient/);
  });

  it("rejects a non-positive amount", () => {
    expect(() => planBtxSpend(from, utxos, ADDR, 0n)).toThrow();
  });
});
