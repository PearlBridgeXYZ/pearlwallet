// R6 N5 (Sonnet F07) — E_AMOUNT_DUST reads as the same sentence everywhere.
//
// Before: the offline-sign live composer and the Bridge wrap review showed
// composePearlSend's raw "E_AMOUNT_DUST" for an amount at or below dust;
// Send PRL (and Send from vault) said "Amount is too small: …".
// Now one helper (src/ui/pearl-messages.ts) maps it for all four.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dustAmountMessage, dustErrorMessage } from "../src/ui/pearl-messages";
import { vaultDustMessage } from "../src/ui/pages/SendFromVault";
import { composePearlSend } from "../src/services/pearl-tx";

const READABLE = "Amount is too small: the network won't relay a payment of 0.00000546 PRL or less.";

describe("N5 — the dust refusal is readable", () => {
  it("E_AMOUNT_DUST (as composePearlSend throws it) maps to Send PRL's sentence; other errors are not mapped", async () => {
    const err = await composePearlSend({ network: "mainnet", pool: ["prl1pme"], destination: "prl1pdest", amountGrains: 546n } as never).catch((e) => e);
    expect((err as Error).message).toBe("E_AMOUNT_DUST");
    expect(dustErrorMessage(err)).toBe(READABLE);
    expect(dustAmountMessage()).toBe(READABLE);
    expect(vaultDustMessage()).toBe(READABLE);
    expect(dustErrorMessage(new Error("E_NO_UTXOS"))).toBeNull();
  });

  it("the offline-sign composers, the Bridge wrap review and Send PRL use it", () => {
    const offline = readFileSync("src/ui/pages/OfflineSign.tsx", "utf8");
    expect(offline.match(/setError\(dustErrorMessage\(e\) \?\? /g)).toHaveLength(2);
    expect(readFileSync("src/ui/pages/Bridge.tsx", "utf8")).toContain("setErr(refusalMessage(e) ?? dustErrorMessage(e) ?? (e as Error).message)");
    expect(readFileSync("src/ui/pages/SendPRL.tsx", "utf8")).toContain("reason: dustAmountMessage()");
  });
});
