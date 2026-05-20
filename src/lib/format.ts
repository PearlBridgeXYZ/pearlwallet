// Number/amount formatting helpers.

const PRL_DECIMALS = 8;
const WPRL_DECIMALS = 18;

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

export function formatWei(wei: bigint, decimals = WPRL_DECIMALS): string {
  return formatGrains(wei, decimals);
}

export function parsePRL(amount: string): bigint {
  return parseDecimal(amount, PRL_DECIMALS);
}

export function parseWPRL(amount: string): bigint {
  return parseDecimal(amount, WPRL_DECIMALS);
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
