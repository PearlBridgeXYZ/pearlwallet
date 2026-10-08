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
  verifyBatchStillSpendable,
  type ConsolidationBatch,
  type ConsolidationPlan,
} from "../../services/pearl-consolidate";
import { clearPendingSpends, excludePendingSpends } from "../../services/pending-spends";
import type { PrlPoolScan } from "../../services/balances";
import { BroadcastStatusUnknownError } from "../../services/pearl-rpc";
import { prlScanQueryKey } from "../hooks/useWalletBalances";

type FeeTier = "low" | "normal" | "high";
// Same sat/vB tiers as Send. Combining coins is never urgent: default low.
const FEERATE_BY_TIER: Record<FeeTier, bigint> = { low: 1n, normal: 2n, high: 4n };
// Reuse the dashboard's coin list only when it is this fresh.
const UTXO_CACHE_FRESHNESS_MS = 30_000;

interface CoinSnapshot {
  utxos: PoolUtxo[];
  pendingCount: number;
  degraded: boolean;
  /** When the coins were read — the plan's review clock starts here. */
  fetchedAt: number;
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
  if (msg === "E_CONSOLIDATION_INPUTS_CHANGED" || msg === "E_CONSOLIDATION_INPUT_PENDING") {
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
    <li className="rounded-pb border border-line p-3">
      <div className="flex justify-between">
        <span className="font-medium">Batch {n}</span>
        <span>{batch.utxos.length} coins</span>
      </div>
      <dl className="mt-1 space-y-1 text-xs text-text-3 [&_dd]:font-mono [&_dd]:tabular-nums">
        <div className="flex justify-between">
          <dt>Combined</dt>
          <dd>{formatGrains(batch.inputGrains)} PRL</dd>
        </div>
        <div className="flex justify-between">
          <dt>
            Network fee ({batch.vbytes.toString()} vB × {batch.feerate.toString()} sat/vB)
          </dt>
          <dd>{formatGrains(batch.feeGrains)} PRL</dd>
        </div>
        <div className="flex justify-between font-medium text-text-2">
          <dt>You receive</dt>
          <dd>{formatGrains(batch.output.amountGrains)} PRL</dd>
        </div>
      </dl>
      {status && status.state !== "waiting" && (
        <div className="mt-2 text-xs">
          {status.state === "checking" && <span role="status" className="text-text-3">Re-checking coins…</span>}
          {status.state === "signing" && <span role="status" className="text-text-3">Signing and broadcasting…</span>}
          {status.state === "sent" && (
            <span>
              Sent: <span className="break-all font-mono">{status.txid}</span>{" "}
              <a
                href={explorer(status.txid)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
              >
                View on explorer →
              </a>
            </span>
          )}
          {status.state === "failed" && <span className="text-danger">{status.error}</span>}
        </div>
      )}
    </li>
  );
}

export default function Consolidate() {
  const queryClient = useQueryClient();
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const pool = useWallet((s) => s.addresses?.pearlPool ?? (s.addresses ? [s.addresses.pearl] : []));
  const changePool = useWallet((s) => s.addresses?.pearlChange);
  const deriveMore = useWallet((s) => s.derivePearlAddresses);
  const onDiscovered = useWallet((s) => s.extendPearlAddresses);

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
    queryFn: async (): Promise<CoinSnapshot> => {
      const cache = cachedScan?.spendable;
      if (!forceLive && cache && cache.utxos.length > 0 && Date.now() - cache.fetchedAt < UTXO_CACHE_FRESHNESS_MS) {
        const { spendable, pending } = excludePendingSpends(cache.utxos);
        return { utxos: spendable, pendingCount: pending.length, degraded: false, fetchedAt: cache.fetchedAt };
      }
      const live = await loadSpendableUtxos({ pool, changePool, deriveMore, onDiscovered });
      return { utxos: live.utxos, pendingCount: live.pending.length, degraded: live.degraded, fetchedAt: live.fetchedAt };
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
        // later batch is checked against a fresh scan first: every coin
        // must still be there, unchanged and not already being spent —
        // then it is signed exactly as reviewed, or not at all.
        let verifiedAt = coins.fetchedAt;
        if (i > 0) {
          st[i] = { state: "checking" };
          show();
          const live = await loadSpendableUtxos({ pool, changePool, deriveMore, onDiscovered });
          verifyBatchStillSpendable(batch, live.utxos);
          verifiedAt = live.fetchedAt;
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
          Many small coins (for example mining payouts) make sends larger and slower, and one
          transaction can spend at most 500 of them. Combining moves them into a few large
          coins at your own address. Nothing leaves your wallet except the network fee.
        </p>

        {coinsQ.isLoading && <p role="status" className="mt-3 text-sm text-text-3">Reading your coins…</p>}
        {coinsQ.isError && (
          <div className="mt-3 text-sm leading-relaxed text-danger">
            Couldn't read your coins: {(coinsQ.error as Error).message}{" "}
            <button className="inline-flex min-h-11 items-center underline underline-offset-4" onClick={rescan}>
              Rescan
            </button>
          </div>
        )}

        {coins && plan && (
          <>
            <dl className="mt-4 space-y-2 divide-y divide-line text-sm [&>div]:pt-2">
              <div className="flex justify-between">
                <dt className="text-text-3">Coins</dt>
                <dd>{plan.utxoCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-text-3">Total</dt>
                <dd>{formatGrains(plan.totalGrains)} PRL</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-text-3">Destination (your address)</dt>
                <dd className="min-w-0 max-w-[60%] break-all text-right font-mono text-xs">{plan.destination.address}</dd>
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
                      <div className="text-xs text-text-3">{FEERATE_BY_TIER[t].toString()} sat/vB</div>
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
                <ol className="mt-2 space-y-2 text-sm">
                  {plan.batches.map((b, i) => (
                    <BatchRow key={i} batch={b} n={i + 1} status={statuses[i]} explorer={explorer} />
                  ))}
                </ol>
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-text-3">Total network fees</dt>
                    <dd>{formatGrains(plan.totalFeeGrains)} PRL</dd>
                  </div>
                  <div className="flex justify-between font-medium">
                    <dt>You receive in total</dt>
                    <dd>{formatGrains(plan.totalReceiveGrains)} PRL</dd>
                  </div>
                </dl>
              </>
            )}

            {(plan.dust.count > 0 || plan.uneconomic.count > 0 || plan.leftover.count > 0 || plan.pendingExcluded > 0) && (
              <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-relaxed text-text-3">
                {plan.dust.count > 0 && (
                  <li>
                    {plan.dust.count} tiny coin{plan.dust.count === 1 ? "" : "s"} ({formatGrains(plan.dust.grains)} PRL)
                    skipped — each is worth less than the fee to spend it.
                  </li>
                )}
                {plan.uneconomic.count > 0 && (
                  <li>
                    {plan.uneconomic.count} coins ({formatGrains(plan.uneconomic.grains)} PRL) skipped — combining
                    them would cost more than 2% in fees at this tier. Try the Low tier.
                  </li>
                )}
                {plan.leftover.count > 0 && <li>1 coin left as it is — there's nothing to combine it with.</li>}
                {plan.pendingExcluded > 0 && (
                  <li>
                    {plan.pendingExcluded} coin{plan.pendingExcluded === 1 ? "" : "s"} skipped — already being spent
                    by a transaction this wallet broadcast recently.{" "}
                    {!running && (
                      <button
                        className="underline underline-offset-4"
                        onClick={() => {
                          clearPendingSpends();
                          rescan();
                        }}
                      >
                        Forget pending transactions
                      </button>
                    )}{" "}
                    (only if those transactions failed or were dropped)
                  </li>
                )}
              </ul>
            )}

            {!running && !finished && plan.batches.length > 0 && (
              <>
                <p className="mt-4 text-xs leading-relaxed text-text-3">
                  {fresh
                    ? `Plan fresh for ${secondsLeft}s. Each batch is signed exactly as shown; later batches are re-checked against a fresh scan first and the run stops at the first problem.`
                    : "This plan has expired. Rescan to review it again."}
                  {plan.batches.some((b) => b.utxos.length > 100) && " Signing a large batch can take several seconds."}
                </p>
                <p className="mt-2 text-sm font-medium text-warn">This cannot be undone.</p>
              </>
            )}

            {finished && (
              <p className="mt-4 text-sm">
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
        {planned?.error && <p className="mt-3 text-sm text-danger">Couldn't plan: {planned.error}</p>}
      </div>
    </Page>
  );
}
