// Single-sig Pearl address derivation from the PUBLIC account node
// m/86'/808276'/0' — pure, so the crypto worker and tests share it.

import type { HDKey } from "@scure/bip32";
import { pearlAddressFromCompressedPubkey } from "../chains/pearl/address";
import { pearlParams, type PearlNetwork } from "../chains/pearl/network";
import {
  RECEIVE_GAP_LIMIT,
  MAX_ADDRESSES_PER_BRANCH,
  MAX_DERIVE_BATCH,
  PEARL_EXTERNAL_BRANCH,
  PEARL_INTERNAL_BRANCH,
  branchPubkeys,
  isHdBranch,
  type HdBranch,
} from "./hd";

/** Address counts per branch to derive on create/restore/unlock. */
export interface PearlBranchCounts {
  external: number;
  internal: number;
}

/** Unknown/malformed → the initial gap window; otherwise clamped to
 *  [RECEIVE_GAP_LIMIT, MAX_ADDRESSES_PER_BRANCH]. */
export function clampBranchCount(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n)) return RECEIVE_GAP_LIMIT;
  return Math.min(Math.max(n, RECEIVE_GAP_LIMIT), MAX_ADDRESSES_PER_BRANCH);
}

/** Throws unless (branch, start, count) is a valid discovery request. */
export function validateDeriveRange(branch: unknown, start: unknown, count: unknown): void {
  if (!isHdBranch(branch)) throw new Error("E_DERIVE_BAD_BRANCH");
  if (
    typeof start !== "number" ||
    typeof count !== "number" ||
    !Number.isInteger(start) ||
    start < 0 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_DERIVE_BATCH ||
    start + count > MAX_ADDRESSES_PER_BRANCH
  ) {
    throw new Error("E_DERIVE_BAD_RANGE");
  }
}

/** Addresses at account/branch/[start, start+count). */
export function pearlBranchAddressRange(
  accountPub: HDKey,
  network: PearlNetwork,
  branch: HdBranch,
  start: number,
  count: number,
): string[] {
  const params = pearlParams(network);
  return branchPubkeys(accountPub, branch, start, count).map((pk) => pearlAddressFromCompressedPubkey(pk, params));
}

/** External + internal address lists for the given (clamped) counts. */
export function pearlAddressSetFromAccount(
  accountPub: HDKey,
  network: PearlNetwork,
  counts?: Partial<PearlBranchCounts>,
): { pearlPool: string[]; pearlChange: string[] } {
  return {
    pearlPool: pearlBranchAddressRange(accountPub, network, PEARL_EXTERNAL_BRANCH, 0, clampBranchCount(counts?.external)),
    pearlChange: pearlBranchAddressRange(accountPub, network, PEARL_INTERNAL_BRANCH, 0, clampBranchCount(counts?.internal)),
  };
}
