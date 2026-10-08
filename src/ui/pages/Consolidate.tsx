import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { formatGrains } from "../../lib/format";
import { pearlTxExplorerUrl } from "../../chains/pearl/network";
import { loadSpendableUtxos, PEARL_PREVIEW_FRESHNESS_MS, type PoolUtxo } from "../../services/pearl-tx";
import {
  broadcastConsolidationBatch,
  composeConsolidation,
  recheckConsolidationBatch,
  type ConsolidationBatch,
  type ConsolidationPlan,
} from "../../services/pearl-consolidate";
import { excludePendingSpends, pendingTransactions, PendingSpendConflictError } from "../../services/pending-spends";
import PendingTxCheck from "../components/PendingTxCheck";
import type { PrlPoolScan, WalletAddressRef } from "../../services/balances";
import { BroadcastStatusUnknownError } from "../../services/pearl-rpc";
import { prlScanQueryKey } from "../hooks/useWalletBalances";

type FeeTier = "low" | "normal" | "high";
// Same sat/vB tiers as Send. Combining coins is never urgent: default low.
// Low = 1 sat/vB = the Pearl relay floor, checked against the live network
// on 2026-10-08: the public node accepts transactions paying exactly
// 1.000 sat/vB of virtual size (0.75 sat per serialized byte) into its
// mempool and miners include them (one confirmed in the next block), and
// near-floor 1.003-1.008 sat/vB transactions confirm routinely. Fees here
// are ceil(weight / 4) x feerate, so the planned fee never falls below
// the floor. Re-check before raising the default.
const FEERATE_BY_TIER: Record<FeeTier, bigint> = { low: 1n, normal: 2n, high: 4n };
// Reuse the dashboard's coin list only when it is this fresh.
const UTXO_CACHE_FRESHNESS_MS = 30_000;

interface CoinSnapshot {
  utxos: PoolUtxo[];
  pendingCount: number;
  degraded: boolean;
  /** When the LAST coins were read (end of the walk) — the plan's review
   *  clock starts here. */
  fetchedAt: number;
  /** Addresses that walk read, with (branch, index): the primary address
   *  book for re-checking later batches. */
  refs: WalletAddressRef[];
}

type BatchStatus =
  | { state: "waiting" }
  | { state: "checking" }
  | { state: "signing" }
  | { state: "sent"; txid: string }
  | { state: "failed"; error: string };

function describeError(e: unknown): string {
  if (e instanceof BroadcastStatusUnknownError) {
    return (
      "Broadcast status unknown — the network didn't confirm receipt. " +
      (e.txid ? `Check the explorer for txid ${e.txid} ` : "Check the explorer ") +
      "before running this again."
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "E_PREVIEW_STALE") return "This plan is older than two minutes. Rescan and review it again.";
  if (msg === "E_CONSOLIDATION_RECHECK_INCOMPLETE") {
    return "Couldn't re-read every address holding this batch's coins. Rescan and try again — finished batches stay done.";
  }
  if (
    msg === "E_CONSOLIDATION_INPUTS_CHANGED" ||
    msg === "E_CONSOLIDATION_INPUT_PENDING" ||
    e instanceof PendingSpendConflictError
  ) {
    return "Some coins in this batch changed since you reviewed the plan. Rescan and review the new plan.";
  }
  if (msg === "E_LOCKED") return "The wallet locked. Unlock it and run this again — finished batches stay done.";
  return `Failed: ${msg}`;
}

function BatchRow({
  batch,
  n,
  status,
  explorer,
}: {
  batch: ConsolidationBatch;
  n: number;
  status: BatchStatus | undefined;
  explorer: (txid: string) => string;
}) {
  return (
    <tr role="row" className="grid grid-cols-1 gap-3 border-b border-line py-4 sm:grid-cols-[.6fr_.8fr_1.4fr_1.2fr] sm:gap-4 [&>td]:min-w-0">
      <th role="rowheader" scope="row" className="text-left font-semibold">Batch {n}</th>
      <td role="cell" className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 sm:block">
        <span aria-hidden="true" className="text-text-3 sm:hidden">Inputs (coins)</span>
        <div>
          <span className="tabular-nums">{batch.utxos.length}</span>
          <p className="mt-1 text-xs leading-6 text-text-3">Combined: <span className="break-words font-mono tabular-nums">{formatGrains(batch.inputGrains)} PRL</span></p>
        </div>
      </td>
      <td role="cell" className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 sm:block">
        <span aria-hidden="true" className="text-text-3 sm:hidden">Network fee</span>
        <div>
          <span className="break-words font-mono tabular-nums">{formatGrains(batch.feeGrains)} PRL</span>
          <p className="mt-1 text-xs leading-6 text-text-3">
            <span className="font-mono tabular-nums">{batch.vbytes.toString()} vB</span> × <span className="font-mono tabular-nums">{batch.feerate.toString()} sat/vB</span>
          </p>
        </div>
      </td>
      <td role="cell" className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 sm:block">
        <span aria-hidden="true" className="text-text-3 sm:hidden">You receive</span>
        <span className="break-words font-mono font-medium tabular-nums">{formatGrains(batch.output.amountGrains)} PRL</span>
        {status && status.state !== "waiting" && (
          <div className="col-span-2 mt-2 text-xs leading-6">
            {status.state === "checking" && <span role="status" className="text-text-3">Re-checking coins…</span>}
            {status.state === "signing" && <span role="status" className="text-text-3">Signing and broadcasting…</span>}
            {status.state === "sent" && (
              <span>
                Sent: <span className="break-all font-mono">{status.txid}</span>{" "}
                <a
                  href={explorer(status.txid)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
                >
                  View on explorer →
                </a>
              </span>
            )}
            {status.state === "failed" && <span className="break-words text-danger [overflow-wrap:anywhere]">{status.error}</span>}
          </div>
        )}
      </td>
    </tr>
  );
}

export default function Consolidate() {
  const queryClient = useQueryClient();
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const pool = useWallet((s) => s.addresses?.pearlPool ?? (s.addresses ? [s.addresses.pearl] : []));
  const changePool = useWallet((s) => s.addresses?.pearlChange);
  const deriveMore = useWallet((s) => s.derivePearlAddresses);

  const [tier, setTier] = useState<FeeTier>("low");
  const [forceLive, setForceLive] = useState(false);
  const [scanNonce, setScanNonce] = useState(0);
  const [running, setRunning] = useState(false);
  const [frozen, setFrozen] = useState<ConsolidationPlan | null>(null);
  const [statuses, setStatuses] = useState<BatchStatus[]>([]);
  const [finished, setFinished] = useState(false);

  const cachedScan = queryClient.getQueryData<PrlPoolScan>(prlScanQueryKey(pool));
  const coinsQ = useQuery({
    queryKey: ["consolidate-coins", pool.join(","), scanNonce],
    enabled: pool.length > 0 && !running,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }): Promise<CoinSnapshot> => {
      const cache = cachedScan?.spendable;
      if (!forceLive && cache && cache.utxos.length > 0 && Date.now() - cache.fetchedAt < UTXO_CACHE_FRESHNESS_MS) {
        const { spendable, pending } = excludePendingSpends(cache.utxos);
        return {
          utxos: spendable,
          pendingCount: pending.length,
          degraded: false,
          fetchedAt: cache.fetchedAt,
          refs: cachedScan.refs,
        };
      }
      const onDiscovered = useWallet.getState().pearlDiscoveryHandler();
      const live = await loadSpendableUtxos({ pool, changePool, deriveMore, onDiscovered, signal });
      return {
        utxos: live.utxos,
        pendingCount: live.pending.length,
        degraded: live.degraded,
        fetchedAt: live.fetchedAt,
        refs: live.refs,
      };
    },
  });
  const coins = coinsQ.data;

  const planned = useMemo(() => {
    if (!coins || pool.length === 0) return null;
    try {
      return {
        plan: composeConsolidation({
          utxos: coins.utxos,
          destination: { address: pool[0]!, branch: 0, index: 0 },
          feerateSatPerVbyte: FEERATE_BY_TIER[tier],
          // The snapshot already split off coins of pending broadcasts.
          pendingAlreadyExcluded: coins.pendingCount,
        }),
        error: null,
      };
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [coins, tier, pool]);
  // While running (and after), show the plan exactly as confirmed.
  const plan = frozen ?? planned?.plan ?? null;

  // Review countdown (same window as Send's frozen preview).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!coins || running || finished) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [coins, running, finished]);
  const ageMs = coins ? Date.now() - coins.fetchedAt : 0;
  const fresh = !!coins && ageMs < PEARL_PREVIEW_FRESHNESS_MS;
  const secondsLeft = coins ? Math.max(0, Math.ceil((PEARL_PREVIEW_FRESHNESS_MS - ageMs) / 1000)) : 0;

  function rescan() {
    setForceLive(true);
    setFinished(false);
    setFrozen(null);
    setStatuses([]);
    setScanNonce((n) => n + 1);
  }

  async function run() {
    if (!plan || !coins || plan.batches.length === 0 || running) return;
    const batches = plan.batches;
    setFrozen(plan);
    setRunning(true);
    setFinished(false);
    const st: BatchStatus[] = batches.map(() => ({ state: "waiting" }));
    const show = () => setStatuses([...st]);
    show();
    let i = 0;
    try {
      for (; i < batches.length; i++) {
        const batch = batches[i]!;
        // Batch 1 was reviewed against the coins read at plan time. Each
        // later batch is checked first by re-reading only the addresses
        // that hold its coins: every coin must still be there, unchanged
        // and not already being spent — then it is signed exactly as
        // reviewed, or not at all. Its review clock restarts when that
        // re-read finishes.
        let verifiedAt = coins.fetchedAt;
        if (i > 0) {
          st[i] = { state: "checking" };
          show();
          const book = useWallet.getState().addresses;
          verifiedAt = await recheckConsolidationBatch(batch, {
            // The plan's own walk first: a coin on an address discovered by
            // that walk stays checkable even if persisting it failed.
            refs: coins.refs,
            external: book?.pearlPool ?? pool,
            internal: book?.pearlChange ?? changePool ?? [],
          });
        }
        st[i] = { state: "signing" };
        show();
        const r = await broadcastConsolidationBatch({ batch, verifiedAt }, pearlNetwork);
        st[i] = { state: "sent", txid: r.txid };
        show();
      }
    } catch (e) {
      st[i] = { state: "failed", error: describeError(e) };
      show();
    } finally {
      setRunning(false);
      setFinished(true);
      // The dashboard's coin list is now out of date.
      void queryClient.invalidateQueries({ queryKey: prlScanQueryKey(pool) });
    }
  }

  const sentCount = statuses.filter((s) => s.state === "sent").length;
  const explorer = (txid: string) => pearlTxExplorerUrl(pearlNetwork, txid);

  return (
    <Page title="Combine small coins">
      <div className="card shadow-slabsm sm:shadow-slab">
        <p className="text-sm leading-relaxed text-text-2">
          Many small payments (for example mining payouts) make sends slow and expensive, and one
          transaction can spend at most 500 coins. Combining moves them into a few large
          coins at your own address. Nothing leaves your wallet except the network fee.
        </p>

        {coinsQ.isLoading && <p role="status" className="mt-3 text-sm text-text-3">Reading your coins…</p>}
        {coinsQ.isError && (
          <div className="mt-4 rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger break-words [overflow-wrap:anywhere]">
            Couldn't read your coins: {(coinsQ.error as Error).message}{" "}
            <button className="inline-flex min-h-11 items-center underline underline-offset-4" onClick={rescan}>
              Rescan
            </button>
          </div>
        )}

        {coins && plan && (
          <>
            <dl className="mt-6 divide-y divide-line border-y border-line text-sm [&>div]:grid [&>div]:grid-cols-1 [&>div]:gap-2 [&>div]:py-3 sm:[&>div]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&_dd]:min-w-0 sm:[&_dd]:text-right">
              <div>
                <dt className="text-text-3">Coins</dt>
                <dd className="tabular-nums">{plan.utxoCount}</dd>
              </div>
              <div>
                <dt className="text-text-3">Total</dt>
                <dd className="break-words font-mono tabular-nums">{formatGrains(plan.totalGrains)} PRL</dd>
              </div>
              <div>
                <dt className="text-text-3">Destination (your address)</dt>
                <dd className="break-all font-mono text-xs leading-6">{plan.destination.address}</dd>
              </div>
            </dl>

            {!running && !finished && (
              <fieldset className="mt-4">
                <legend className="label">Fee tier</legend>
                <div className="grid grid-cols-3 gap-2">
                  {(["low", "normal", "high"] as FeeTier[]).map((t) => (
                    <label
                      key={t}
                      className={
                        tier === t
                          ? "cursor-pointer rounded-pb border-2 border-accent bg-accent-soft p-3 text-center text-sm min-h-11 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2 leading-relaxed"
                          : "cursor-pointer rounded-pb border border-line p-3 text-center text-sm min-h-11 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2 leading-relaxed"
                      }
                    >
                      <input type="radio" className="sr-only" checked={tier === t} onChange={() => setTier(t)} />
                      <div className="font-medium capitalize">{t}</div>
                      <div className="font-mono text-xs tabular-nums text-text-3">{FEERATE_BY_TIER[t].toString()} sat/vB</div>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {coins.degraded && (
              <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-3 text-xs text-warn leading-relaxed">
                Some addresses couldn't be read completely. The plan covers the coins that were
                found; rescan later to pick up the rest.
              </div>
            )}

            {plan.batches.length === 0 ? (
              <p className="mt-4 text-sm text-text-3">Nothing to combine right now.</p>
            ) : (
              <>
                <h2 className="mt-6 border-b border-line pb-2 text-lg font-semibold">
                  {plan.batches.length} transaction{plan.batches.length === 1 ? "" : "s"}
                </h2>
                <table role="table" aria-label="Consolidation plan" className="mt-3 block w-full text-left text-sm">
                  <thead role="rowgroup" className="sr-only sm:not-sr-only sm:block">
                    <tr role="row" className="grid grid-cols-[.6fr_.8fr_1.4fr_1.2fr] gap-4 border-b border-heading py-3 text-[11px] uppercase tracking-[.12em] text-text-3">
                      <th role="columnheader" scope="col">Batch</th>
                      <th role="columnheader" scope="col">Inputs (coins)</th>
                      <th role="columnheader" scope="col">Network fee</th>
                      <th role="columnheader" scope="col">You receive</th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup" className="block">
                    {plan.batches.map((b, i) => (
                      <BatchRow key={i} batch={b} n={i + 1} status={statuses[i]} explorer={explorer} />
                    ))}
                  </tbody>
                  <tfoot role="rowgroup" className="block border-b border-heading bg-surface-2 px-3">
                    <tr role="row" className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-2">
                      <th role="rowheader" scope="row" colSpan={2} className="font-normal text-text-3">Total network fees</th>
                      <td role="cell" colSpan={2} className="min-w-0 break-words font-mono tabular-nums sm:text-right">{formatGrains(plan.totalFeeGrains)} PRL</td>
                    </tr>
                    <tr role="row" className="grid grid-cols-1 gap-2 border-t border-line py-3 font-medium sm:grid-cols-2">
                      <th role="rowheader" scope="row" colSpan={2}>You receive in total</th>
                      <td role="cell" colSpan={2} className="min-w-0 break-words font-mono tabular-nums sm:text-right">{formatGrains(plan.totalReceiveGrains)} PRL</td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )}

            {(plan.dust.count > 0 || plan.uneconomic.count > 0 || plan.leftover.count > 0 || plan.pendingExcluded > 0) && (
              <ul className="mt-4 space-y-3 text-xs leading-6 text-warn [&>li]:rounded-pb [&>li]:border [&>li]:border-warn-line [&>li]:bg-warn-bg [&>li]:p-4">
                {plan.dust.count > 0 && (
                  <li>
                    {plan.dust.count} tiny coin{plan.dust.count === 1 ? "" : "s"} (<span className="font-mono tabular-nums">{formatGrains(plan.dust.grains)} PRL</span>)
                    skipped — each is worth less than the fee to spend it.
                  </li>
                )}
                {plan.uneconomic.count > 0 && (
                  <li>
                    {plan.uneconomic.count} coins (<span className="font-mono tabular-nums">{formatGrains(plan.uneconomic.grains)} PRL</span>) skipped — combining
                    them would cost more than 2% in fees at this tier. Try the Low tier.
                  </li>
                )}
                {plan.leftover.count > 0 && <li>1 coin left as it is — there's nothing to combine it with.</li>}
                {plan.pendingExcluded > 0 && (
                  <li>
                    {plan.pendingExcluded} coin{plan.pendingExcluded === 1 ? "" : "s"} skipped — already being spent
                    by a transaction this wallet broadcast recently. Check a transaction below; its coins can be
                    released only if the network doesn't have it.
                    {!running && (
                      <ul className="mt-2 space-y-3 text-text-2">
                        {pendingTransactions().map((t) => (
                          <li key={t.spentBy ?? "unknown"} className="border-t border-warn-line pt-2">
                            <div>
                              {t.coins} coin{t.coins === 1 ? "" : "s"}
                            </div>
                            <PendingTxCheck
                              txid={t.spentBy}
                              explorerUrl={t.spentBy ? explorer(t.spentBy) : undefined}
                              onReleased={rescan}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )}
              </ul>
            )}

            {!running && !finished && plan.batches.length > 0 && (
              <section className="mt-6 rounded-pb border border-line-strong bg-surface-2 p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Review before you sign</h2>
                <p className="mt-3 text-sm leading-7 text-text-2">
                  {fresh
                    ? `Plan fresh for ${secondsLeft}s. Each batch is signed exactly as shown; later batches are re-checked against a fresh scan first and the run stops at the first problem.`
                    : "This plan has expired. Rescan to review it again."}
                </p>
                {plan.batches.some((b) => b.utxos.length > 100) && (
                  <p className="mt-3 border-l-2 border-warn-line pl-3 text-sm leading-7 text-warn">
                    Signing a large batch can take several seconds. Keep this page open while the batches are signed and sent.
                  </p>
                )}
                <p className="mt-3 text-sm font-semibold text-warn">This cannot be undone.</p>
              </section>
            )}

            {finished && (
              <p role="status" className="mt-4 rounded-pb border border-line bg-surface-2 p-4 text-sm leading-7">
                {sentCount === plan.batches.length
                  ? "All batches broadcast. Your combined coins appear once the transactions confirm."
                  : `${sentCount} of ${plan.batches.length} batches broadcast. Rescan to plan the rest — coins already sent are skipped.`}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button onClick={rescan} className="btn-secondary min-w-11" disabled={running || coinsQ.isFetching}>
                Rescan
              </button>
              {!finished ? (
                <button
                  onClick={() => void run()}
                  className="btn-primary flex-1 min-w-11"
                  disabled={running || !fresh || plan.batches.length === 0 || coinsQ.isFetching}
                >
                  {running
                    ? "Combining…"
                    : `Combine ${plan.batches.reduce((a, b) => a + b.utxos.length, 0)} coins`}
                </button>
              ) : (
                <Link to="/dashboard" className="btn-primary flex-1 text-center">
                  Back to dashboard
                </Link>
              )}
            </div>
          </>
        )}
        {planned?.error && <p className="mt-4 rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger break-words [overflow-wrap:anywhere]">Couldn't plan: {planned.error}</p>}
      </div>
    </Page>
  );
}
