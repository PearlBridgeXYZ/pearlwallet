// v0.4.3–v0.6.1 marked an unwrap "failed … likely dropped; your WPRL is
// untouched, retry" after 30 minutes with no evidence, and those rows were
// never polled again. They are reopened into the check state so polling
// settles them on real evidence.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BURN_NOT_MINED_NOTICE, isLegacyDroppedBurn, reopenLegacyDroppedBurns } from "../src/ui/pages/Bridge";
import * as walletStore from "../src/state/wallet-store";
import * as storage from "../src/storage/db";
import { db, type BridgeCrossingRecord } from "../src/storage/db";

afterEach(() => vi.restoreAllMocks());
const OLD = "burn tx not mined (~30m) — likely dropped; your WPRL is untouched, retry";
const row = (over: Partial<BridgeCrossingRecord>): BridgeCrossingRecord => ({
  id: `0x${"cd".repeat(32)}`, direction: "unwrap", amountGrains: "1", netGrains: "1", createdAt: 1,
  phase: "failed", relayState: OLD, confirmations: 0, settledRef: null, approveTxHash: null, updatedAt: 1, ...over,
});

describe("legacy 'likely dropped' unwraps are reopened", () => {
  it("matches only unwraps failed by the old heuristic", () => {
    expect(isLegacyDroppedBurn(row({}))).toBe(true);
    expect(isLegacyDroppedBurn(row({ relayState: "burn reverted on-chain" }))).toBe(false);
    expect(isLegacyDroppedBurn(row({ direction: "wrap" }))).toBe(false);
    expect(isLegacyDroppedBurn(row({ phase: "relay" }))).toBe(false);
  });

  it("reopens them as 'relay' with the check notice, through the wallet-bound write", async () => {
    const rows = [row({}), row({ id: `0x${"ee".repeat(32)}`, relayState: "burn reverted on-chain" })];
    vi.spyOn(db.bridgeCrossings, "where").mockReturnValue({ equals: () => ({ toArray: async () => rows }) } as never);
    vi.spyOn(walletStore, "sessionWalletPrimary").mockReturnValue("prl1ptest");
    const put = vi.spyOn(storage, "putBridgeCrossingForWallet").mockResolvedValue(true);
    expect(await reopenLegacyDroppedBurns()).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);
    const [rec, wallet] = put.mock.calls[0]!;
    expect(rec.phase).toBe("relay");
    expect(rec.relayState).toBe(BURN_NOT_MINED_NOTICE);
    expect(rec.id).toBe(rows[0]!.id);
    expect(wallet).toBe("prl1ptest");
  });
});
