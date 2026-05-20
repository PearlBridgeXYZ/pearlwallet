// ETH + WPRL transaction service. Bridges the UI (composer pages) to the
// crypto worker (signer) and viem's public client (estimate + broadcast).
// All key material stays inside the worker — this file only handles
// fee-market reads, calldata encoding, and raw-tx posting.

import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { ethClient } from "../chains/ethereum/rpc";
import { bridgeConfig } from "./bridge";
import type { EthNetwork } from "../chains/ethereum/network";
import { cryptoWorker } from "../crypto/worker-client";
import type { EthTxRequest } from "../crypto/worker";

export interface GasParams {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Estimated gas units the tx will consume. */
  gas: bigint;
  /** Convenience: ceiling on the wei cost = gas * maxFeePerGas. */
  worstCaseWei: bigint;
}

export type FeeTier = "low" | "normal" | "high";

// Priority-fee adders per tier. The base fee comes from the latest
// block; the priority lands on top. These are conservative defaults so
// the wallet never tries to underpay the chain — relay-rejection looks
// like a wallet bug to the user even when it's the user's fault.
const PRIORITY_GWEI_BY_TIER: Record<FeeTier, bigint> = {
  low: 1n,
  normal: 2n,
  high: 3n,
};

/**
 * Returns EIP-1559 fee parameters tuned to `tier`. maxFeePerGas pads the
 * latest base fee by 2× so a single-block bump can't immediately stale
 * the tx — chains volatility means a 1× ceiling regularly drops a tx
 * back to the mempool after one block.
 */
export async function suggestGas(
  network: EthNetwork,
  tier: FeeTier,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const client = ethClient(network);
  const block = await client.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? 0n;
  const priorityGwei = PRIORITY_GWEI_BY_TIER[tier];
  const priority = priorityGwei * 1_000_000_000n;
  const maxFee = baseFee * 2n + priority;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

/** Estimate gas units for a plain native ETH transfer to `to`. */
export async function estimateNativeGas(
  network: EthNetwork,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
): Promise<bigint> {
  const client = ethClient(network);
  const units = await client.estimateGas({ account: from, to, value });
  // Pad 20% — viem's estimate is exact for a known state; small
  // mempool-time deltas (e.g. storage warming) can otherwise OOG.
  return (units * 12n) / 10n;
}

/** Estimate gas units for a WPRL (ERC-20) transfer. */
export async function estimateWprlGas(
  network: EthNetwork,
  from: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<bigint> {
  const cfg = bridgeConfig(network);
  if (cfg.wprl === "0x0000000000000000000000000000000000000000") {
    throw new Error("E_WPRL_NOT_DEPLOYED");
  }
  const client = ethClient(network);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  const units = await client.estimateGas({
    account: from,
    to: cfg.wprl,
    data,
  });
  return (units * 12n) / 10n;
}

export interface SendNativeParams {
  network: EthNetwork;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  tier: FeeTier;
}

export interface SendWprlParams {
  network: EthNetwork;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  tier: FeeTier;
}

export interface SendResult {
  txHash: `0x${string}`;
  /** The composed tx (pre-signing) — surfaced so the UI can show the
   *  user the final numbers it actually broadcast, not the pre-estimate. */
  composed: EthTxRequest;
}

async function broadcastRaw(network: EthNetwork, raw: Hex): Promise<`0x${string}`> {
  const client = ethClient(network);
  return await client.sendRawTransaction({ serializedTransaction: raw });
}

async function chainIdFor(network: EthNetwork): Promise<number> {
  // viem's chain object exposes the canonical chainId; we read it via
  // the public client so a malicious network override (custom RPC) that
  // claims a different chainId would be detected by mempool rejection
  // — but we still bind the signed tx to our believed chainId, not the
  // node's. Defense-in-depth against a custom-RPC user who pointed at
  // a chain-1337 fork by accident.
  const client = ethClient(network);
  return client.chain.id;
}

export async function sendNative(p: SendNativeParams): Promise<SendResult> {
  const chainId = await chainIdFor(p.network);
  const client = ethClient(p.network);
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: p.from, blockTag: "pending" }),
    estimateNativeGas(p.network, p.from, p.to, p.value),
    suggestGas(p.network, p.tier),
  ]);
  const composed: EthTxRequest = {
    chainId,
    nonce,
    to: p.to,
    value: p.value.toString(),
    gas: gas.toString(),
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
  };
  const { raw } = await cryptoWorker.call<"signEthTx", { raw: Hex }>("signEthTx", {
    tx: composed,
  });
  const txHash = await broadcastRaw(p.network, raw);
  return { txHash, composed };
}

export async function sendWprl(p: SendWprlParams): Promise<SendResult> {
  const cfg = bridgeConfig(p.network);
  if (cfg.wprl === "0x0000000000000000000000000000000000000000") {
    throw new Error("E_WPRL_NOT_DEPLOYED");
  }
  const chainId = await chainIdFor(p.network);
  const client = ethClient(p.network);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [p.to, p.amount],
  });
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: p.from, blockTag: "pending" }),
    estimateWprlGas(p.network, p.from, p.to, p.amount),
    suggestGas(p.network, p.tier),
  ]);
  const composed: EthTxRequest = {
    chainId,
    nonce,
    to: cfg.wprl,
    value: "0",
    data,
    gas: gas.toString(),
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
  };
  const { raw } = await cryptoWorker.call<"signEthTx", { raw: Hex }>("signEthTx", {
    tx: composed,
  });
  const txHash = await broadcastRaw(p.network, raw);
  return { txHash, composed };
}

/**
 * Pre-flight gas check used by SendWPRL. Returns the worst-case wei
 * cost the user needs in their ETH balance and whether their current
 * balance covers it. UI surfaces a "fund your ETH first" warning when
 * `covered` is false — without this users send WPRL with a perfectly
 * estimated gas cost and the tx pends forever.
 */
export interface GasCoverage {
  worstCaseWei: bigint;
  ethBalanceWei: bigint;
  covered: boolean;
}

export function evaluateGasCoverage(
  ethBalanceWei: bigint,
  gas: bigint,
  maxFeePerGas: bigint,
): GasCoverage {
  const worstCaseWei = gas * maxFeePerGas;
  return {
    worstCaseWei,
    ethBalanceWei,
    covered: ethBalanceWei >= worstCaseWei,
  };
}
