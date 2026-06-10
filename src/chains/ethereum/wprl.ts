// WPRL ERC-20. ABI subset for read + transfer + permit (EIP-2612 if supported).
// WPRL is the ERC-20 wrapper of PRL; decimals() == 8 on-chain (verified
// 2026-06-10 at 0x07696DcaB55E62cfef953666b29Fe1970518cB00).

import { erc20Abi } from "viem";

export const WPRL_ABI = erc20Abi;

// WPRL has 8 decimals (same as native PRL), NOT 18.
export const WPRL_DEFAULT_DECIMALS = 8;
