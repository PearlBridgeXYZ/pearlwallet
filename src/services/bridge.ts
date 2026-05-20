import { erc20Abi, getContract, keccak256, recoverTypedDataAddress, stringToBytes, type TypedDataDomain } from "viem";
import { ethClient } from "./../chains/ethereum/rpc";
import {
  BRIDGE_ROUTER_ADDRESS,
  WPRL_ADDRESS,
  PEARL_LOCK_ADDRESS,
  RELAY_API_BASE,
  MINT_FEE_BPS_DEFAULT,
  BURN_FEE_BPS_DEFAULT,
  type EthNetwork,
} from "../chains/ethereum/network";

const BRIDGE_FEE_ABI = [
  { type: "function", name: "mintFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "burnFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyMintLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyBurnLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const BRIDGE_ROLES_ABI = [
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

// PearlBridge EIP-712 mint intent — matches relay signer (RC5).
// See docs/05-BRIDGE_INTEGRATION.md §"EIP-712 mint signature verification".
const MINT_TYPES = {
  Mint: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "sdiHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// keccak256("RELAYER_ROLE") — OpenZeppelin AccessControl convention.
const RELAYER_ROLE = keccak256(stringToBytes("RELAYER_ROLE"));

export interface MintPayload {
  recipient: `0x${string}`;
  amount: bigint;
  sdiHash: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

export interface RelayerMintSig {
  payload: MintPayload;
  signature: `0x${string}`;
}

/**
 * The user's submitted bridge intent — what they ACTUALLY wanted to mint.
 * verifyRelayerMintSig compares the relayer's signed payload to this. A
 * compromised or MITM-attacked relay otherwise could substitute its own
 * recipient/amount/sdiHash; this struct closes that loss-of-funds path.
 */
export interface IntentExpectation {
  recipient: `0x${string}`;
  amount: bigint;
  sdiHash: `0x${string}`;
}

/**
 * Verify a relayer mint signature is well-formed, NOT expired, signed by
 * an address holding the RELAYER role on BridgeController, AND that the
 * signed payload binds to the user's own submitted intent. The wallet
 * MUST call this before broadcasting any mint tx, or it accepts attacker-
 * supplied recipients/amounts/intents.
 */
export async function verifyRelayerMintSig(
  sig: RelayerMintSig,
  network: EthNetwork = "mainnet",
  expected?: IntentExpectation,
): Promise<{ signer: `0x${string}` }> {
  const cfg = bridgeConfig(network);
  const chainId = network === "mainnet" ? 1 : 11155111;
  const domain: TypedDataDomain = {
    name: "PearlBridge",
    version: "2",
    chainId,
    verifyingContract: cfg.bridgeController,
  };
  // Deadline check first — cheapest, no network. Reject a signature that
  // already expired before we burn an RPC round-trip on role lookup.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (sig.payload.deadline <= nowSec) {
    throw new Error("E_SIGNATURE_EXPIRED");
  }
  if (expected) {
    if (sig.payload.recipient.toLowerCase() !== expected.recipient.toLowerCase()) {
      throw new Error("E_SIGNATURE_RECIPIENT_MISMATCH");
    }
    if (sig.payload.amount !== expected.amount) {
      throw new Error("E_SIGNATURE_AMOUNT_MISMATCH");
    }
    if (sig.payload.sdiHash.toLowerCase() !== expected.sdiHash.toLowerCase()) {
      throw new Error("E_SIGNATURE_SDI_HASH_MISMATCH");
    }
  }
  const signer = await recoverTypedDataAddress({
    domain,
    types: MINT_TYPES,
    primaryType: "Mint",
    message: sig.payload,
    signature: sig.signature,
  });
  const client = ethClient(network);
  const controller = getContract({ address: cfg.bridgeController, abi: BRIDGE_ROLES_ABI, client });
  const hasRole = await controller.read.hasRole([RELAYER_ROLE, signer]);
  if (!hasRole) {
    throw new Error("E_SIGNATURE_NOT_FROM_RELAYER");
  }
  return { signer };
}

export interface BridgeFees {
  mintFeeBps: number;
  burnFeeBps: number;
  source: "contract" | "fallback";
}

export interface BridgeConfig {
  bridgeController: `0x${string}`;
  wprl: `0x${string}`;
  pearlLockAddress: string;
  relayApiBase: string;
  network: EthNetwork;
}

export function bridgeConfig(network: EthNetwork = "mainnet"): BridgeConfig {
  return {
    bridgeController: BRIDGE_ROUTER_ADDRESS[network],
    wprl: WPRL_ADDRESS[network],
    pearlLockAddress: PEARL_LOCK_ADDRESS[network],
    relayApiBase: RELAY_API_BASE[network],
    network,
  };
}

/**
 * Read mint/burn fee bps live from the BridgeController contract.
 * Falls back to .env-derived defaults (50 / 0) if the call fails so the UI
 * never shows a missing fee.
 */
export async function readBridgeFees(network: EthNetwork = "mainnet"): Promise<BridgeFees> {
  const cfg = bridgeConfig(network);
  if (cfg.bridgeController === "0x0000000000000000000000000000000000000000") {
    return { mintFeeBps: MINT_FEE_BPS_DEFAULT, burnFeeBps: BURN_FEE_BPS_DEFAULT, source: "fallback" };
  }
  try {
    const client = ethClient(network);
    const contract = getContract({ address: cfg.bridgeController, abi: BRIDGE_FEE_ABI, client });
    const [mint, burn] = await Promise.all([
      contract.read.mintFeeBps(),
      contract.read.burnFeeBps(),
    ]);
    return { mintFeeBps: Number(mint), burnFeeBps: Number(burn), source: "contract" };
  } catch {
    return { mintFeeBps: MINT_FEE_BPS_DEFAULT, burnFeeBps: BURN_FEE_BPS_DEFAULT, source: "fallback" };
  }
}

/** Read WPRL balance for an Ethereum address. Returns wei. */
export async function readWprlBalance(addr: `0x${string}`, network: EthNetwork = "mainnet"): Promise<bigint> {
  const cfg = bridgeConfig(network);
  if (cfg.wprl === "0x0000000000000000000000000000000000000000") return 0n;
  const client = ethClient(network);
  const contract = getContract({ address: cfg.wprl, abi: erc20Abi, client });
  return await contract.read.balanceOf([addr]);
}

const RELAY_FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RELAY_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** POST an SDI v2 deposit intent to the relayer for tracking. */
export async function postSdiIntent(network: EthNetwork, sdi: unknown): Promise<{ id: string }> {
  const cfg = bridgeConfig(network);
  const res = await fetchWithTimeout(`${cfg.relayApiBase}/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdi),
  });
  if (!res.ok) throw new Error(`relay /intents: ${res.status}`);
  return (await res.json()) as { id: string };
}

/**
 * GET signed mint payload for a deposited intent AND verify it against the
 * on-chain RELAYER role, the requested user intent, and that it has not
 * expired. `expected` ties the relayer's payload to what the user actually
 * submitted — a MITM relay otherwise could swap recipient/amount/sdiHash
 * for its own address. Throws on any mismatch; broadcast path must not
 * call this without `expected` in production.
 */
export async function getMintSignature(
  network: EthNetwork,
  intentId: string,
  expected?: IntentExpectation,
): Promise<RelayerMintSig> {
  const cfg = bridgeConfig(network);
  const res = await fetchWithTimeout(`${cfg.relayApiBase}/intents/${intentId}/mint-sig`);
  if (!res.ok) throw new Error(`relay /mint-sig: ${res.status}`);
  const raw = (await res.json()) as RelayerMintSig;
  await verifyRelayerMintSig(raw, network, expected);
  return raw;
}
