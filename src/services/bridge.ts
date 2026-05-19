import { erc20Abi, getContract } from "viem";
import { ethClient } from "../chains/ethereum/rpc";
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

/** POST an SDI v2 deposit intent to the relayer for tracking. */
export async function postSdiIntent(network: EthNetwork, sdi: unknown): Promise<{ id: string }> {
  const cfg = bridgeConfig(network);
  const res = await fetch(`${cfg.relayApiBase}/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdi),
  });
  if (!res.ok) throw new Error(`relay /intents: ${res.status}`);
  return (await res.json()) as { id: string };
}

/** GET signed mint payload for a deposited intent. */
export async function getMintSignature(network: EthNetwork, intentId: string): Promise<unknown> {
  const cfg = bridgeConfig(network);
  const res = await fetch(`${cfg.relayApiBase}/intents/${intentId}/mint-sig`);
  if (!res.ok) throw new Error(`relay /mint-sig: ${res.status}`);
  return res.json();
}
