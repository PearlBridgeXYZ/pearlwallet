// PearlBridge public /v1 API client — the data layer for native in-wallet
// bridging (wrap PRL→WPRL, unwrap WPRL→PRL).
//
// Design rules:
// - /v1 is read-only + open-CORS; it never holds keys and never signs.
//   All value movement happens in THIS wallet: a native Pearl send for
//   wraps, approve+requestBurn signed locally for unwraps.
// - Amounts are PRL grains (1 PRL = 1e8) as decimal strings on the wire;
//   bigint in memory. WPRL has 8 decimals — NOT 18 (classic trap).
// - Every response is shape-checked at the boundary; a malformed or
//   MITM'd response throws E_BRIDGE_API_SHAPE rather than propagating
//   undefined into amount math.

export const BRIDGE_V1_BASE = "https://api.pearlbridge.xyz/v1";

export const GRAINS_PER_PRL = 100_000_000n;

// Lifecycle classification pinned to the relay's ACTUAL emitted states
// (relay/src/ethereum/watcher.ts, src/relay/mint.ts, unlock.ts, db/*) —
// not the API doc vocabulary (audit M1/H3, round-2 re-audit).
//
//   mint: pending / queued / submitted / submitted_stuck / minted /
//         finalized / failed / cancelled / under_review (+ refunded via a
//         separate refundedAt field, NOT a state string)
//   burn: pending / signing / submitted / finalized / failed / reorged /
//         under_review
//
// "under_review" is a HOLD (can still resolve to minted/refunded), so it is
// NOT terminal — it gets its own phase so the UI stops saying "bridging".
// A mint with refundedAt set is terminal-refunded regardless of state.
export type CrossingOutcome = "ok" | "fail" | "refunded" | "review" | "pending";

export const MINT_TERMINAL_OK = new Set(["minted", "finalized"]);
export const MINT_TERMINAL_FAIL = new Set(["failed", "cancelled"]);
export const BURN_TERMINAL_OK = new Set(["finalized"]);
export const BURN_TERMINAL_FAIL = new Set(["failed", "reorged"]);

/** In-flight states the recovery tick may adopt — never terminal/fail/review
 *  (audit N1: stops dead or held mints from being resurrected as zombies). */
export const MINT_IN_FLIGHT = new Set(["pending", "queued", "signing", "submitted", "submitted_stuck"]);

// Known in-flight states (the relay's actual vocabulary). Anything outside
// these + the terminal/attention sets is UNKNOWN → classified "review" so a
// future relay state can never SILENTLY hang a crossing in "bridging"; it
// surfaces for attention instead (audit round-2 item 2).
const MINT_PENDING = new Set(["pending", "queued", "signing", "submitted", "submitted_stuck"]);
const BURN_PENDING = new Set(["pending", "signing", "submitted"]);

export function classifyMint(state: string | null, refunded: boolean): CrossingOutcome {
  if (refunded) return "refunded";
  if (!state) return "pending";
  if (MINT_TERMINAL_OK.has(state)) return "ok";
  if (MINT_TERMINAL_FAIL.has(state)) return "fail";
  if (MINT_PENDING.has(state)) return "pending";
  return "review"; // under_review OR any unknown future state — never silent
}

export function classifyBurn(state: string | null): CrossingOutcome {
  if (!state) return "pending";
  if (BURN_TERMINAL_OK.has(state)) return "ok";
  if (BURN_TERMINAL_FAIL.has(state)) return "fail";
  if (BURN_PENDING.has(state)) return "pending";
  return "review"; // under_review OR any unknown future state — never silent
}

export class BridgeApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function getJson(path: string, timeoutMs = 15_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_V1_BASE}${path}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok && res.status !== 404) {
      throw new BridgeApiError(`bridge API ${res.status} on ${path}`, res.status);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asObject(v: unknown, ctx: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`E_BRIDGE_API_SHAPE:${ctx}`);
  }
  return v as Record<string, unknown>;
}

function asGrains(v: unknown, ctx: string): bigint {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) {
    throw new Error(`E_BRIDGE_API_SHAPE:${ctx}`);
  }
  return BigInt(v);
}

/** Render grains as a fixed-point PRL string, trimming trailing zeros. */
export function grainsToPrlString(grains: bigint): string {
  const whole = grains / GRAINS_PER_PRL;
  const frac = (grains % GRAINS_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : whole.toString();
}

/** Parse a user-entered PRL amount into grains. Throws on bad input. */
export function prlToGrains(input: string): bigint {
  const m = input.trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error("E_AMOUNT_INVALID");
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(8, "0") || "0");
  return whole * GRAINS_PER_PRL + frac;
}

// ── Status / quotes ─────────────────────────────────────────────────────

export interface BridgeStatus {
  paused: boolean;
  mintFeeBps: number;
  burnFeeBps: number;
  fastMintWindowRemaining: bigint;
  mintWindowRemaining: bigint;
  burnWindowRemaining: bigint;
  slowMintDelaySeconds: number;
  pearlMinConfirmations: number;
  wprl: `0x${string}`;
  bridgeController: `0x${string}`;
}

export async function fetchBridgeStatus(): Promise<BridgeStatus> {
  const o = asObject(await getJson("/status"), "status");
  const limits = asObject(o.limits, "status.limits");
  const fees = asObject(o.fees, "status.fees");
  const confs = asObject(o.confirmations, "status.confirmations");
  const contracts = asObject(o.contracts, "status.contracts");
  if (typeof o.paused !== "boolean") throw new Error("E_BRIDGE_API_SHAPE:paused");
  return {
    paused: o.paused,
    mintFeeBps: Number(fees.mintFeeBps ?? 0),
    burnFeeBps: Number(fees.burnFeeBps ?? 0),
    fastMintWindowRemaining: asGrains(limits.fastMintWindowRemainingGrains, "fastWindow"),
    mintWindowRemaining: asGrains(limits.mintWindowRemainingGrains, "mintWindow"),
    burnWindowRemaining: asGrains(limits.burnWindowRemainingGrains, "burnWindow"),
    slowMintDelaySeconds: Number(limits.slowMintDelaySeconds ?? 86400),
    pearlMinConfirmations: Number(confs.pearlMinConfirmations ?? 6),
    wprl: String(contracts.wprl) as `0x${string}`,
    bridgeController: String(contracts.bridgeController) as `0x${string}`,
  };
}

export interface MintQuote {
  amount: bigint;
  feeBps: number;
  fee: bigint;
  net: bigint;
  lane: "fast" | "slow";
  slowLaneDelaySeconds: number;
  withinDailyCap: boolean;
  confirmationsRequired: number;
  paused: boolean;
}

export async function fetchMintQuote(amountGrains: bigint): Promise<MintQuote> {
  const o = asObject(await getJson(`/quote/mint?amountGrains=${amountGrains}`), "quote/mint");
  if (o.error) throw new Error(String(o.error));
  return {
    amount: asGrains(o.amountGrains, "qm.amount"),
    feeBps: Number(o.feeBps ?? 0),
    fee: asGrains(o.feeGrains, "qm.fee"),
    net: asGrains(o.netGrains, "qm.net"),
    lane: o.lane === "slow" ? "slow" : "fast",
    slowLaneDelaySeconds: Number(o.slowLaneDelaySeconds ?? 0),
    withinDailyCap: o.withinDailyCap !== false,
    confirmationsRequired: Number(o.confirmationsRequired ?? 6),
    paused: o.paused === true,
  };
}

export interface BurnQuote {
  amount: bigint;
  feeBps: number;
  fee: bigint;
  net: bigint;
  withinDailyCap: boolean;
  paused: boolean;
  addressValid: boolean | null;
  bridgeController: `0x${string}`;
  wprl: `0x${string}`;
}

export async function fetchBurnQuote(
  amountGrains: bigint,
  pearlAddress?: string,
): Promise<BurnQuote> {
  const q = pearlAddress ? `&pearlAddress=${encodeURIComponent(pearlAddress)}` : "";
  const o = asObject(await getJson(`/quote/burn?amountGrains=${amountGrains}${q}`), "quote/burn");
  if (o.error) throw new Error(String(o.error));
  const tx = asObject(o.transaction, "qb.transaction");
  const steps = Array.isArray(tx.steps) ? tx.steps : [];
  const approve = asObject(steps[0], "qb.approve");
  const burn = asObject(steps[1], "qb.burn");
  const addressCheck = o.addressCheck ? asObject(o.addressCheck, "qb.addr") : null;
  return {
    amount: asGrains(o.amountGrains, "qb.amount"),
    feeBps: Number(o.feeBps ?? 0),
    fee: asGrains(o.feeGrains, "qb.fee"),
    net: asGrains(o.netGrains, "qb.net"),
    withinDailyCap: o.withinDailyCap !== false,
    paused: o.paused === true,
    addressValid: addressCheck ? addressCheck.valid === true : null,
    // The quote's transaction plan carries the authoritative addresses;
    // the caller MUST cross-check them against the wallet's pinned
    // constants before signing (defense against a compromised API).
    wprl: String(approve.to) as `0x${string}`,
    bridgeController: String(burn.to) as `0x${string}`,
  };
}

export async function validatePearlAddress(addr: string): Promise<boolean> {
  const o = asObject(
    await getJson(`/validate-address?pearlAddress=${encodeURIComponent(addr)}`),
    "validate",
  );
  return o.valid === true;
}

// ── Wrap flow ───────────────────────────────────────────────────────────

export async function fetchDepositAddress(ethAddress: `0x${string}`): Promise<string> {
  const o = asObject(await getJson(`/deposit-address?ethAddress=${ethAddress}`), "deposit-address");
  if (o.error) throw new Error(String(o.error));
  const addr = o.pearlAddress;
  if (typeof addr !== "string" || !addr.startsWith("prl1")) {
    throw new Error("E_BRIDGE_API_SHAPE:depositAddress");
  }
  return addr;
}

// Trust-on-first-use for the wrap deposit address (audit H-2).
//
// The deposit address is HD-derived by the relay from the user's eth
// address; the wallet cannot derive it independently (no relay xpub), so a
// PERSISTENT API compromise that returns the same attacker address on every
// fetch defeats a same-session re-fetch check. TOFU narrows the window: we
// pin the FIRST address ever seen for an eth address and refuse forever
// after if it changes. The remaining exposure is a compromise active during
// the very first wrap — which the UI also surfaces for visual verification
// against pearlbridge.xyz. (Real fix tracked separately: relay publishes the
// derivation xpub for local verification.)
const DEPOSIT_TOFU_PREFIX = "bridge-deposit-tofu:";

export interface DepositTofuStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export async function resolveDepositAddress(
  ethAddress: `0x${string}`,
  store: DepositTofuStore,
): Promise<{ address: string; firstUse: boolean }> {
  const fresh = await fetchDepositAddress(ethAddress);
  const key = `${DEPOSIT_TOFU_PREFIX}${ethAddress.toLowerCase()}`;
  const pinned = await store.get(key);
  if (pinned === null) {
    await store.set(key, fresh);
    return { address: fresh, firstUse: true };
  }
  if (pinned !== fresh) {
    throw new Error(
      "E_DEPOSIT_ADDRESS_CHANGED — this wallet’s bridge deposit address differs from the one previously pinned. Stop and verify on pearlbridge.xyz before sending.",
    );
  }
  return { address: pinned, firstUse: false };
}

/**
 * Most recent in-flight deposit the relay has indexed for an eth address.
 * Recovery path (audit H2): if a wrap's native send broadcast but the local
 * tracking record was lost (tab closed mid-flight, IndexedDB write failed),
 * this re-adopts it once the relay sees the deposit. Returns null when the
 * relay has nothing in flight for the address.
 */
export interface RecentDeposit {
  txid: string;
  state: string;
  amountGrains: bigint;
  createdAt: number | null;
}

export async function fetchRecentDeposit(
  ethAddress: `0x${string}`,
): Promise<RecentDeposit | null> {
  const o = asObject(await getJson(`/deposits/recent?ethAddress=${ethAddress}`), "deposits/recent");
  if (!o.txid || typeof o.txid !== "string") return null;
  return {
    txid: o.txid,
    state: typeof o.state === "string" ? o.state : "pending",
    amountGrains: asGrains(o.amountGrains, "recent.amount"),
    createdAt: typeof o.createdAt === "number" ? o.createdAt : null,
  };
}

export interface PearlTxStatus {
  found: boolean;
  confirmations: number;
}

export async function fetchPearlTxStatus(txid: string): Promise<PearlTxStatus> {
  const o = asObject(await getJson(`/pearl-tx/${txid}`), "pearl-tx");
  if (o.found !== true) return { found: false, confirmations: 0 };
  return { found: true, confirmations: Number(o.confirmations ?? 0) };
}

export interface MintStatus {
  state: string | null;
  mintTxHash: `0x${string}` | null;
  cancelReason: string | null;
  anomalyReason: string | null;
  refunded: boolean;
  refundPrlTxId: string | null;
  readyAt: number | null;
}

export async function fetchMintStatus(pearlTxid: string): Promise<MintStatus> {
  const o = asObject(await getJson(`/mints/${pearlTxid}`), "mints");
  return {
    state: typeof o.state === "string" ? o.state : null,
    mintTxHash:
      typeof o.mintTxHash === "string" && o.mintTxHash.startsWith("0x")
        ? (o.mintTxHash as `0x${string}`)
        : null,
    cancelReason: typeof o.cancelReason === "string" ? o.cancelReason : null,
    anomalyReason: typeof o.anomalyReason === "string" ? o.anomalyReason : null,
    // A non-null refundedAt is the authoritative "this deposit was refunded
    // on Pearl" signal regardless of the underlying state (relay F-13).
    refunded: o.refundedAt != null,
    refundPrlTxId: typeof o.refundPrlTxId === "string" ? o.refundPrlTxId : null,
    readyAt: typeof o.readyAt === "number" ? o.readyAt : null,
  };
}

// ── Unwrap flow ─────────────────────────────────────────────────────────

export interface BurnStatus {
  state: string | null;
  pearlTxId: string | null;
  anomalyReason: string | null;
}

export async function fetchBurnStatus(ethTxHash: `0x${string}`): Promise<BurnStatus> {
  const o = asObject(await getJson(`/burns/${ethTxHash}`), "burns");
  return {
    state: typeof o.state === "string" ? o.state : null,
    pearlTxId: typeof o.pearlTxId === "string" ? o.pearlTxId : null,
    anomalyReason: typeof o.anomalyReason === "string" ? o.anomalyReason : null,
  };
}
