// R6 N3 (GPT-6 R3-A3, Sonnet F12; inherited) — an unwrap's burn is called
// failed only on positive evidence.
//
// Before: getEthReceiptStatus mapped every error to null, and pollUnwrap
// turned null + 30 minutes into phase "failed" with "likely dropped; your
// WPRL is untouched, retry" — for a burn still pending, or one already
// mined while the receipt RPC was down — and stopped polling it (only
// confirming / relay / review crossings are polled). Following the advice
// could burn a second time.
//
// Now getEthReceiptStatus tells "not-found" (the node has no receipt) from
// "lookup-failed" (RPC error), and only a reverted receipt is terminal.
// Otherwise the crossing stays open (still polled) with a "check the burn
// tx" notice, and the Activity card shows the burn hash with an Etherscan
// link, never "untouched" or "retry".
//
// Real pollUnwrap and getEthReceiptStatus, with the receipt RPC and the
// relay mocked (reproduction adapted from GPT-6's
// tests/reviewer-r3-burn-status.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TransactionReceiptNotFoundError } from "viem";
import { ActivityCard, BURN_NOT_MINED_NOTICE, BURN_STATUS_UNREADABLE_NOTICE, pollUnwrap } from "../src/ui/pages/Bridge";
import { getEthReceiptStatus } from "../src/services/eth-tx";
import * as ethRpc from "../src/chains/ethereum/rpc";
import * as bridgeApi from "../src/services/bridge-v1";
import { db, type BridgeCrossingRecord } from "../src/storage/db";

const HASH = `0x${"ab".repeat(32)}` as const;
const OPEN = ["confirming", "relay", "review"];
afterEach(() => vi.restoreAllMocks());

function crossing(ageMin: number, over: Partial<BridgeCrossingRecord> = {}): BridgeCrossingRecord {
  return {
    id: HASH, direction: "unwrap", amountGrains: "100000000", netGrains: "100000000", createdAt: Date.now() - ageMin * 60_000,
    phase: "relay", relayState: null, confirmations: 0, settledRef: null, approveTxHash: null, updatedAt: Date.now(), ...over,
  };
}
function setup(receipt: () => Promise<unknown>) {
  vi.spyOn(ethRpc, "ethClient").mockReturnValue({ getTransactionReceipt: vi.fn(receipt) } as never);
  vi.spyOn(bridgeApi, "fetchBurnStatus").mockResolvedValue({ state: null, pearlTxId: null, anomalyReason: null } as never);
  return vi.spyOn(db.bridgeCrossings, "update").mockResolvedValue(1);
}
const html = (c: BridgeCrossingRecord) =>
  renderToStaticMarkup(createElement(ActivityCard, { crossings: [c], requiredConfs: 6, ethNetwork: "mainnet" }));

describe("N3 — getEthReceiptStatus distinguishes no receipt from a failed lookup", () => {
  it("receipt not found → 'not-found'; HTTP 503 → 'lookup-failed'; receipts → their status", async () => {
    setup(async () => { throw new TransactionReceiptNotFoundError({ hash: HASH }); });
    expect(await getEthReceiptStatus("mainnet", HASH)).toBe("not-found");
    vi.restoreAllMocks();
    setup(async () => { throw new Error("HTTP 503 from mocked receipt RPC"); });
    expect(await getEthReceiptStatus("mainnet", HASH)).toBe("lookup-failed");
    vi.restoreAllMocks();
    setup(async () => ({ status: "reverted" }));
    expect(await getEthReceiptStatus("mainnet", HASH)).toBe("reverted");
  });
});

describe("N3 — pollUnwrap: only a reverted receipt makes the burn terminal", () => {
  for (const [label, receipt, notice] of [
    ["receipt not found (still pending)", async () => { throw new TransactionReceiptNotFoundError({ hash: HASH }); }, BURN_NOT_MINED_NOTICE],
    ["receipt RPC 503", async () => { throw new Error("HTTP 503 from mocked receipt RPC"); }, BURN_STATUS_UNREADABLE_NOTICE],
  ] as const) {
    it(`${label}, 31 minutes old → stays open (still polled) with a check notice; the card shows the burn tx + Etherscan, no 'untouched' / 'retry'`, async () => {
      const update = setup(receipt);
      const c = crossing(31);
      await pollUnwrap(c, "mainnet");
      const patch = update.mock.calls[0]![1] as Partial<BridgeCrossingRecord>;
      expect(patch.phase).toBeUndefined(); // unchanged: "relay"
      expect(OPEN).toContain({ ...c, ...patch }.phase);
      expect(patch.relayState).toBe(notice);
      const out = html({ ...c, ...patch });
      expect(out).toContain(HASH);
      expect(out).toContain(`https://etherscan.io/tx/${HASH}`);
      expect(out).toContain("do not unwrap again");
      expect(out).not.toMatch(/untouched|retry|Bridge processing/i);
    });
  }

  it("younger than 30 minutes: no notice yet, phase unchanged", async () => {
    const update = setup(async () => { throw new TransactionReceiptNotFoundError({ hash: HASH }); });
    await pollUnwrap(crossing(5), "mainnet");
    const patch = update.mock.calls[0]![1] as Partial<BridgeCrossingRecord>;
    expect(patch.phase).toBeUndefined();
    expect(patch.relayState).toBeUndefined();
  });

  it("reverted receipt → failed (positive evidence)", async () => {
    const update = setup(async () => ({ status: "reverted" }));
    await pollUnwrap(crossing(31), "mainnet");
    const patch = update.mock.calls[0]![1] as Partial<BridgeCrossingRecord>;
    expect(patch.phase).toBe("failed");
    expect(patch.relayState).toBe("burn tx reverted on-chain — WPRL not spent");
  });

  it("a later successful receipt clears the check notice (relay indexing lag)", async () => {
    const update = setup(async () => ({ status: "success" }));
    await pollUnwrap(crossing(45, { relayState: BURN_STATUS_UNREADABLE_NOTICE }), "mainnet");
    const patch = update.mock.calls[0]![1] as Partial<BridgeCrossingRecord>;
    expect(patch.phase).toBeUndefined();
    expect(patch.relayState).toBeNull();
  });
});
