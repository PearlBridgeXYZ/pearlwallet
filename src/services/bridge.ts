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
 * Coerce a JSON-decoded relayer response into the typed MintPayload
 * shape. Network responses arrive with amount/nonce/deadline as JSON
 * number or decimal string (never bigint), so `payload.deadline <=
 * nowSec` would throw `TypeError: Cannot mix BigInt and other types`
 * before any binding check could run. Normalize at the boundary so
 * downstream code sees a single canonical type.
 */
export function normalizeRelayerMintSig(raw: unknown): RelayerMintSig {
  if (!raw || typeof raw !== "object") {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  const obj = raw as { payload?: unknown; signature?: unknown };
  if (!obj.payload || typeof obj.payload !== "object") {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  if (typeof obj.signature !== "string" || !obj.signature.startsWith("0x")) {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  const p = obj.payload as Record<string, unknown>;
  const recipient = p.recipient;
  const sdiHash = p.sdiHash;
  if (typeof recipient !== "string" || !recipient.startsWith("0x")) {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  if (typeof sdiHash !== "string" || !sdiHash.startsWith("0x")) {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  // Wire format MUST be a decimal string for uint256 fields.
  //
  // - JSON `number` is rejected: amount above 2^53-1 loses precision at
  //   parse time. A relayer returning amount=12345678901234567890 as a
  //   number would arrive here as 12345678901234567000 and the binding
  //   check `sig.amount === expected.amount` would erroneously fail
  //   (or, worse, succeed with a *different* attacker-chosen amount if
  //   they crafted the truncation). Opus v0.1.7 audit M-1.
  // - Hex strings ("0x10") are rejected: BigInt() accepts them but the
  //   relay contract spec says decimal. A future malicious relay could
  //   use hex to slip a payload past visual inspection of intercepted
  //   responses. Minimax v0.1.7 audit M-3.
  // - Leading zeros are rejected for the same reason (canonical form).
  // - `0` alone is allowed; deadline=0 will still fail the expiry check.
  function coerceUint(field: unknown): bigint {
    if (field === null || field === undefined) throw new Error("E_SIGNATURE_MALFORMED");
    if (typeof field === "bigint") {
      if (field < 0n) throw new Error("E_SIGNATURE_MALFORMED");
      return field;
    }
    if (typeof field !== "string") {
      // number, boolean, object, array — all rejected. JSON numbers can
      // lose precision; everything else is nonsense for a uint256 field.
      throw new Error("E_SIGNATURE_MALFORMED");
    }
    // Strict canonical decimal: "0" or "[1-9]\d*". No leading zeros, no
    // sign, no whitespace, no 0x prefix, no fraction, no exponent.
    if (!/^(0|[1-9]\d*)$/.test(field)) {
      throw new Error("E_SIGNATURE_MALFORMED");
    }
    try {
      return BigInt(field);
    } catch {
      throw new Error("E_SIGNATURE_MALFORMED");
    }
  }
  const amount = coerceUint(p.amount);
  const nonce = coerceUint(p.nonce);
  const deadline = coerceUint(p.deadline);
  if (amount < 0n || nonce < 0n || deadline < 0n) {
    throw new Error("E_SIGNATURE_MALFORMED");
  }
  return {
    payload: {
      recipient: recipient as `0x${string}`,
      amount,
      sdiHash: sdiHash as `0x${string}`,
      nonce,
      deadline,
    },
    signature: obj.signature as `0x${string}`,
  };
}

/**
 * Verify a relayer mint signature is well-formed, NOT expired, signed by
 * an address holding the RELAYER role on BridgeController, AND that the
 * signed payload binds to the user's own submitted intent. The wallet
 * MUST call this before broadcasting any mint tx, or it accepts attacker-
 * supplied recipients/amounts/intents.
 *
 * `expected` is REQUIRED. The v0.1.5 audit added the binding parameter as
 * a defense-in-depth check; v0.1.6 left it as `expected?:` which made the
 * defense opt-in and re-introduced the bypass. Callers that genuinely need
 * to inspect a sig without binding (test tools, diagnostic CLIs) must use
 * `verifyRelayerMintSigUnbound` and assume the loss-of-funds risk.
 *
 * `nowSecOverride` lets callers substitute a trusted timestamp (e.g. the
 * latest Ethereum block timestamp) when the local clock can't be trusted.
 */
export async function verifyRelayerMintSig(
  sig: RelayerMintSig,
  network: EthNetwork,
  expected: IntentExpectation,
  nowSecOverride?: bigint,
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
  const nowSec = nowSecOverride ?? BigInt(Math.floor(Date.now() / 1000));
  if (sig.payload.deadline <= nowSec) {
    throw new Error("E_SIGNATURE_EXPIRED");
  }
  if (sig.payload.recipient.toLowerCase() !== expected.recipient.toLowerCase()) {
    throw new Error("E_SIGNATURE_RECIPIENT_MISMATCH");
  }
  if (sig.payload.amount !== expected.amount) {
    throw new Error("E_SIGNATURE_AMOUNT_MISMATCH");
  }
  if (sig.payload.sdiHash.toLowerCase() !== expected.sdiHash.toLowerCase()) {
    throw new Error("E_SIGNATURE_SDI_HASH_MISMATCH");
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

/**
 * Diagnostic-only: verify deadline + signature + relayer role WITHOUT
 * binding payload to a user intent. Never call this on the broadcast
 * path — the named-loudly suffix is intentional. Use only for relay
 * health checks / CLI testing where loss-of-funds is impossible.
 */
export async function verifyRelayerMintSigUnbound(
  sig: RelayerMintSig,
  network: EthNetwork,
  nowSecOverride?: bigint,
): Promise<{ signer: `0x${string}` }> {
  const cfg = bridgeConfig(network);
  const chainId = network === "mainnet" ? 1 : 11155111;
  const domain: TypedDataDomain = {
    name: "PearlBridge",
    version: "2",
    chainId,
    verifyingContract: cfg.bridgeController,
  };
  const nowSec = nowSecOverride ?? BigInt(Math.floor(Date.now() / 1000));
  if (sig.payload.deadline <= nowSec) throw new Error("E_SIGNATURE_EXPIRED");
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
  if (!hasRole) throw new Error("E_SIGNATURE_NOT_FROM_RELAYER");
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
 * for its own address. `expected` is REQUIRED at the type level so the
 * binding cannot be skipped by a forgetful caller. Throws on any mismatch.
 */
export async function getMintSignature(
  network: EthNetwork,
  intentId: string,
  expected: IntentExpectation,
  nowSecOverride?: bigint,
): Promise<RelayerMintSig> {
  const cfg = bridgeConfig(network);
  const res = await fetchWithTimeout(`${cfg.relayApiBase}/intents/${intentId}/mint-sig`);
  if (!res.ok) throw new Error(`relay /mint-sig: ${res.status}`);
  // The wire format encodes uint256 fields as JSON numbers or strings.
  // Normalize to typed bigints BEFORE handing to the verifier; otherwise
  // `payload.deadline <= nowSec (bigint)` throws TypeError and every
  // legitimate signature is rejected.
  const raw = await res.json();
  const sig = normalizeRelayerMintSig(raw);
  await verifyRelayerMintSig(sig, network, expected, nowSecOverride);
  return sig;
}

/**
 * Fetch the latest Ethereum block timestamp. Use as `nowSecOverride` when
 * verifying a relayer mint signature so a wildly-skewed client clock can't
 * accept an already-expired signature (clock slow) or reject a fresh one
 * (clock fast). Returns seconds as bigint.
 */
export async function fetchEthBlockTimestamp(network: EthNetwork): Promise<bigint> {
  const client = ethClient(network);
  const block = await client.getBlock({ blockTag: "latest" });
  return block.timestamp;
}
