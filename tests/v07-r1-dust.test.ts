// v0.7 R1 FX3 (Grok G7 / Sonnet F7) and FX4 (Sonnet F16): dust and fee
// input rules for the vault composer and the offline manual composer, the
// same rules as single-sig Send (composePearlSend).

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { composeVaultSend } from "../src/services/multisig";
import * as pearlRpc from "../src/services/pearl-rpc";
import { DUST_LIMIT_GRAINS } from "../src/services/pearl-tx";
import { planManualSpend } from "../src/lib/offline-signing/manual-utxo";
import { vaultDustMessage } from "../src/ui/pages/SendFromVault";
import type { VaultRecord } from "../src/storage/db";

afterEach(() => vi.restoreAllMocks());

const vault = { id: "v1", pearlAddress: "prl1pvault" } as unknown as VaultRecord;
const DEST = "prl1pdest";

describe("FX3 — vault sends refuse a destination output at or below dust", () => {
  it.each([1n, 100n, DUST_LIMIT_GRAINS])("amount %s grains → E_AMOUNT_DUST before any network read", async (amount) => {
    // Never a real network read: a coin walk that got this far fails loudly.
    const walk = vi.spyOn(pearlRpc, "fetchPrlUtxos").mockRejectedValue(new Error("E_REACHED_SELECTION"));
    await expect(composeVaultSend({ vault, destination: DEST, amountGrains: amount })).rejects.toThrow("E_AMOUNT_DUST");
    expect(walk).not.toHaveBeenCalled();
  });

  it("one grain above dust proceeds to coin selection", async () => {
    const walk = vi.spyOn(pearlRpc, "fetchPrlUtxos").mockRejectedValue(new Error("E_REACHED_SELECTION"));
    await expect(
      composeVaultSend({ vault, destination: DEST, amountGrains: DUST_LIMIT_GRAINS + 1n }),
    ).rejects.toThrow("E_REACHED_SELECTION");
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it("SendFromVault shows Send PRL's dust copy", () => {
    expect(vaultDustMessage()).toBe("Amount is too small: the network won't relay a payment of 0.00000546 PRL or less.");
  });
});

describe("FX4 — offline manual composer: dust, fee input and change", () => {
  const base = { totalInGrains: 100_000n, dustLimitGrains: DUST_LIMIT_GRAINS };

  it("refuses a destination amount at or below dust with a readable message", () => {
    expect(() => planManualSpend({ ...base, amountGrains: DUST_LIMIT_GRAINS, feeInput: "200" })).toThrow(
      /Amount is too small: the network won't relay a payment of 0\.00000546 PRL or less\./,
    );
    expect(() => planManualSpend({ ...base, amountGrains: 1n, feeInput: "200" })).toThrow(/Amount is too small/);
  });

  it.each(["1.5", "-1", "1e3", "0x10", "12 grains", " 1 2 "])("fee %j → 'Fee must be a whole number of grains' (no raw SyntaxError)", (fee) => {
    let err: unknown;
    try {
      planManualSpend({ ...base, amountGrains: 10_000n, feeInput: fee });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toBe("Fee must be a whole number of grains");
  });

  it("accepts digits (and empty = 0)", () => {
    expect(planManualSpend({ ...base, amountGrains: 10_000n, feeInput: " 300 " })).toEqual({ feeGrains: 300n, changeGrains: 89_700n });
    expect(planManualSpend({ ...base, amountGrains: 100_000n, feeInput: "" })).toEqual({ feeGrains: 0n, changeGrains: 0n });
  });

  it("change below dust is not created: it is paid as fee (inputs = outputs + fee)", () => {
    const p = planManualSpend({ ...base, amountGrains: 99_000n, feeInput: "500" }); // change 500 < 546
    expect(p).toEqual({ feeGrains: 1_000n, changeGrains: 0n });
    expect(99_000n + p.changeGrains + p.feeGrains).toBe(base.totalInGrains);
    // At the dust limit a change output is created.
    expect(planManualSpend({ ...base, amountGrains: 98_954n, feeInput: "500" })).toEqual({ feeGrains: 500n, changeGrains: 546n });
  });

  it("insufficient inputs are still refused", () => {
    expect(() => planManualSpend({ ...base, amountGrains: 99_900n, feeInput: "200" })).toThrow(/^Insufficient: inputs 0\.001 PRL/);
  });

  it("OfflineSign's manual composer uses the planner, never a raw BigInt of the fee input", () => {
    const page = readFileSync("src/ui/pages/OfflineSign.tsx", "utf8");
    expect(page).toMatch(/planManualSpend\(\{[\s\S]*?dustLimitGrains: DUST_LIMIT_GRAINS,/);
    expect(page).not.toMatch(/BigInt\(feeGrainsInput/);
  });

  it("SendFromVault refuses dust before composing", () => {
    const page = readFileSync("src/ui/pages/SendFromVault.tsx", "utf8");
    const check = page.indexOf("if (grains <= DUST_LIMIT_GRAINS) {");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(page.indexOf("await composeVaultSend("));
  });
});
