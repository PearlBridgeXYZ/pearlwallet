// Number/amount formatting helpers.

const PRL_DECIMALS = 8;
// WPRL is the ERC-20 wrapper of PRL and shares its 8 decimals — VERIFIED
// on-chain (decimals() == 8 at 0x07696DcaB55E62cfef953666b29Fe1970518cB00,
// 2026-06-10). NOT 18. A prior 18 here mis-rendered every WPRL balance and
// mis-scaled every WPRL send by 10^10. Native ETH (below) really is 18.
const WPRL_DECIMALS = 8;
const ETH_DECIMALS = 18;

export function formatGrains(grains: bigint, decimals = PRL_DECIMALS): string {
  const neg = grains < 0n;
  const abs = neg ? -grains : grains;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return `${neg ? "-" : ""}${whole.toString()}.0`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}

/** Format a native-ETH wei amount (18 decimals). */
export function formatWei(wei: bigint, decimals = ETH_DECIMALS): string {
  return formatGrains(wei, decimals);
}

/** Format a WPRL base-unit amount (8 decimals). */
export function formatWprl(units: bigint): string {
  return formatGrains(units, WPRL_DECIMALS);
}

export function parsePRL(amount: string): bigint {
  return parseDecimal(amount, PRL_DECIMALS);
}

/** Parse a user WPRL amount into 8-decimal base units. */
export function parseWPRL(amount: string): bigint {
  return parseDecimal(amount, WPRL_DECIMALS);
}

/** Parse a user native-ETH amount into 18-decimal wei. */
export function parseEth(amount: string): bigint {
  return parseDecimal(amount, ETH_DECIMALS);
}

export function parseDecimal(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  // Reject negative and empty/dot-only inputs at the boundary. Every caller
  // (SendPRL/SendWPRL/Bridge amount fields) is a positive transfer amount;
  // a negative value silently coerced past validation would underflow the
  // balance check (`amount <= balance` passes for negatives) and could be
  // mis-rendered by formatGrains downstream.
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("E_INVALID_AMOUNT");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new Error("E_TOO_MANY_DECIMALS");
  const fracPadded = frac.padEnd(decimals, "0");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

export function formatUSD(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Truncate an address for display: "prl1p...abc" or "0x1234...abcd". */
export function shortAddr(addr: string, head = 7, tail = 4): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
