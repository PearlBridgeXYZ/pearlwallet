// ENS (Ethereum Name Service) — native support for human-readable
// Ethereum addresses. ENS lives on Ethereum MAINNET only; on sepolia or
// any non-mainnet network ENS is unavailable and these resolve to null.
//
// Forward resolution (name.eth → 0x…) is the high-value path: it lets a
// user send to "alice.eth" instead of pasting a 42-char hex string. The
// resolved address is always shown to the user for confirmation before any
// send — a name is a trust delegation to ENS, and the wallet surfaces the
// concrete address so the user verifies where funds actually go.
//
// Reverse resolution (0x… → name.eth) is display-only sugar; never used to
// route funds.

import { normalize } from "viem/ens";
import { ethClient } from "../chains/ethereum/rpc";
import type { EthNetwork } from "../chains/ethereum/network";
import { normalizeEthAddress, validEth } from "../lib/validate";

/** A string looks like an ENS name if it has a dot and isn't a 0x address. */
export function looksLikeEnsName(input: string): boolean {
  const s = input.trim();
  return s.includes(".") && !s.startsWith("0x") && s.length >= 3;
}

const fwdCache = new Map<string, { addr: `0x${string}` | null; at: number }>();
const revCache = new Map<string, { name: string | null; at: number }>();
const TTL_MS = 60_000;

/**
 * Resolve an ENS name to an address on mainnet. Returns null when the name
 * doesn't resolve, the network isn't mainnet, or the lookup fails. Never
 * throws — callers treat null as "not a usable destination".
 */
export async function resolveEnsName(
  name: string,
  net: EthNetwork,
): Promise<`0x${string}` | null> {
  if (net !== "mainnet") return null;
  const key = name.trim().toLowerCase();
  const cached = fwdCache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.addr;
  let normalized: string;
  try {
    normalized = normalize(name.trim());
  } catch {
    return null; // invalid ENS name (bad UTF-8 / disallowed chars)
  }
  try {
    const addr = await ethClient(net).getEnsAddress({ name: normalized });
    fwdCache.set(key, { addr: addr ?? null, at: Date.now() });
    return addr ?? null;
  } catch {
    return null;
  }
}

/**
 * Reverse-resolve an address to its primary ENS name (display only).
 * Returns null on mainnet miss / non-mainnet / failure. Never throws.
 */
export async function lookupEnsName(
  address: `0x${string}`,
  net: EthNetwork,
): Promise<string | null> {
  if (net !== "mainnet") return null;
  const key = address.toLowerCase();
  const cached = revCache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.name;
  try {
    const name = await ethClient(net).getEnsName({ address });
    revCache.set(key, { name: name ?? null, at: Date.now() });
    return name ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a send destination from raw user input: either a 0x address
 * (EIP-55 checksum enforced) or an ENS name (mainnet-only). Shared by the
 * ETH and WPRL send flows so both treat addresses + names identically.
 * Returns the canonical 0x address plus the ENS name when one was used.
 */
export type DestinationResult =
  | { ok: true; address: `0x${string}`; ensName: string | null }
  | { ok: false; reason: string };

export async function resolveEthDestination(
  raw: string,
  net: EthNetwork,
): Promise<DestinationResult> {
  const input = raw.trim();
  if (looksLikeEnsName(input)) {
    const address = await resolveEnsName(input, net);
    if (!address) {
      return {
        ok: false,
        reason:
          net === "mainnet"
            ? `Couldn't resolve "${input}" — check the ENS name.`
            : "ENS names only resolve on Ethereum mainnet.",
      };
    }
    return { ok: true, address, ensName: input };
  }
  const address = normalizeEthAddress(input);
  if (!address) {
    return {
      ok: false,
      reason: validEth(input)
        ? "That address has an invalid checksum — double-check it."
        : "That doesn't look like a valid Ethereum address or ENS name.",
    };
  }
  return { ok: true, address, ensName: null };
}

/** Test seam — clears the in-memory caches. */
export function __clearEnsCachesForTest(): void {
  fwdCache.clear();
  revCache.clear();
}
