import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { validPearl } from "../../lib/validate";
import { formatGrains, parsePRL } from "../../lib/format";
import { pearlTxExplorerUrl } from "../../chains/pearl/network";
import { TIP_POLICY_TEXT, tipAddressFor, tipPercentOfSend } from "../../chains/pearl/tip";
import {
  broadcastPearlPrecomposed,
  composePearlSend,
  composePearlSendDeepRetry,
  DUST_LIMIT_GRAINS,
  computeMaxSendable,
  loadSpendableUtxos,
  HistoryIncompleteError,
  InsufficientFundsError,
  NoSpendableCoinsError,
  TooManyInputsError,
  UtxoScanIncompleteError,
  MAX_SEND_INPUTS,
  PEARL_PREVIEW_FRESHNESS_MS,
  PEARL_PREVIEW_REFRESH_AT_MS,
  type MaxSendable,
} from "../../services/pearl-tx";
import type { PrlPoolScan } from "../../services/balances";
import { BroadcastStatusUnknownError, MAX_UTXO_WALK_PAGES_HARD } from "../../services/pearl-rpc";
import { prlScanQueryKey } from "../hooks/useWalletBalances";
import { PendingSpendConflictError, unresolvedBroadcasts } from "../../services/pending-spends";
import { refusalMessage } from "../components/PendingBroadcasts";
import { dustAmountMessage } from "../pearl-messages";
import { usePendingSpendsVersion } from "../hooks/usePendingSpends";

type FeeTier = "low" | "normal" | "high";

// sat/vbyte by tier. Pearl mempool relay floor is ~1 sat/vbyte on
// btcd-derived nodes; we offer 1/2/4 so a fee-bump epoch doesn't strand
// a normal-tier tx but a low-tier still relays under quiet conditions.
const FEERATE_BY_TIER: Record<FeeTier, bigint> = {
  low: 1n,
  normal: 2n,
  high: 4n,
};

// Cache freshness window for re-using the Dashboard's UTXO walk in
// Send. Shorter than PEARL_PREVIEW_FRESHNESS_MS because we want fresh
// coins at compose time; the preview-stamp window covers the user's
// pause between compose and click.
const UTXO_CACHE_FRESHNESS_MS = 30_000;

interface ValidatedSend {
  dest: string;
  /** Requested amount; ignored when `max` is set. */
  grains: bigint;
  /** "Send max": the amount is computed at compose time from the coins,
   *  fee tier and tip choice (services/pearl-tx computeMaxSendable). */
  max: boolean;
}

// The Pearl pool walk is serialized across receive addresses and can
// take a few seconds on a cold sentry. A flat "Walking UTXOs…" line
// looked frozen — users assumed the page was broken. Cycle through a
// few status messages with a pulsing dot so it feels alive.
function ComposingHint({ usingCache }: { usingCache: boolean }) {
  const messages = usingCache
    ? [
        "Using cached coins from your dashboard…",
        "Picking the smallest set that covers this send…",
      ]
    : [
        "Walking your receive-address pool…",
        "Reading UTXOs from the Pearl sentry…",
        "Picking the smallest set of coins…",
        "Almost there — a pool walk takes a few seconds.",
      ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => (i + 1 < messages.length ? i + 1 : i));
    }, 1500);
    return () => clearInterval(t);
  }, [messages.length]);
  return (
    <div role="status" className="mt-3 flex items-center gap-2 text-xs text-text-3 leading-relaxed">
      <span className="inline-flex h-2 w-2 animate-pulse motion-reduce:animate-none rounded-full bg-accent-bg" />
      <span>{messages[idx]}</span>
    </div>
  );
}

export default function SendPRL() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const pool = useWallet((s) => s.addresses?.pearlPool ?? (s.addresses ? [s.addresses.pearl] : []));
  const changePool = useWallet((s) => s.addresses?.pearlChange);
  const deriveMore = useWallet((s) => s.derivePearlAddresses);

  const [destination, setDestination] = useState("");
  // While any earlier broadcast's status is unknown it may already have
  // paid (any address), so sending needs the user's explicit "may pay
  // twice" acknowledgement — of exactly the broadcasts shown when it was
  // given (the service refuses any other).
  const [ackTxids, setAckTxids] = useState<string[] | null>(null);
  usePendingSpendsVersion();
  const unresolved = unresolvedBroadcasts();
  const acked = unresolved.every((r) => ackTxids?.includes(r.txid));
  const [amount, setAmount] = useState("");
  const [sendMax, setSendMax] = useState(false);
  const [tier, setTier] = useState<FeeTier>("normal");
  // "unknown": a broadcast whose outcome could not be determined. The
  // preview is gone (no re-quote, no second Send) until the user checks
  // that transaction's status.
  const [stage, setStage] = useState<"compose" | "preview" | "sent" | "unknown">("compose");
  const [unknownTxid, setUnknownTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [insufficient, setInsufficient] = useState<InsufficientFundsError | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  // Per-tx tip toggle, seeded from the Settings preference (which promises
  // that turning the tip off means no tip output is ever added).
  const [tipThisTx, setTipThisTx] = useState(() => useUI.getState().tipEnabled);
  const [validated, setValidated] = useState<ValidatedSend | null>(null);
  const [sending, setSending] = useState(false);
  // When true, force a deep walk on the next compose (used by the
  // "Search deeper" button after an InsufficientFundsError on a
  // degraded walk).
  const [deepWalk, setDeepWalk] = useState(false);

  // Read the dashboard's PRL pool scan out of the react-query cache so we
  // can re-use its UTXO walk instead of repeating it. v0.7: the key is
  // built by the same helper the dashboard hook uses (prlScanQueryKey),
  // and we read ONLY `spendable`, which the scan sets solely when that
  // single fresh scan was complete — partial scans and the dashboard's
  // keep-last-good display values can never reach coin selection. On a
  // miss (or a stale/partial scan) composePearlSend walks live.
  const cachedScan = queryClient.getQueryData<PrlPoolScan>(prlScanQueryKey(pool));
  const cachedUtxos =
    cachedScan?.spendable &&
    Date.now() - cachedScan.spendable.fetchedAt < UTXO_CACHE_FRESHNESS_MS
      ? cachedScan.spendable.utxos
      : undefined;

  // Pre-flight: compose the tx so the user sees the actual fee + change
  // + UTXO count BEFORE clicking Send. When the dashboard's UTXO cache
  // is fresh we reuse it (Preview opens instantly); otherwise we walk
  // live with the default depth. A "Search deeper" retry forces a fresh
  // walk at the hard maximum depth.
  const previewQ = useQuery({
    queryKey: [
      "prl-preview",
      pool.join(","),
      tier,
      tipThisTx,
      validated?.dest,
      validated?.grains.toString(),
      validated?.max,
      deepWalk,
    ],
    enabled: stage === "preview" && !!validated && pool.length > 0,
    queryFn: async ({ signal }) => {
      // Bound to the address generation at walk START: a walk that raced
      // an address reset can't persist its (longer) list afterwards.
      const onDiscovered = useWallet.getState().pearlDiscoveryHandler();
      if (validated!.max) {
        // Send max: price the largest amount these coins can send at this
        // fee tier and tip choice, then compose exactly that amount over
        // the same coin set (no change output).
        let utxos = cachedUtxos && cachedUtxos.length > 0 && !deepWalk ? cachedUtxos : null;
        // Warnings of the walk the coins came from travel with them (the
        // dashboard cache is only ever a complete scan).
        let from = { degraded: false, historyIncomplete: 0 };
        if (!utxos) {
          const live = await loadSpendableUtxos({
            pool,
            changePool,
            deriveMore,
            onDiscovered,
            maxPages: deepWalk ? MAX_UTXO_WALK_PAGES_HARD : undefined,
            signal,
          });
          if (live.utxos.length === 0) {
            throw new NoSpendableCoinsError(live.addressesScanned, live.pending.length, live.degraded);
          }
          utxos = live.utxos;
          from = { degraded: live.degraded, historyIncomplete: live.historyIncomplete };
        }
        const max = computeMaxSendable({
          utxos,
          feerateSatPerVbyte: FEERATE_BY_TIER[tier],
          includeTip: tipThisTx,
        });
        if (max.amountGrains <= 0n) {
          throw new Error("E_NOTHING_TO_SEND: your spendable coins don't cover the network fee at this fee tier");
        }
        const composed = await composePearlSend({
          network: pearlNetwork,
          pool,
          changePool,
          deriveMore,
          onDiscovered,
          destination: validated!.dest,
          amountGrains: max.amountGrains,
          feerateSatPerVbyte: FEERATE_BY_TIER[tier],
          includeTip: tipThisTx,
          cachedUtxos: utxos,
          cachedFrom: from,
          signal,
        });
        return { ...composed, composedAt: Date.now(), max: max as MaxSendable | null };
      }
      const composed = deepWalk
        ? await composePearlSendDeepRetry({
            network: pearlNetwork,
            pool,
            changePool,
            deriveMore,
            onDiscovered,
            destination: validated!.dest,
            amountGrains: validated!.grains,
            feerateSatPerVbyte: FEERATE_BY_TIER[tier],
            includeTip: tipThisTx,
            signal,
          })
        : await composePearlSend({
            network: pearlNetwork,
            pool,
            changePool,
            deriveMore,
            onDiscovered,
            destination: validated!.dest,
            amountGrains: validated!.grains,
            feerateSatPerVbyte: FEERATE_BY_TIER[tier],
            includeTip: tipThisTx,
            cachedUtxos,
            signal,
          });
      return { ...composed, composedAt: Date.now(), max: null as MaxSendable | null };
    },
    // Disable react-query's own retry — we surface InsufficientFundsError
    // structurally below and want the user to drive the deep-retry.
    retry: false,
  });

  // Structured compose errors → specific diagnostics (combine coins,
  // empty wallet vs incomplete scan, both with a rescan).
  const tooMany = previewQ.isError && previewQ.error instanceof TooManyInputsError ? previewQ.error : null;
  const noCoins = previewQ.isError && previewQ.error instanceof NoSpendableCoinsError ? previewQ.error : null;
  const scanIncomplete =
    previewQ.isError && previewQ.error instanceof UtxoScanIncompleteError ? previewQ.error : null;
  const historyIncomplete =
    previewQ.isError && previewQ.error instanceof HistoryIncompleteError ? previewQ.error : null;

  // Rescan: walk the wallet live at the deepest page depth, ignoring the
  // dashboard's cached coins.
  function rescan() {
    setInsufficient(null);
    if (!deepWalk) setDeepWalk(true);
    else void previewQ.refetch();
  }

  // Capture InsufficientFundsError out of the query error so the UI
  // can render structured diagnostics + a "Search deeper" CTA.
  useEffect(() => {
    if (previewQ.isError && previewQ.error instanceof InsufficientFundsError) {
      setInsufficient(previewQ.error);
    } else if (!previewQ.isError) {
      setInsufficient(null);
    }
  }, [previewQ.isError, previewQ.error]);

  // Background re-quote: if a fresh preview is sitting on screen and
  // approaches the staleness window, refetch silently so the click-Send
  // moment lands on fresh coins. The user sees the input count update
  // but no spinner takes over — the existing composed preview stays
  // visible until the new one arrives.
  const composed = previewQ.data;
  const composedAgeMs = composed ? Date.now() - composed.composedAt : 0;
  useEffect(() => {
    if (!composed || stage !== "preview") return;
    const elapsed = Date.now() - composed.composedAt;
    const refreshIn = Math.max(0, PEARL_PREVIEW_REFRESH_AT_MS - elapsed);
    const t = setTimeout(() => {
      previewQ.refetch();
    }, refreshIn);
    return () => clearTimeout(t);
  }, [composed, stage, previewQ]);

  // Tick-driver for the countdown render. setInterval rather than
  // rAF — we only need second-level resolution for the visible timer.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!composed || stage !== "preview") return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [composed, stage]);

  const secondsToStale = composed
    ? Math.max(0, Math.ceil((PEARL_PREVIEW_FRESHNESS_MS - composedAgeMs) / 1000))
    : 0;
  const composeFresh = composedAgeMs < PEARL_PREVIEW_FRESHNESS_MS;

  function checkSend(): { ok: true; v: ValidatedSend } | { ok: false; reason: string } {
    if (!validPearl(destination, pearlNetwork)) {
      return { ok: false, reason: "That doesn't look like a valid Pearl address." };
    }
    if (!acked) {
      return {
        ok: false,
        reason:
          "An earlier broadcast has an unknown status. Check it in the banner above, or confirm that you accept paying twice.",
      };
    }
    if (sendMax) {
      return { ok: true, v: { dest: destination.trim(), grains: 0n, max: true } };
    }
    let grains: bigint;
    try {
      grains = parsePRL(amount);
    } catch {
      return { ok: false, reason: "Enter a valid PRL amount." };
    }
    if (grains <= 0n) {
      return { ok: false, reason: "Amount must be greater than 0." };
    }
    if (grains <= DUST_LIMIT_GRAINS) {
      return { ok: false, reason: dustAmountMessage() };
    }
    return { ok: true, v: { dest: destination.trim(), grains, max: false } };
  }

  async function broadcast() {
    if (!validated) return;
    const q = previewQ.data;
    if (!q) return;
    // Re-checked at click time (another tab may have broadcast since the
    // review); the service checks again inside the broadcast lock.
    if (!acked) {
      setError(
        "An earlier broadcast has an unknown status. Go back and check it, or confirm that you accept paying twice.",
      );
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { composedAt, max: _max, ...c } = q;
      const { txid: hash } = await broadcastPearlPrecomposed(
        { composed: c, composedAt },
        pearlNetwork,
        Date.now(),
        ackTxids ?? [],
      );
      setTxid(hash);
      setStage("sent");
      // The dashboard's coin list is now out of date (as after Combine).
      void queryClient.invalidateQueries({ queryKey: prlScanQueryKey(pool) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof BroadcastStatusUnknownError) {
        // The tx may already be in the mempool — never call this a failure,
        // and never leave a live preview that could send a second payment.
        setUnknownTxid(e.txid);
        setStage("unknown");
        void queryClient.invalidateQueries({ queryKey: prlScanQueryKey(pool) });
      } else if (e instanceof PendingSpendConflictError) {
        setError("A coin in this preview is already being spent by another transaction from this wallet — refreshing…");
        previewQ.refetch();
      } else if (refusalMessage(e)) {
        setError(refusalMessage(e));
      } else if (msg === "E_PREVIEW_STALE") {
        setError("UTXO selection expired — refreshing…");
        previewQ.refetch();
      } else if (msg.includes("E_NO_UTXOS")) {
        setError("No spendable UTXOs found across your receive pool.");
      } else {
        setError(`Broadcast failed: ${msg}`);
      }
    } finally {
      setSending(false);
    }
  }

  if (stage === "sent") {
    return (
      <Page title="Send PRL">
        <div className="card">
          <h2 className="text-lg font-semibold tracking-tight">Transaction broadcast</h2>
          <p className="mt-2 text-sm text-text-3 leading-relaxed break-words">
            Txid: <span className="break-all font-mono min-w-0 tabular-nums">{txid}</span>
          </p>
          <p className="mt-2 text-xs text-text-3 leading-relaxed break-words">
            Confirming on chain — this can take a few minutes.
          </p>
          {txid && (
            <a
              href={pearlTxExplorerUrl(pearlNetwork, txid)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-4 leading-relaxed"
            >
              View on explorer →
            </a>
          )}
          <div className="mt-4 flex gap-2">
            <button onClick={() => navigate("/dashboard")} className="btn-primary flex-1 min-w-11">
              Back to dashboard
            </button>
          </div>
        </div>
      </Page>
    );
  }

  if (stage === "unknown") {
    return (
      <Page title="Send PRL">
        <div className="card">
          <h2 className="text-lg font-semibold tracking-tight">Broadcast status unknown</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-2">
            The network didn't confirm receipt. The transaction may already be on its way, so its
            coins stay reserved and any new payment needs your explicit go-ahead until it's resolved.
            Check it in the banner above — it stays there on every screen.
          </p>
          {unknownTxid && (
            <p className="mt-2 text-sm text-text-3 leading-relaxed break-words">
              Txid: <span className="break-all font-mono min-w-0 tabular-nums">{unknownTxid}</span>
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <button onClick={() => navigate("/dashboard")} className="btn-primary flex-1 min-w-11">
              Back to dashboard
            </button>
          </div>
        </div>
      </Page>
    );
  }

  if (stage === "preview") {
    const v = validated;
    return (
      <Page title="Send PRL">
        <div className="card shadow-slabsm sm:shadow-slab">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Transaction preview</p>
          <h2 className="text-xl font-semibold tracking-tight">Review before you sign</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-2">Check the destination, amount and fees. A transfer cannot be undone.</p>
          <dl className="mt-3 space-y-2 text-sm leading-relaxed divide-y divide-line [&>div]:grid [&>div]:grid-cols-1 [&>div]:gap-2 [&>div]:py-3 sm:[&>div]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-[.12em] [&_dd]:min-w-0 [&_dd]:text-left sm:[&_dd]:text-right">
            <div>
              <dt className="text-text-3">To</dt>
              <dd className="break-all font-mono min-w-0 tabular-nums">{v?.dest}</dd>
            </div>
            <div>
              <dt className="text-text-3">Amount{v?.max ? " (max)" : ""}</dt>
              <dd className="break-words font-mono tabular-nums">
                {composed ? formatGrains(composed.amountGrains) : v && !v.max ? formatGrains(v.grains) : "—"} PRL
              </dd>
            </div>
            {composed && (
              <>
                <div>
                  <dt className="text-text-3">Fee ({tier})</dt>
                  <dd className="break-words font-mono tabular-nums">{formatGrains(composed.feeGrains)} PRL</dd>
                </div>
                {composed.tipGrains > 0n && (
                  <div>
                    <dt className="text-text-3">
                      Developer tip ({tipPercentOfSend(composed.tipGrains, composed.amountGrains)} of this send)
                    </dt>
                    <dd className="break-words font-mono tabular-nums">{formatGrains(composed.tipGrains)} PRL</dd>
                  </div>
                )}
                <div>
                  <dt className="text-text-3">Change back to you</dt>
                  <dd className="break-words font-mono tabular-nums">{formatGrains(composed.changeGrains)} PRL</dd>
                </div>
                <div>
                  <dt className="text-text-3">Inputs</dt>
                  <dd>
                    {composed.utxos.length} UTXO
                    {composed.utxos.length === 1 ? "" : "s"}
                    {composed.utxos.length > 50 && (
                      <span className="ml-1 text-xs text-warn leading-relaxed">
                        (large tx — signing may take a moment)
                      </span>
                    )}
                  </dd>
                </div>
                <div className="border-t border-line pt-2">
                  <dt className="font-medium">Total leaving wallet</dt>
                  <dd className="break-words font-mono font-medium tabular-nums">
                    {formatGrains(composed.amountGrains + composed.feeGrains + composed.tipGrains)} PRL
                  </dd>
                </div>
              </>
            )}
          </dl>

          {previewQ.isLoading && <ComposingHint usingCache={!!cachedUtxos && !deepWalk} />}
          {previewQ.isFetching && !!composed && (
            <p role="status" className="mt-2 text-xs text-text-3 leading-relaxed break-words">Refreshing UTXO selection…</p>
          )}

          {/* Structured insufficient-funds diagnostic + deep-retry CTA. */}
          {insufficient && (
            <div className="mt-3 rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger">
              <div className="font-medium">Not enough spendable PRL for this send.</div>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>Need: <span className="font-mono tabular-nums">{formatGrains(insufficient.need)} PRL</span> (amount + fee + tip)</li>
                <li>
                  Found: <span className="font-mono tabular-nums">{formatGrains(insufficient.have)} PRL</span> across{" "}
                  <span className="font-mono tabular-nums">{insufficient.utxoCount}</span> UTXO
                  {insufficient.utxoCount === 1 ? "" : "s"}
                </li>
                <li>
                  Short by: <span className="font-mono tabular-nums">{formatGrains(insufficient.need - insufficient.have)} PRL</span>
                </li>
              </ul>
              {insufficient.degraded && (
                <div className="mt-2">
                  The UTXO walk hit its page cap before scanning everything —
                  the chain may hold more coins than shown.
                  <button
                    className="ml-2 inline-flex min-h-11 min-w-11 items-center underline underline-offset-4"
                    onClick={() => {
                      setDeepWalk(true);
                      setInsufficient(null);
                      previewQ.refetch();
                    }}
                  >
                    Search deeper
                  </button>
                </div>
              )}
            </div>
          )}

          {composed?.max?.capped && (
            <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn">
              One transaction can spend at most {MAX_SEND_INPUTS} coins, so this sends your largest{" "}
              {MAX_SEND_INPUTS}. {composed.max.cappedOutCount} more coin
              {composed.max.cappedOutCount === 1 ? "" : "s"} stay in your wallet.{" "}
              <Link to="/consolidate" className="font-medium underline underline-offset-4">Combine your coins</Link> to send everything at once.
            </div>
          )}
          {composed?.max && !composed.max.exact && (
            <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn">
              With the tip on, sends of 1 PRL or more carry a 1 PRL minimum tip your coins can't
              cover, so the most you can send is just under 1 PRL. Turn the tip off below to send
              everything.
            </div>
          )}

          {tooMany && (
            <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn">
              <h3 className="text-base font-semibold text-heading">Combine your coins first</h3>
              <p className="mt-1">
                This amount needs {tooMany.inputsNeeded} coins, but one transaction can spend at
                most {tooMany.maxInputs}. Your {tooMany.utxoCount} coins hold{" "}
                {formatGrains(tooMany.spendableGrains)} PRL. Combining them into a few larger
                coins makes this send possible.
              </p>
              {tooMany.maxSendableGrains > 0n && (
                <p className="mt-1">
                  Right now one transaction can send up to {formatGrains(tooMany.maxSendableGrains)} PRL.
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <Link to="/consolidate" className="btn-primary tap inline-flex">
                  Combine small coins
                </Link>
                <button className="inline-flex min-h-11 items-center underline underline-offset-4" onClick={rescan} disabled={previewQ.isFetching}>
                  Rescan
                </button>
              </div>
            </div>
          )}

          {noCoins && (
            <div className="mt-3 rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger">
              <h3 className="text-base font-semibold">No spendable PRL found</h3>
              <p className="mt-1">
                {noCoins.pendingCount > 0
                  ? `Every coin found (${noCoins.pendingCount}) is already being spent by a transaction this wallet just broadcast. Wait for it to confirm, then rescan.`
                  : `All ${noCoins.addressesScanned} wallet addresses answered and none holds a coin right now. If you just received PRL it may not be visible yet.`}
              </p>
              <button className="mt-1 inline-flex min-h-11 items-center underline underline-offset-4" onClick={rescan} disabled={previewQ.isFetching}>
                Rescan
              </button>
            </div>
          )}

          {scanIncomplete && (
            <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn">
              <h3 className="text-base font-semibold">Couldn't finish reading your wallet</h3>
              <p className="mt-1">
                {scanIncomplete.failures} of {scanIncomplete.addressesScanned} addresses didn't
                answer (the Pearl network is busy). Your coins aren't missing. Try again.
              </p>
              <button className="mt-1 inline-flex min-h-11 items-center underline underline-offset-4" onClick={rescan} disabled={previewQ.isFetching}>
                Rescan
              </button>
            </div>
          )}

          {historyIncomplete && (
            <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn">
              <h3 className="text-base font-semibold">History incomplete</h3>
              <p className="mt-1">
                {historyIncomplete.incompleteAddresses} of {historyIncomplete.addressesScanned} addresses have more
                history than was read. Their coins can't be used until the whole history is read.
              </p>
              <button className="mt-1 inline-flex min-h-11 items-center underline underline-offset-4" onClick={rescan} disabled={previewQ.isFetching}>
                Search deeper
              </button>
            </div>
          )}

          {previewQ.isError && !insufficient && !tooMany && !noCoins && !scanIncomplete && !historyIncomplete && (
            <p className="mt-3 rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger break-words [overflow-wrap:anywhere]">
              Couldn't compose: {(previewQ.error as Error).message}
            </p>
          )}
          {composed && composed.historyIncomplete > 0 && !insufficient && (
            <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn">
              {composed.historyIncomplete} address{composed.historyIncomplete === 1 ? " has" : "es have"} more
              history than was read; {composed.historyIncomplete === 1 ? "its" : "their"} coins are not used in
              this send.{" "}
              <button className="inline-flex min-h-11 items-center underline underline-offset-4" onClick={rescan} disabled={previewQ.isFetching}>
                Search deeper
              </button>
            </div>
          )}
          {composed?.degraded && !insufficient && (
            <div className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-7 text-warn">
              Some receive addresses returned partial UTXO sets. The send
              composed successfully but the visible balance may under-report
              your actual chain balance.
            </div>
          )}

          {composed && !composeFresh && (
            <p className="mt-3 text-xs leading-6 text-warn">
              This preview has expired.{" "}
              <button
                className="inline-flex min-h-11 items-center underline underline-offset-4"
                onClick={() => void previewQ.refetch()}
                disabled={previewQ.isFetching}
              >
                Rescan
              </button>{" "}
              to review it again.
            </p>
          )}
          {composed && composeFresh && (
            <p className="mt-3 text-xs leading-6 text-text-3">
              Preview fresh for <span className="font-mono tabular-nums">{secondsToStale}</span>s
              {composed.spendableGrains > 0n && (
                <>
                  {" · "}
                  <span className="font-mono tabular-nums">{formatGrains(composed.spendableGrains)} PRL</span> across{" "}
                  <span className="font-mono tabular-nums">{composed.spendableUtxoCount}</span> UTXO
                  {composed.spendableUtxoCount === 1 ? "" : "s"} spendable
                </>
              )}
            </p>
          )}

          <label className="mt-4 flex items-start gap-2 rounded-pb border border-line p-3 text-sm leading-relaxed">
            <input
              type="checkbox"
              checked={tipThisTx}
              onChange={(e) => setTipThisTx(e.target.checked)}
              className="mt-1"
            />
            <span>
              Include the optional developer tip on this transaction. {TIP_POLICY_TEXT}
              <span className="ml-1 text-xs text-text-3 leading-relaxed">
                You can turn this off permanently in{" "}
                <Link to="/settings" className="underline underline-offset-4">Settings</Link>
                {" "}— the wallet is free to use without it.
              </span>
            </span>
          </label>
          <p className="mt-2 text-xs leading-6 text-text-3 break-words">
            Tip goes to <span className="font-mono break-all min-w-0 tabular-nums">{tipAddressFor(pearlNetwork)}</span>.
          </p>
          <p className="mt-4 text-sm text-warn leading-relaxed break-words">
            This cannot be undone.
          </p>

          {error && <p className="mt-3 rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger break-words [overflow-wrap:anywhere]">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button onClick={() => setStage("compose")} className="btn-secondary min-w-11" disabled={sending}>
              Back
            </button>
            <button
              disabled={!composed || !composeFresh || sending || !!insufficient || previewQ.isError}
              onClick={broadcast}
              className="btn-primary flex-1 min-w-11"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Send PRL">
      <div className="card flex flex-col gap-5 shadow-slabsm sm:shadow-slab">
        <label className="block">
          <span className="label">Destination address</span>
          <input
            className="input mono break-all min-w-0 tabular-nums"
            placeholder="prl1p..."
            value={destination}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => {
              setDestination(e.target.value);
            }}
          />
        </label>
        {unresolved.length > 0 && (
          <div role="alert" className="rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger">
            <p className="font-medium">
              {unresolved.length === 1
                ? "An earlier broadcast may already be on its way."
                : `${unresolved.length} earlier broadcasts may already be on their way.`}
            </p>
            <p className="mt-1">
              The network didn't confirm receipt
              {unresolved.some((r) => r.destination && r.destination === destination.trim().toLowerCase())
                ? ", and one of them pays this same address"
                : ""}
              . Check {unresolved.length === 1 ? "it" : "them"} in the banner above first — sending now could pay
              twice.
            </p>
            <label className="mt-2 flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-2"
                checked={acked}
                onChange={(e) => setAckTxids(e.target.checked ? unresolved.map((r) => r.txid) : null)}
              />
              <span>I understand this may pay twice. Send anyway.</span>
            </label>
          </div>
        )}
        <label className="block">
          <span className="label">Amount (PRL)</span>
          <div className="flex gap-2">
            <input
              className="input mono break-all min-w-0 flex-1 tabular-nums placeholder:font-sans"
              inputMode="decimal"
              value={sendMax ? "" : amount}
              placeholder={sendMax ? "Everything spendable (max)" : undefined}
              disabled={sendMax}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button
              type="button"
              className={sendMax ? "btn-primary min-h-11 min-w-14 self-stretch ring-2 ring-accent ring-offset-2 ring-offset-surface" : "btn-secondary min-h-11 min-w-14 self-stretch"}
              aria-pressed={sendMax}
              onClick={() => setSendMax((m) => !m)}
            >
              Max
            </button>
          </div>
          {sendMax && (
            <span className="mt-1 block text-xs text-text-3 leading-relaxed">
              Sends everything spendable minus the network fee
              {tipThisTx ? " and tip" : ""}; the exact amount is shown on the next screen.
            </span>
          )}
        </label>
        <fieldset>
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
                <input
                  type="radio"
                  className="sr-only"
                  checked={tier === t}
                  onChange={() => setTier(t)}
                />
                <div className="font-medium capitalize">{t}</div>
                <div className="font-mono text-xs tabular-nums text-text-3 leading-relaxed">
                  {FEERATE_BY_TIER[t].toString()} sat/vB
                </div>
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="rounded-pb border border-danger-line bg-danger-bg p-4 text-sm leading-7 text-danger break-words [overflow-wrap:anywhere]">{error}</p>}

        <button
          onClick={() => {
            const result = checkSend();
            if (!result.ok) {
              setError(result.reason);
              return;
            }
            setError(null);
            setDeepWalk(false);
            setInsufficient(null);
            setValidated(result.v);
            setStage("preview");
          }}
          className="btn-primary min-w-11"
        >
          Review
        </button>
      </div>
    </Page>
  );
}
