// WPRL ERC-20. ABI subset for read + transfer + permit (EIP-2612 if supported).
// Contract addresses + decimals TBD per docs/11 Q4, Q5.

import { erc20Abi } from "viem";

export const WPRL_ABI = erc20Abi;

// Verify decimals at runtime (Q5). Default assumption: 18.
export const WPRL_DEFAULT_DECIMALS = 18;
