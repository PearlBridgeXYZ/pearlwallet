// Outpoints spent by transactions this wallet broadcast recently.
//
// Why: the UTXO walk may not reflect the mempool, and the dashboard's
// cached spendable set can be up to 30 s old. Without this list a send or
// a consolidation batch composed right after another broadcast could pick
// coins that are already being spent — the node rejects the conflict at
// best, and a re-run consolidation would try to spend the same coins
// twice. Every successful (or status-unknown) Pearl broadcast records its
// inputs here; coin selection and consolidation planning exclude them.
//
// Entries expire after PENDING_SPEND_TTL_MS. By then the spending tx has
// either confirmed (the coins are gone from every walk) or was dropped
// (the coins are spendable again). The Consolidate screen can also clear
// the list by hand.
//
// Storage: localStorage when available (survives reloads, so a re-run
// after a refresh is still protected), else process memory. Contents are
// public chain data (outpoints + txids), no key material.

export const PENDING_SPEND_TTL_MS = 6 * 60 * 60 * 1000;
export const PENDING_SPENDS_STORAGE_KEY = "pearl-wallet-pending-spends-v1";
/** Bound on stored entries so a corrupted or hostile value can't grow
 *  without limit. Several full consolidation batches fit comfortably. */
const MAX_ENTRIES = 20_000;

export interface PendingSpend {
  /** "txid:vout" of the spent coin (txid lower-case). */
  outpoint: string;
  /** Txid of the spending transaction, when known. */
  spentBy: string | null;
  recordedAt: number;
}

let memory: PendingSpend[] = [];

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function outpointKey(u: { txid: string; vout: number }): string {
  return `${u.txid.toLowerCase()}:${u.vout}`;
}

function isEntry(e: unknown): e is PendingSpend {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.outpoint === "string" &&
    /^[0-9a-f]{64}:\d+$/.test(x.outpoint) &&
    (x.spentBy === null || typeof x.spentBy === "string") &&
    typeof x.recordedAt === "number" &&
    Number.isFinite(x.recordedAt)
  );
}

function load(): PendingSpend[] {
  const s = storage();
  if (!s) return memory;
  try {
    const raw = s.getItem(PENDING_SPENDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function save(entries: PendingSpend[]): void {
  const bounded = entries.slice(-MAX_ENTRIES);
  const s = storage();
  if (!s) {
    memory = bounded;
    return;
  }
  try {
    s.setItem(PENDING_SPENDS_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Quota / partitioned storage: keep the protection for this session.
    memory = bounded;
  }
}

function live(entries: PendingSpend[], now: number): PendingSpend[] {
  // A recordedAt in the future (clock moved back) is treated as fresh, not
  // dropped — failing safe means keeping the exclusion.
  return entries.filter((e) => now - e.recordedAt < PENDING_SPEND_TTL_MS);
}

/** Records that `spentBy` (null when the txid is unknown) spends `inputs`. */
export function recordPendingSpends(
  spentBy: string | null,
  inputs: readonly { txid: string; vout: number }[],
  now: number = Date.now(),
): void {
  const entries = live(load(), now);
  const have = new Set(entries.map((e) => e.outpoint));
  for (const u of inputs) {
    const k = outpointKey(u);
    if (have.has(k)) continue;
    have.add(k);
    entries.push({ outpoint: k, spentBy: spentBy ? spentBy.toLowerCase() : null, recordedAt: now });
  }
  save(entries);
}

/** Outpoints spent by a recent broadcast that may not be visible yet. */
export function pendingOutpoints(now: number = Date.now()): Set<string> {
  return new Set(live(load(), now).map((e) => e.outpoint));
}

export function pendingSpendList(now: number = Date.now()): PendingSpend[] {
  return live(load(), now);
}

/** Splits `utxos` into spendable and already-being-spent coins. */
export function excludePendingSpends<T extends { txid: string; vout: number }>(
  utxos: readonly T[],
  now: number = Date.now(),
): { spendable: T[]; pending: T[] } {
  const p = pendingOutpoints(now);
  const spendable: T[] = [];
  const pending: T[] = [];
  for (const u of utxos) (p.has(outpointKey(u)) ? pending : spendable).push(u);
  return { spendable, pending };
}

export function clearPendingSpends(): void {
  memory = [];
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(PENDING_SPENDS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
