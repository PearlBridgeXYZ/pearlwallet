// v0.1.11 — sign-what-you-saw + fee-market ceiling. v0.1.9 audit cross-pass
// Highs: O2-H-1 ≡ M2-H-2 (preview→broadcast re-quote drift) and O1-H-1
// (hostile ETH RPC inflating baseFee).

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MAX_BASE_FEE_WEI,
  PREVIEW_FRESHNESS_MS,
  suggestGas,
  sendNative,
  sendWprl,
  type FrozenEthGas,
} from "../src/services/eth-tx";
import {
  PEARL_PREVIEW_FRESHNESS_MS,
  broadcastPearlPrecomposed,
  type ComposedPearlTx,
} from "../src/services/pearl-tx";
import * as ethRpc from "../src/chains/ethereum/rpc";
import * as pearlRpc from "../src/services/pearl-rpc";
import * as workerClient from "../src/crypto/worker-client";
import * as bridge from "../src/services/bridge";

// ─── O1-H-1: suggestGas clamps an absurd baseFeePerGas ────────────────────

describe("v0.1.11 / suggestGas — fee-market sanity ceiling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws E_ETH_FEE_MARKET_INSANE when baseFeePerGas exceeds the ceiling", async () => {
    const insane = MAX_BASE_FEE_WEI + 1n;
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlock: async () => ({ baseFeePerGas: insane }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await expect(suggestGas("mainnet", "normal")).rejects.toThrow(/E_ETH_FEE_MARKET_INSANE/);
  });

  it("accepts a baseFeePerGas right at the ceiling", async () => {
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlock: async () => ({ baseFeePerGas: MAX_BASE_FEE_WEI }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const fees = await suggestGas("mainnet", "low");
    expect(fees.maxFeePerGas).toBe(MAX_BASE_FEE_WEI * 2n + 1n * 1_000_000_000n);
  });

  it("returns normal values for a typical baseFee", async () => {
    const typical = 15n * 1_000_000_000n; // 15 gwei
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBlock: async () => ({ baseFeePerGas: typical }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const fees = await suggestGas("mainnet", "normal");
    expect(fees.maxFeePerGas).toBe(typical * 2n + 2n * 1_000_000_000n);
    expect(fees.maxPriorityFeePerGas).toBe(2_000_000_000n);
  });
});

// ─── O2-H-1 ≡ M2-H-2: ETH sign-what-you-saw + freshness ───────────────────

describe("v0.1.11 / sendNative — sign-what-you-saw", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips re-quote when given a fresh frozen preview", async () => {
    const getTxCount = vi.fn(async () => 7);
    const sendRawTx = vi.fn(async () => "0xdeadbeef");
    const getBlock = vi.fn(async () => ({ baseFeePerGas: 10n * 1_000_000_000n }));
    const estimateGas = vi.fn(async () => 21000n);
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      getTransactionCount: getTxCount,
      sendRawTransaction: sendRawTx,
      getBlock,
      estimateGas,
      chain: { id: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "0xraw" });

    const frozen: FrozenEthGas = {
      gas: 21000n,
      maxFeePerGas: 50n * 1_000_000_000n,
      maxPriorityFeePerGas: 2n * 1_000_000_000n,
      composedAt: Date.now(),
    };

    const res = await sendNative({
      network: "mainnet",
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      value: 1000n,
      tier: "normal",
      frozen,
    });

    expect(res.txHash).toBe("0xdeadbeef");
    // Critically: no re-quote of fee market or gas estimate.
    expect(getBlock).not.toHaveBeenCalled();
    expect(estimateGas).not.toHaveBeenCalled();
    // Nonce IS re-read at broadcast (intentional — see service doc).
    expect(getTxCount).toHaveBeenCalledTimes(1);
    // Composed tx must mirror the frozen numbers.
    expect(res.composed.gas).toBe("21000");
    expect(res.composed.maxFeePerGas).toBe((50n * 1_000_000_000n).toString());
  });

  it("throws E_PREVIEW_STALE on a frozen preview older than the TTL", async () => {
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain: { id: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const frozen: FrozenEthGas = {
      gas: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      composedAt: Date.now() - PREVIEW_FRESHNESS_MS - 1000,
    };
    await expect(
      sendNative({
        network: "mainnet",
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        value: 1n,
        tier: "normal",
        frozen,
      }),
    ).rejects.toThrow(/E_PREVIEW_STALE/);
  });

  it("falls back to lazy compose when no frozen preview is provided (back-compat)", async () => {
    const getBlock = vi.fn(async () => ({ baseFeePerGas: 10n * 1_000_000_000n }));
    const estimateGas = vi.fn(async () => 21000n);
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      getTransactionCount: async () => 0,
      sendRawTransaction: async () => "0xfeedface",
      getBlock,
      estimateGas,
      chain: { id: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "0xraw" });

    const res = await sendNative({
      network: "mainnet",
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      value: 1000n,
      tier: "normal",
    });

    expect(res.txHash).toBe("0xfeedface");
    expect(getBlock).toHaveBeenCalled();
    expect(estimateGas).toHaveBeenCalled();
  });
});

describe("v0.1.11 / sendWprl — sign-what-you-saw", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips re-quote when given a fresh frozen preview", async () => {
    vi.spyOn(bridge, "bridgeConfig").mockReturnValue({
      wprl: "0x000000000000000000000000000000000000dead",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const getBlock = vi.fn(async () => ({ baseFeePerGas: 10n * 1_000_000_000n }));
    const estimateGas = vi.fn(async () => 65000n);
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      getTransactionCount: async () => 3,
      sendRawTransaction: async () => "0xcafe",
      getBlock,
      estimateGas,
      chain: { id: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "0xraw" });

    const res = await sendWprl({
      network: "mainnet",
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      amount: 1000n,
      tier: "normal",
      frozen: {
        gas: 65000n,
        maxFeePerGas: 50n * 1_000_000_000n,
        maxPriorityFeePerGas: 2n * 1_000_000_000n,
        composedAt: Date.now(),
      },
    });

    expect(res.txHash).toBe("0xcafe");
    expect(getBlock).not.toHaveBeenCalled();
    expect(estimateGas).not.toHaveBeenCalled();
  });
});

// ─── O2-H-1: PRL sign-what-you-saw (frozen UTXO set) ──────────────────────

describe("v0.1.11 / broadcastPearlPrecomposed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function frozen(): ComposedPearlTx {
    return {
      utxos: [
        {
          txid: "a".repeat(64),
          vout: 0,
          valueGrains: 1_000_000_000n,
          scriptHex: "5120" + "00".repeat(32),
          poolIndex: 0,
        },
      ],
      outputs: [
        { address: "prl1pdest0000", amountGrains: 500_000_000n },
        { address: "prl1pchange00", amountGrains: 499_999_000n },
      ],
      feeGrains: 1_000n,
      tipGrains: 0n,
      changeGrains: 499_999_000n,
      degraded: false,
      spendableGrains: 1_000_000_000n,
      spendableUtxoCount: 1,
    };
  }

  it("signs the frozen composition without walking the pool again", async () => {
    const walkSpy = vi.spyOn(pearlRpc, "fetchPrlUtxos");
    const broadcastSpy = vi
      .spyOn(pearlRpc, "broadcastPearlTx")
      .mockResolvedValue("txidabc");
    vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "rawhex" });

    const res = await broadcastPearlPrecomposed(
      { composed: frozen(), composedAt: Date.now() },
      "mainnet",
    );

    expect(res.txid).toBe("txidabc");
    expect(walkSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).toHaveBeenCalledWith("rawhex");
  });

  it("throws E_PREVIEW_STALE when the frozen preview exceeds the TTL", async () => {
    const stale = Date.now() - PEARL_PREVIEW_FRESHNESS_MS - 1000;
    await expect(
      broadcastPearlPrecomposed({ composed: frozen(), composedAt: stale }, "mainnet"),
    ).rejects.toThrow(/E_PREVIEW_STALE/);
  });
});
