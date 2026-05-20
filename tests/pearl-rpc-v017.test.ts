// v0.1.7: tests for the C1 fix on pearl-rpc.ts —
//   (a) MAX_UTXO_WALK_PAGES cap stops a hostile sentry's infinite loop
//   (b) two-pass per-page walk resolves vin-before-vout same-page ordering
//
// The existing pearl-rpc.test.ts covers happy-path UTXO walks; this file
// targets the adversarial cases that drove v0.1.7's pearl-rpc changes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchPrlBalanceGrains, MAX_UTXO_WALK_PAGES } from "../src/services/pearl-rpc";
import { useUI } from "../src/state/ui-store";

const ADDR = "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("C1: MAX_UTXO_WALK_PAGES cap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports a sane cap (small enough to never let a malicious sentry hang a tab)", () => {
    expect(MAX_UTXO_WALK_PAGES).toBeGreaterThan(0);
    expect(MAX_UTXO_WALK_PAGES).toBeLessThanOrEqual(50);
  });

  it("throws E_UTXO_WALK_EXCEEDED when the sentry returns a full page forever", async () => {
    // Hostile sentry: returns PAGE-length results indefinitely. The
    // walker MUST stop after MAX_UTXO_WALK_PAGES pages — otherwise
    // we spin the tab at 100% CPU.
    const PAGE = 100;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      const txs = Array.from({ length: PAGE }, (_, i) => ({
        // unique txids per page so dedupe doesn't short-circuit us
        txid: `${calls.toString(16).padStart(4, "0")}${i.toString(16).padStart(60, "0")}`,
        vin: [],
        vout: [{ value: 0.00000001, n: 0, scriptPubKey: { address: ADDR } }],
      }));
      return jsonResp({ result: txs, error: null });
    }));

    await expect(fetchPrlBalanceGrains(ADDR)).rejects.toThrow("E_UTXO_WALK_EXCEEDED");
    // Sanity: walker called fetch at most MAX_UTXO_WALK_PAGES times
    // before bailing.
    expect(calls).toBeLessThanOrEqual(MAX_UTXO_WALK_PAGES + 1);
  });

  it("does NOT throw E_UTXO_WALK_EXCEEDED when the sentry sends fewer than PAGE on the first call", async () => {
    // Confirm the cap doesn't false-positive on normal use.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({
      result: [{
        txid: "aa".repeat(32),
        vin: [],
        vout: [{ value: 1.0, n: 0, scriptPubKey: { address: ADDR } }],
      }],
      error: null,
    })));
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal).toBe(100_000_000n);
  });
});

describe("C1: two-pass per-page walk (hostile vin-before-vout ordering)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUI.getState().setPearlRpcOverride("");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a spent UTXO on the same page is correctly debited even if the spending tx appears BEFORE the funding tx", async () => {
    // A hostile or buggy sentry reorders the page so the spending tx
    // appears first. Single-pass walk: vin debit no-ops (utxo unseen),
    // then vout credit lands → spent UTXO stays in balance (over-report).
    // Two-pass walk: all vouts credited first, then all vins debited →
    // final balance is correct.
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResp({ result: [
          // tx2 (spending) appears FIRST in the page — referencing tx1:0
          {
            txid: "22".repeat(32),
            vin: [{ txid: "11".repeat(32), vout: 0 }],
            vout: [
              { value: 7.0, n: 0, scriptPubKey: { address: ADDR } },
            ],
          },
          // tx1 (funding) appears SECOND — the UTXO it creates is the one
          // tx2 spent.
          {
            txid: "11".repeat(32),
            vin: [],
            vout: [
              { value: 10.0, n: 0, scriptPubKey: { address: ADDR } },
            ],
          },
        ], error: null });
      }
      return jsonResp({ result: [], error: null });
    }));

    // Remaining UTXO: tx2:0 (7 PRL). tx1:0 (10 PRL) was funded then
    // spent on the same page. Two-pass walk must yield 7 PRL, NOT 17.
    const bal = await fetchPrlBalanceGrains(ADDR);
    expect(bal).toBe(700_000_000n);
  });

  it("vouts that appear AFTER their spending vins on the same page are not double-spent", async () => {
    // Variation: the funding tx's vout pays a DIFFERENT address. The
    // spending tx's vout still credits ADDR. Two-pass walk must NOT
    // credit a non-ADDR vout just because of the page-order trick.
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResp({ result: [
          // Spending tx — references tx-funder:0, credits ADDR.
          {
            txid: "44".repeat(32),
            vin: [{ txid: "33".repeat(32), vout: 0 }],
            vout: [{ value: 2.0, n: 0, scriptPubKey: { address: ADDR } }],
          },
          // Funding tx — vout pays a third party, not us.
          {
            txid: "33".repeat(32),
            vin: [],
            vout: [{ value: 99.0, n: 0, scriptPubKey: { address: "prl1pother…" } }],
          },
        ], error: null });
      }
      return jsonResp({ result: [], error: null });
    }));
    expect(await fetchPrlBalanceGrains(ADDR)).toBe(200_000_000n);
  });

  it("multi-tx per page: every vout in the page is credited before any vin debits", async () => {
    // 3 txs:
    //  - tx-spend1 (first): spends tx-fund:0
    //  - tx-fund (second):  funds ADDR via vout 0 (5 PRL) and vout 1 (3 PRL)
    //  - tx-spend2 (third): spends tx-fund:1
    // Net to ADDR after the page: nothing left (both vouts spent). Two-
    // pass walk credits {tx-fund:0, tx-fund:1} then debits {tx-fund:0,
    // tx-fund:1} → 0. Single-pass walk would survive the second debit
    // but mis-handle the first.
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResp({ result: [
          {
            txid: "aa".repeat(32),
            vin: [{ txid: "bb".repeat(32), vout: 0 }],
            vout: [{ value: 0.1, n: 0, scriptPubKey: { address: "prl1pelsewhere…" } }],
          },
          {
            txid: "bb".repeat(32),
            vin: [],
            vout: [
              { value: 5.0, n: 0, scriptPubKey: { address: ADDR } },
              { value: 3.0, n: 1, scriptPubKey: { address: ADDR } },
            ],
          },
          {
            txid: "cc".repeat(32),
            vin: [{ txid: "bb".repeat(32), vout: 1 }],
            vout: [{ value: 0.1, n: 0, scriptPubKey: { address: "prl1pelsewhere…" } }],
          },
        ], error: null });
      }
      return jsonResp({ result: [], error: null });
    }));
    expect(await fetchPrlBalanceGrains(ADDR)).toBe(0n);
  });
});
