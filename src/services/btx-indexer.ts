// BTX indexer client — balance / UTXOs / history for a BTX address.
//
// btxd has no address index, so a thin server-side block-walk indexer runs
// behind the same CF edge as the RPC, at /idx/. This client GETs those
// endpoints with the same client-side pool failover as Pearl's RPC: on a 5xx/
// 429/network error it cools the endpoint down and rotates to the next pool
// member. A 400 (bad address) is NOT rotated — it's deterministic across the
// pool, so we surface it immediately.

import { BTX_RPC_POOL, btxParams } from "../chains/btx/network";
import { useUI } from "../state/ui-store";

const COOLDOWN_MS = 60_000;
const cooldownUntil = new Map<string, number>();

/** Bad address / client error — same answer on every endpoint, so don't rotate. */
export class BtxAddressError extends Error {}

/** Safely coerce a JSON sat value to bigint — a non-integer/float/null from the
 *  (rotatable) indexer throws rather than crashing the balance path. */
function toSat(v: unknown): bigint {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isInteger(n) || n < 0) throw new BtxAddressError("invalid sat value from indexer");
  return BigInt(n);
}

export interface BtxBalance {
  address: string;
  confirmedSat: bigint;
  utxoCount: number;
  tip: number;
}
export interface BtxUtxo {
  txid: string;
  vout: number;
  valueSat: bigint;
  height: number | null;
  coinbase: boolean;
  confirmations: number;
}
export interface BtxHistoryItem {
  txid: string;
  height: number;
  confirmations: number;
}

/** Ordered endpoint bases: a custom override first (if allowlisted), then the
 *  pool, least-recently-cooled first, de-duplicated. */
function endpointBases(override?: string): string[] {
  const params = btxParams("mainnet", override);
  const seed = params.rpcLabel === "custom" ? [params.rpcUrl, ...BTX_RPC_POOL] : [...BTX_RPC_POOL];
  const bases = Array.from(new Set(seed.map((u) => u.replace(/\/+$/, ""))));
  return bases.sort((a, b) => (cooldownUntil.get(a) ?? 0) - (cooldownUntil.get(b) ?? 0));
}

async function idxGet<T>(path: string, override?: string): Promise<T> {
  // Honour a user-set BTX RPC override (Settings) when the caller didn't pass one.
  const ov = (override ?? useUI.getState().btxRpcOverride ?? "").trim() || undefined;
  const bases = endpointBases(ov);
  let lastErr: unknown = new Error("no BTX endpoints configured");
  for (const base of bases) {
    const url = `${base}/idx/${path}`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 400) {
        throw new BtxAddressError("invalid or unsupported BTX address");
      }
      if (!res.ok) {
        cooldownUntil.set(base, Date.now() + COOLDOWN_MS);
        lastErr = new Error(`btx idx ${res.status}`);
        continue;
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof BtxAddressError) throw e; // deterministic — don't rotate
      cooldownUntil.set(base, Date.now() + COOLDOWN_MS);
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function fetchBtxBalance(address: string, override?: string): Promise<BtxBalance> {
  const r = await idxGet<{ address: string; confirmed_sat: number; utxo_count: number; tip: number }>(
    `address/${encodeURIComponent(address)}/balance`,
    override,
  );
  return { address: r.address, confirmedSat: toSat(r.confirmed_sat), utxoCount: r.utxo_count, tip: r.tip };
}

export async function fetchBtxUtxos(address: string, override?: string): Promise<BtxUtxo[]> {
  const r = await idxGet<
    Array<{ txid: string; vout: number; value_sat: number; height: number | null; coinbase: boolean; confirmations: number }>
  >(`address/${encodeURIComponent(address)}/utxos`, override);
  return r.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    valueSat: toSat(u.value_sat),
    height: u.height,
    coinbase: u.coinbase,
    confirmations: u.confirmations,
  }));
}

export async function fetchBtxHistory(address: string, override?: string): Promise<BtxHistoryItem[]> {
  return idxGet<BtxHistoryItem[]>(`address/${encodeURIComponent(address)}/history`, override);
}

/** Test seam: reset endpoint cooldowns between cases. */
export function _resetBtxIndexerCooldowns(): void {
  cooldownUntil.clear();
}
