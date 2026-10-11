// ETH + WPRL transaction service. Bridges the UI (composer pages) to the
// crypto worker (signer) and viem's public client (estimate + broadcast).
// All key material stays inside the worker — this file only handles
// fee-market reads, calldata encoding, and raw-tx posting.

import {
  BaseError,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  type Hex,
} from "viem";
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

// Sanity ceiling on baseFee. A hostile RPC (or BGP-hijacked publicnode)
// could return an absurd baseFeePerGas to either DoS the WPRL send flow
// (coverage check fails) or socially-engineer the user into funding more
// ETH than needed. Mainnet baseFee historically peaks ~500 gwei; 5000
// gwei is 10× the worst observed and still tightly bounds the worst
// possible UI-level coverage error. v0.1.9 audit O1-H-1.
export const MAX_BASE_FEE_WEI = 5000n * 1_000_000_000n;

// How long a preview's frozen gas/fees stay valid before broadcast
// refuses to sign them. 30s covers ordinary user-confirms; longer than
// that and the user should re-see fresh numbers. v0.1.9 audit
// O2-H-1 ≡ M2-H-2 (sign-what-you-saw).
export const PREVIEW_FRESHNESS_MS = 30_000;

/**
 * Returns EIP-1559 fee parameters tuned to `tier`. maxFeePerGas pads the
 * latest base fee by 2× so a single-block bump can't immediately stale
 * the tx — chains volatility means a 1× ceiling regularly drops a tx
 * back to the mempool after one block.
 *
 * Throws `E_ETH_FEE_MARKET_INSANE` if the RPC returns an absurd
 * baseFeePerGas (defense against hostile / hijacked RPC).
 */
export async function suggestGas(
  network: EthNetwork,
  tier: FeeTier,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const client = ethClient(network);
  const block = await client.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? 0n;
  if (baseFee > MAX_BASE_FEE_WEI) {
    throw new Error("E_ETH_FEE_MARKET_INSANE");
  }
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

/**
 * Frozen preview a UI can pass through to broadcast so the signed tx
 * matches exactly the numbers the user saw. Nonce is intentionally NOT
 * captured here — it's re-read at broadcast time so two tabs / two
 * back-to-back sends don't collide on a stale nonce (the user never
 * sees the nonce, so re-reading it isn't a sign-what-you-saw violation).
 */
export interface FrozenEthGas {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  composedAt: number;
}

export interface SendNativeParams {
  network: EthNetwork;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  tier: FeeTier;
  /** Sign-what-you-saw: pass the preview's frozen gas + fees to skip
   *  re-quoting at broadcast. Throws `E_PREVIEW_STALE` if older than
   *  `PREVIEW_FRESHNESS_MS`. v0.1.9 audit O2-H-1 ≡ M2-H-2. */
  frozen?: FrozenEthGas;
}

export interface SendWprlParams {
  network: EthNetwork;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  tier: FeeTier;
  /** See SendNativeParams.frozen. */
  frozen?: FrozenEthGas;
}

function assertFreshOrThrow(frozen: FrozenEthGas, now = Date.now()): void {
  if (now - frozen.composedAt > PREVIEW_FRESHNESS_MS) {
    throw new Error("E_PREVIEW_STALE");
  }
}

export interface SendResult {
  txHash: `0x${string}`;
  /** The composed tx (pre-signing) — surfaced so the UI can show the
   *  user the final numbers it actually broadcast, not the pre-estimate. */
  composed: EthTxRequest;
}

/**
 * The broadcast may have reached the network even though the RPC call
 * failed (gateway timeout after the node accepted it, a fallback provider
 * answering "already known", ...) and a lookup by hash did not find it.
 * Never a plain failure: sending again could pay twice. The UI shows
 * `hash` with an explorer link and blocks an immediate resend.
 */
export class EthBroadcastStatusUnknownError extends Error {
  readonly hash: `0x${string}`;
  override readonly cause: unknown;
  constructor(hash: `0x${string}`, cause: unknown) {
    super(`E_ETH_BROADCAST_STATUS_UNKNOWN: ${hash}`);
    this.name = "EthBroadcastStatusUnknownError";
    this.hash = hash;
    this.cause = cause;
  }
}

/** Post-error lookups by hash: count and spacing. Mutable for tests only. */
export const ETH_BROADCAST_PROBE = { attempts: 3, intervalMs: 1_500 };

/** Node messages meaning "this tx (or one with its nonce) is already
 *  known" — the earlier, failed-looking attempt may have delivered it. */
const KNOWN_TX_RE = /already known|known transaction|nonce too low|replacement transaction underpriced|already imported/i;

/** Node messages that are a verdict on the tx itself: it was not accepted.
 *  Checked after KNOWN_TX_RE, so "replacement transaction underpriced"
 *  never reaches the "transaction underpriced" alternative (no lookbehind:
 *  older Safari can't parse it). */
const DEFINITIVE_REJECT_RE =
  /insufficient funds|intrinsic gas too low|gas too low|invalid sender|fee cap less than block base fee|max fee per gas less than block base fee|transaction underpriced|exceeds block gas limit|exceeds the configured cap|tip higher than fee cap|max priority fee per gas higher than max fee per gas|nonce too high|invalid chain id|transaction type not supported|oversized data|rlp:/i;

/** JSON-RPC codes that are a verdict on the request itself: -32003
 *  (transaction rejected), -32602 (invalid params, e.g. undecodable raw). */
const DEFINITIVE_REJECT_CODES = new Set([-32003, -32602]);

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      if (cur instanceof BaseError && cur.details) parts.push(cur.details);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

function errorCodes(err: unknown): number[] {
  const codes: number[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "number") codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * True only when the node gave a definitive verdict rejecting the tx (a
 * rejection message such as "insufficient funds", or JSON-RPC -32003 /
 * -32602). Everything else is ambiguous — transport failures (HTTP 5xx /
 * 408 / 429 or any HTTP error, timeouts, network errors), "already
 * known"-style answers, rate limits, internal errors — because an earlier
 * attempt (viem retries and fallback hops) may have delivered the tx and
 * the thrown error only describes the last attempt.
 */
export function isDefinitiveEthRejection(err: unknown): boolean {
  const text = errorText(err);
  if (KNOWN_TX_RE.test(text)) return false;
  if (DEFINITIVE_REJECT_RE.test(text)) return true;
  return errorCodes(err).some((c) => DEFINITIVE_REJECT_CODES.has(c));
}

async function txKnownByHash(network: EthNetwork, hash: `0x${string}`): Promise<boolean> {
  const { attempts, intervalMs } = ETH_BROADCAST_PROBE;
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const tx = await ethClient(network).getTransaction({ hash });
      if (tx) return true;
    } catch {
      // Not found or the lookup itself failed: treat as not found.
    }
  }
  return false;
}

/** The JSON-RPC error object of a 2xx response, or null (non-2xx, no
 *  error member, unreadable body). Never throws; reads a clone so viem
 *  still parses the original. */
async function readJsonRpcError(res: Response): Promise<{ code?: unknown; message?: unknown } | null> {
  try {
    if (!res.ok) return null;
    const body: unknown = await res.clone().json();
    const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    return error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : null;
  } catch {
    return null;
  }
}

function definitiveRpcAnswer(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const e = new Error(typeof error.message === "string" ? error.message : "") as Error & { code?: number };
  if (typeof error.code === "number") e.code = error.code;
  return isDefinitiveEthRejection(e);
}

/**
 * Broadcast a signed tx. The hash is computed locally from the signed
 * bytes, so a failed RPC call can still be checked: if the network has the
 * tx, this is a success; if it doesn't and the failure was ambiguous, the
 * caller gets EthBroadcastStatusUnknownError (never a plain failure). The
 * original error is rethrown only when EVERY attempt (each HTTP retry and
 * fallback hop) got a definitive node rejection, or no request left at all.
 */
export async function broadcastRaw(network: EthNetwork, raw: Hex): Promise<`0x${string}`> {
  const hash = keccak256(raw);
  // viem's fallback throws only the LAST hop's error, so classifying that
  // error alone would call "A: 504 (maybe delivered), B: insufficient
  // funds" a definitive rejection. Count every attempt (each HTTP retry and
  // fallback hop) and every attempt that came back with a definitive
  // JSON-RPC rejection; the failure is definitive only if they match.
  let attempts = 0;
  let definitiveAnswers = 0;
  const client = ethClient(network, {
    observe: {
      request: () => {
        attempts++;
      },
      response: async (res) => {
        if (definitiveRpcAnswer(await readJsonRpcError(res))) definitiveAnswers++;
      },
    },
  });
  try {
    await client.sendRawTransaction({ serializedTransaction: raw });
    return hash;
  } catch (err) {
    let found = false;
    try {
      found = await txKnownByHash(network, hash);
    } catch {
      found = false;
    }
    if (found) return hash;
    const everyAttemptRejected = definitiveAnswers === attempts;
    if (everyAttemptRejected && (attempts === 0 || isDefinitiveEthRejection(err))) throw err;
    throw new EthBroadcastStatusUnknownError(hash, err);
  }
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
  let gas: bigint;
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  if (p.frozen) {
    assertFreshOrThrow(p.frozen);
    gas = p.frozen.gas;
    fees = {
      maxFeePerGas: p.frozen.maxFeePerGas,
      maxPriorityFeePerGas: p.frozen.maxPriorityFeePerGas,
    };
  } else {
    [gas, fees] = await Promise.all([
      estimateNativeGas(p.network, p.from, p.to, p.value),
      suggestGas(p.network, p.tier),
    ]);
  }
  const nonce = await client.getTransactionCount({ address: p.from, blockTag: "pending" });
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
  let gas: bigint;
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  if (p.frozen) {
    assertFreshOrThrow(p.frozen);
    gas = p.frozen.gas;
    fees = {
      maxFeePerGas: p.frozen.maxFeePerGas,
      maxPriorityFeePerGas: p.frozen.maxPriorityFeePerGas,
    };
  } else {
    [gas, fees] = await Promise.all([
      estimateWprlGas(p.network, p.from, p.to, p.amount),
      suggestGas(p.network, p.tier),
    ]);
  }
  const nonce = await client.getTransactionCount({ address: p.from, blockTag: "pending" });
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

// ── PearlBridge unwrap (burn) primitives — v0.4.0 native bridging ──────
//
// Both calls go to addresses PINNED in network.ts (never to addresses
// from an API response — the Bridge page cross-checks the quote's plan
// against these constants and refuses to sign on mismatch).

const REQUEST_BURN_ABI = [
  {
    type: "function",
    name: "requestBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "grossAmount", type: "uint256" },
      { name: "pearlAddress", type: "string" },
    ],
    outputs: [],
  },
] as const;

export async function readWprlAllowance(
  network: EthNetwork,
  owner: `0x${string}`,
): Promise<bigint> {
  const cfg = bridgeConfig(network);
  const client = ethClient(network);
  return (await client.readContract({
    address: cfg.wprl,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, cfg.bridgeController],
  })) as bigint;
}

export async function readWprlBalanceOf(
  network: EthNetwork,
  owner: `0x${string}`,
): Promise<bigint> {
  const cfg = bridgeConfig(network);
  const client = ethClient(network);
  return (await client.readContract({
    address: cfg.wprl,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

/**
 * Wait for an Ethereum tx receipt and return whether it succeeded. Used to
 * gate requestBurn on the approve actually MINING (audit C1): approve
 * returns at broadcast, so burning immediately runs requestBurn's gas
 * estimate against pre-approve state where allowance is still 0 → estimate
 * reverts and the burn throws nearly every time.
 */
export async function waitForEthSuccess(
  network: EthNetwork,
  hash: `0x${string}`,
  timeoutMs = 180_000,
): Promise<boolean> {
  const client = ethClient(network);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  return receipt.status === "success";
}

/** Read an ETH tx receipt status, or null if not mined yet (audit C5). */
export async function getEthReceiptStatus(
  network: EthNetwork,
  hash: `0x${string}`,
): Promise<"success" | "reverted" | null> {
  try {
    const r = await ethClient(network).getTransactionReceipt({ hash });
    return r.status;
  } catch {
    return null;
  }
}

export interface ContractCallParams {
  network: EthNetwork;
  from: `0x${string}`;
  tier: FeeTier;
  /** The gas ceiling the user reviewed (previewUnwrapGas). A call whose
   *  fresh fees or total cost exceed it is refused unsigned. */
  ceiling: EthGasCeiling;
}

/** What the user saw before signing a bridge contract call. */
export interface EthGasCeiling {
  /** Highest price per gas unit the call may sign. */
  maxFeePerGas: bigint;
  /** Highest total (gas limit × max fee) in wei the user was shown. Always
   *  a number: a step whose total wasn't shown (the burn after an
   *  approval) is estimated and reviewed again before it is signed. */
  maxCostWei: bigint;
}

/** Headroom over the previewed max fee per gas (percent): the base fee
 *  can move a few blocks between review and click. */
export const GAS_CEILING_HEADROOM_PCT = 150n;

export interface UnwrapGasPreview {
  maxFeePerGas: bigint;
  /** Ceiling for the approval; null when no approval is needed. */
  approveWei: bigint | null;
  /** Ceiling for the burn; null when it can only be estimated once the
   *  approval has confirmed (the estimate reverts without allowance). */
  burnWei: bigint | null;
}

function approveCalldata(network: EthNetwork, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [bridgeConfig(network).bridgeController, amount] });
}

function burnCalldata(amount: bigint, pearlAddress: string): Hex {
  return encodeFunctionData({ abi: REQUEST_BURN_ABI, functionName: "requestBurn", args: [amount, pearlAddress] });
}

/** Estimated gas limit for a bridge contract call (estimate + 20 %). */
async function contractGas(network: EthNetwork, from: `0x${string}`, to: `0x${string}`, data: Hex): Promise<bigint> {
  const units = await ethClient(network).estimateGas({ account: from, to, data });
  return (units * 120n) / 100n;
}

/** ETH gas ceilings for an unwrap, shown before anything is signed. */
export async function previewUnwrapGas(p: {
  network: EthNetwork;
  from: `0x${string}`;
  amount: bigint;
  pearlAddress: string;
  needsApprove: boolean;
  tier: FeeTier;
}): Promise<UnwrapGasPreview> {
  const cfg = bridgeConfig(p.network);
  const fees = await suggestGas(p.network, p.tier);
  const maxFeePerGas = (fees.maxFeePerGas * GAS_CEILING_HEADROOM_PCT) / 100n;
  if (p.needsApprove) {
    const gas = await contractGas(p.network, p.from, cfg.wprl, approveCalldata(p.network, p.amount));
    return { maxFeePerGas, approveWei: gas * maxFeePerGas, burnWei: null };
  }
  const gas = await contractGas(p.network, p.from, cfg.bridgeController, burnCalldata(p.amount, p.pearlAddress));
  return { maxFeePerGas, approveWei: null, burnWei: gas * maxFeePerGas };
}

/** ERC-20 approve(bridgeController, amount) on WPRL, signed locally. */
export async function approveWprlForBridge(
  p: ContractCallParams & { amount: bigint },
): Promise<SendResult> {
  const cfg = bridgeConfig(p.network);
  return await sendContractCall(p.network, p.from, cfg.wprl, approveCalldata(p.network, p.amount), p.tier, p.ceiling);
}

/** BridgeController.requestBurn(grossAmount, pearlAddress), signed locally. */
export async function requestBurn(
  p: ContractCallParams & { amount: bigint; pearlAddress: string },
): Promise<SendResult> {
  const cfg = bridgeConfig(p.network);
  return await sendContractCall(p.network, p.from, cfg.bridgeController, burnCalldata(p.amount, p.pearlAddress), p.tier, p.ceiling);
}

async function sendContractCall(
  network: EthNetwork,
  from: `0x${string}`,
  to: `0x${string}`,
  data: Hex,
  tier: FeeTier,
  ceiling: EthGasCeiling,
): Promise<SendResult> {
  const chainId = await chainIdFor(network);
  const client = ethClient(network);
  // 20% headroom (contractGas): requestBurn's gas varies with daily-window
  // storage writes (first burn of a window pays for slot init). An
  // exact-estimate tx that lands second pays slightly less gas but never
  // reverts; an exact-estimate tx that lands FIRST can run out.
  const [gas, fees] = await Promise.all([contractGas(network, from, to, data), suggestGas(network, tier)]);
  if (fees.maxFeePerGas > ceiling.maxFeePerGas || gas * fees.maxFeePerGas > ceiling.maxCostWei) {
    throw new Error("E_ETH_GAS_ABOVE_REVIEW");
  }
  const nonce = await client.getTransactionCount({ address: from, blockTag: "pending" });
  const composed: EthTxRequest = {
    chainId,
    nonce,
    to,
    value: "0",
    data,
    gas: gas.toString(),
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
  };
  const { raw } = await cryptoWorker.call<"signEthTx", { raw: Hex }>("signEthTx", {
    tx: composed,
  });
  const txHash = await broadcastRaw(network, raw);
  return { txHash, composed };
}
