// Resolving broadcast records (services/pending-spends.ts) from what the
// node reports. Nothing here releases on a timer or on a single negative
// answer:
//   found           getrawtransaction returns bytes hashing to the txid
//                   → the record becomes "accepted";
//   spent           the node lacks the tx and a complete walk of an input's
//                   address no longer lists that input (another tx spent it;
//                   ours can never confirm) → the record is dropped;
//   absent-unspent  the node lacks the tx and complete walks list every
//                   input → the user may release it, explicitly; the release
//                   repeats the whole check inside the broadcast lock.
// A complete scan (dashboard, Send, Consolidate) that began after a record
// was made and lists none of its inputs settles it too: the address walk
// includes the mempool (evidence in pending-spends.ts).

import type { PrlPoolScan } from "./balances";
import { fetchPrlUtxos, fetchVerifiedRawTx, MAX_UTXO_WALK_PAGES_HARD, probePearlTx, rawTxOutputs } from "./pearl-rpc";
import {
  broadcastRecords,
  outpointKey,
  resolveBroadcasts,
  withBroadcastLock,
  type BroadcastRecord,
} from "./pending-spends";

export type BroadcastCheck = "found" | "spent" | "absent-unspent" | "unknown";

/** "unspent" only when complete walks list every input; "spent" when a
 *  complete walk of an input's address misses it. */
async function inputsState(rec: BroadcastRecord): Promise<"unspent" | "spent" | "unknown"> {
  const addresses = new Set(rec.addresses);
  if (addresses.size === 0) {
    // Not recorded (offline broadcast): read each funding tx's output.
    for (const o of rec.inputs) {
      const [funding, vout] = o.split(":") as [string, string];
      const raw = await fetchVerifiedRawTx(funding);
      const a = raw ? rawTxOutputs(raw)?.[Number(vout)]?.address : null;
      if (!a) return "unknown";
      addresses.add(a);
    }
  }
  const listed = new Set<string>();
  for (const a of addresses) {
    const w = await fetchPrlUtxos(a, { maxPages: MAX_UTXO_WALK_PAGES_HARD, priority: "high" }).catch(() => null);
    if (!w || w.degraded) return "unknown";
    for (const u of w.utxos) listed.add(outpointKey(u));
  }
  return rec.inputs.every((o) => listed.has(o)) ? "unspent" : "spent";
}

async function inspect(txid: string): Promise<BroadcastCheck> {
  const rec = broadcastRecords().find((r) => r.txid === txid.toLowerCase() && r.state === "unknown");
  if (!rec) return "unknown";
  const first = await probePearlTx(rec.txid);
  if (first !== "absent") return first;
  const inputs = await inputsState(rec);
  if (inputs === "unknown") return "unknown";
  // Ask again: the tx may have reached the node while the inputs were read.
  const again = await probePearlTx(rec.txid);
  return again !== "absent" ? again : inputs === "spent" ? "spent" : "absent-unspent";
}

function save(txid: string, r: BroadcastCheck): void {
  if (r === "found") resolveBroadcasts([txid], "accepted");
  if (r === "spent") resolveBroadcasts([txid], "forget");
}

/** "Check status" of an "unknown" record; saves what is now certain. */
export async function checkBroadcast(txid: string): Promise<BroadcastCheck> {
  const r = await inspect(txid);
  if (r === "found" || r === "spent") {
    await withBroadcastLock(async () => save(txid, r)).catch(() => {
      /* saved by the next check or scan */
    });
  }
  return r;
}

/** Manual release, after the user's explicit acknowledgement. Inside the
 *  lock (so no tab is mid-broadcast) the check is repeated; only
 *  "absent-unspent" forgets the record. Returns that check; throws a
 *  refusal when the lock isn't granted or the write fails. */
export async function releaseBroadcast(txid: string): Promise<BroadcastCheck> {
  return withBroadcastLock(async () => {
    const r = await inspect(txid);
    save(txid, r);
    if (r === "absent-unspent") resolveBroadcasts([txid], "forget");
    return r;
  });
}

/** One address of a scan; complete = whole history read, nothing dropped. */
export interface ScannedAddress {
  address: string;
  complete: boolean;
  utxos: readonly { txid: string; vout: number }[];
}

/** Settles every record that a scan begun after it was made read all of
 *  the addresses of completely, listing none of its inputs. Skipped while
 *  a broadcast holds the lock; the next scan tries again. */
export async function noteScan(startedAt: number, results: readonly ScannedAddress[]): Promise<void> {
  const full = new Set(results.filter((r) => r.complete).map((r) => r.address));
  const listed = new Set(results.flatMap((r) => r.utxos.map(outpointKey)));
  const settled = () =>
    broadcastRecords()
      .filter((r) => r.addresses.length > 0 && r.createdAt < startedAt && r.addresses.every((a) => full.has(a)))
      .filter((r) => !r.inputs.some((o) => listed.has(o)))
      .map((r) => r.txid);
  if (settled().length === 0) return;
  await withBroadcastLock(async () => resolveBroadcasts(settled(), "forget"), { ifAvailable: true }).catch(() => {
    /* busy or unsaved: the next scan settles it */
  });
}

/** noteScan for a wallet / pool scan (fire and forget). */
export function notePoolScan(scan: Pick<PrlPoolScan, "startedAt" | "pool" | "perAddress">): void {
  void noteScan(
    scan.startedAt,
    scan.pool.map((address, i) => {
      const r = scan.perAddress[i];
      const ok = r?.status === "ok" ? r : null;
      return { address, complete: !!ok && !ok.capped && !ok.degraded, utxos: ok?.utxos ?? [] };
    }),
  );
}
