// Resolving broadcast records (services/pending-spends.ts) from what the
// node reports: "unknown" records, and "accepted" ones no scan settled
// within ACCEPTED_STALL_MS (the node may have evicted them). Nothing here releases on a timer or on a single negative
// answer:
//   found           getrawtransaction returns bytes hashing to the txid
//                   → the record becomes "accepted";
//   spent           the node lacks the tx and an address walk shows a
//                   DIFFERENT transaction spending one of its inputs (the
//                   walk also lists the funding output, so the node knows
//                   it) → ours can't confirm; the record is dropped;
//   absent-unspent  the node lacks the tx and complete walks list every
//                   input → the user may release it, explicitly; the release
//                   re-runs the check, then re-confirms the record and the
//                   tx's absence under the broadcast lock.
// An input that is merely missing from a walk proves nothing: the wallet
// spends unconfirmed coins, and an evicted unconfirmed funding tx makes its
// output vanish exactly like a spent one. That stays "unknown".
// A complete scan (dashboard, Send, Consolidate) that began after a record
// was made, lists none of its inputs and shows a spender of one of them
// settles it too: the address walk includes the mempool (evidence in
// pending-spends.ts).

import type { PrlPoolScan } from "./balances";
import { fetchPrlUtxos, fetchVerifiedRawTx, MAX_UTXO_WALK_PAGES_HARD, probePearlTx, rawTxOutputs } from "./pearl-rpc";
import {
  broadcastRecords,
  BroadcastRefusedError,
  isStalledAccepted,
  noteBroadcastUpdateFailed,
  outpointKey,
  resolveBroadcasts,
  withBroadcastLock,
  type BroadcastRecord,
} from "./pending-spends";

/** "unsaved": the result was certain (found / spent) but couldn't be saved,
 *  so the record is unchanged. */
export type BroadcastCheck = "found" | "spent" | "absent-unspent" | "unknown" | "unsaved";

/** "unspent" only when complete walks list every input; "spent" only when
 *  a walk shows a transaction other than `rec.txid` spending an input.
 *  Anything else (an input simply missing, a walk that failed, was capped
 *  or dropped an output for a missing script) is "unknown". */
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
  let complete = true;
  for (const a of addresses) {
    const w = await fetchPrlUtxos(a, { maxPages: MAX_UTXO_WALK_PAGES_HARD, priority: "high" }).catch(() => null);
    if (!w) return "unknown";
    if (spentElsewhere(rec, w.spentBy)) return "spent";
    // An output the node returned without its script is unlisted, not
    // spent: such a walk can't show the input unspent.
    if (w.degraded || w.droppedNoScript > 0) complete = false;
    for (const u of w.utxos) listed.add(outpointKey(u));
  }
  return complete && rec.inputs.every((o) => listed.has(o)) ? "unspent" : "unknown";
}

/** A walk saw a transaction other than the record's spend one of its inputs. */
function spentElsewhere(rec: BroadcastRecord, spentBy: ReadonlyMap<string, string> | undefined): boolean {
  if (!(spentBy instanceof Map)) return false;
  return rec.inputs.some((o) => {
    const s = spentBy.get(o);
    return s !== undefined && s !== rec.txid;
  });
}

const eligible = (txid: string): BroadcastRecord | undefined =>
  broadcastRecords().find((r) => r.txid === txid.toLowerCase() && (r.state === "unknown" || isStalledAccepted(r)));

async function inspect(txid: string): Promise<{ r: BroadcastCheck; rec?: BroadcastRecord }> {
  const rec = eligible(txid);
  if (!rec) return { r: "unknown" };
  const first = await probePearlTx(rec.txid);
  if (first !== "absent") return { r: first, rec };
  const inputs = await inputsState(rec);
  if (inputs === "unknown") return { r: "unknown", rec };
  // Ask again: the tx may have reached the node while the inputs were read.
  const again = await probePearlTx(rec.txid);
  return { r: again !== "absent" ? again : inputs === "spent" ? "spent" : "absent-unspent", rec };
}

function save(txid: string, r: BroadcastCheck): void {
  if (r === "found") resolveBroadcasts([txid], "accepted");
  if (r === "spent") resolveBroadcasts([txid], "forget");
}

/** Saves a certain result. "unsaved" when the lock was refused (another
 *  tab broadcasting) or the write failed (also shown by
 *  broadcastRecordIssue()); the record stays as it was until the next
 *  check or scan saves it. */
async function saveCertain(txid: string, r: BroadcastCheck): Promise<BroadcastCheck> {
  if (r !== "found" && r !== "spent") return r;
  try {
    await withBroadcastLock(async () => save(txid, r));
    return r;
  } catch (e) {
    if (e instanceof BroadcastRefusedError && e.reason === "storage") noteBroadcastUpdateFailed();
    return "unsaved";
  }
}

/** "Check status" of an "unknown" record (or an accepted one unsettled
 *  after ACCEPTED_STALL_MS); saves what is now certain ("unsaved" when
 *  that couldn't be saved). */
export async function checkBroadcast(txid: string): Promise<BroadcastCheck> {
  const { r } = await inspect(txid);
  return saveCertain(txid, r);
}

/** Manual release, after the user's explicit acknowledgement. Only
 *  "absent-unspent" forgets the record. Returns that check; throws a
 *  refusal when the lock isn't granted or the write fails.
 *  1. Wait for the lock once, so a broadcast in flight (possibly this
 *     record's own sender, suspended mid-submit) saves its outcome first.
 *  2. The full check (address walks, up to minutes on a long history) runs
 *     OUTSIDE the lock, so other broadcasts aren't refused meanwhile.
 *  3. Under the lock, cheaply: the record is still the same eligible one
 *     (a sender that ran meanwhile and was accepted changed it), and the
 *     node still lacks the tx. Only then is it forgotten. */
export async function releaseBroadcast(txid: string): Promise<BroadcastCheck> {
  await withBroadcastLock(async () => undefined);
  const { r, rec } = await inspect(txid);
  if (r !== "absent-unspent" || !rec) return saveCertain(txid, r);
  return withBroadcastLock(async () => {
    const now = eligible(txid);
    if (!now || now.state !== rec.state || now.createdAt !== rec.createdAt) return "unknown";
    const probe = await probePearlTx(txid);
    if (probe === "found") {
      save(txid, "found");
      return "found";
    }
    if (probe !== "absent") return "unknown";
    resolveBroadcasts([txid], "forget");
    return "absent-unspent";
  });
}

/** One address of a scan; complete = whole history read, nothing dropped;
 *  spentBy = spenders the walk saw (PrlUtxoSet.spentBy). */
export interface ScannedAddress {
  address: string;
  complete: boolean;
  utxos: readonly { txid: string; vout: number }[];
  spentBy?: ReadonlyMap<string, string>;
}

/** Settles every record that a scan begun after it was made read all of
 *  the addresses of completely, listing none of its inputs and showing a
 *  spender of at least one (its own txid: the node has it; another: it
 *  can't confirm). An input merely missing settles nothing (its funding tx
 *  may have been evicted). Skipped while a broadcast holds the lock; the
 *  next scan tries again. */
export async function noteScan(startedAt: number, results: readonly ScannedAddress[]): Promise<void> {
  const full = new Set(results.filter((r) => r.complete).map((r) => r.address));
  const listed = new Set(results.flatMap((r) => r.utxos.map(outpointKey)));
  const spent = new Set(results.flatMap((r) => (r.spentBy instanceof Map ? [...r.spentBy.keys()] : [])));
  const settled = () =>
    broadcastRecords()
      .filter((r) => r.addresses.length > 0 && r.createdAt < startedAt && r.addresses.every((a) => full.has(a)))
      .filter((r) => !r.inputs.some((o) => listed.has(o)) && r.inputs.some((o) => spent.has(o)))
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
      return { address, complete: !!ok && !ok.capped && !ok.degraded, utxos: ok?.utxos ?? [], spentBy: ok?.spentBy };
    }),
  );
}
