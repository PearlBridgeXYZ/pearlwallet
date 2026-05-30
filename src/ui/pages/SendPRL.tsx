import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { validPearl } from "../../lib/validate";
import { formatGrains, parsePRL } from "../../lib/format";
import { pearlTxExplorerUrl } from "../../chains/pearl/network";
import { tipAddressFor } from "../../chains/pearl/tip";
import {
  broadcastPearlPrecomposed,
  composePearlSend,
  composePearlSendDeepRetry,
  InsufficientFundsError,
  PEARL_PREVIEW_FRESHNESS_MS,
  PEARL_PREVIEW_REFRESH_AT_MS,
} from "../../services/pearl-tx";
import type { Balances } from "../../services/balances";

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
  grains: bigint;
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
    <div className="mt-3 flex items-center gap-2 text-xs text-ink-500">
      <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-pearl-600" />
      <span>{messages[idx]}</span>
    </div>
  );
}

export default function SendPRL() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const pool = useWallet((s) => s.addresses?.pearlPool ?? (s.addresses ? [s.addresses.pearl] : []));
  const addresses = useWallet((s) => s.addresses);

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [tier, setTier] = useState<FeeTier>("normal");
  const [stage, setStage] = useState<"compose" | "preview" | "sent">("compose");
  const [error, setError] = useState<string | null>(null);
  const [insufficient, setInsufficient] = useState<InsufficientFundsError | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [tipThisTx, setTipThisTx] = useState(true);
  const [validated, setValidated] = useState<ValidatedSend | null>(null);
  const [sending, setSending] = useState(false);
  // When true, force a deep walk on the next compose (used by the
  // "Search deeper" button after an InsufficientFundsError on a
  // degraded walk).
  const [deepWalk, setDeepWalk] = useState(false);

  // Read the dashboard's balance query out of the react-query cache so
  // we can re-use its UTXO walk instead of repeating it. Cache key
  // mirrors Dashboard.tsx exactly — if either side drifts, the cache
  // misses and we just fall through to a live walk.
  const balancesCacheKey = useMemo(
    () => [
      "balances",
      addresses?.pearlPool?.join(",") ?? addresses?.pearl,
      addresses?.eth,
      ethEnabled,
    ],
    [addresses, ethEnabled],
  );
  const cachedBalances = queryClient.getQueryData<Balances>(balancesCacheKey);
  const cachedUtxos =
    cachedBalances &&
    Date.now() - cachedBalances.prlUtxosFetchedAt < UTXO_CACHE_FRESHNESS_MS
      ? cachedBalances.prlUtxos
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
      deepWalk,
    ],
    enabled: stage === "preview" && !!validated && pool.length > 0,
    queryFn: async () => {
      const composed = deepWalk
        ? await composePearlSendDeepRetry({
            network: pearlNetwork,
            pool,
            destination: validated!.dest,
            amountGrains: validated!.grains,
            feerateSatPerVbyte: FEERATE_BY_TIER[tier],
            includeTip: tipThisTx,
          })
        : await composePearlSend({
            network: pearlNetwork,
            pool,
            destination: validated!.dest,
            amountGrains: validated!.grains,
            feerateSatPerVbyte: FEERATE_BY_TIER[tier],
            includeTip: tipThisTx,
            cachedUtxos,
          });
      return { ...composed, composedAt: Date.now() };
    },
    // Disable react-query's own retry — we surface InsufficientFundsError
    // structurally below and want the user to drive the deep-retry.
    retry: false,
  });

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
    let grains: bigint;
    try {
      grains = parsePRL(amount);
    } catch {
      return { ok: false, reason: "Enter a valid PRL amount." };
    }
    if (grains <= 0n) {
      return { ok: false, reason: "Amount must be greater than 0." };
    }
    return { ok: true, v: { dest: destination.trim(), grains } };
  }

  async function broadcast() {
    if (!validated) return;
    const q = previewQ.data;
    if (!q) return;
    setSending(true);
    setError(null);
    try {
      const { composedAt, ...c } = q;
      const { txid: hash } = await broadcastPearlPrecomposed(
        { composed: c, composedAt },
        pearlNetwork,
      );
      setTxid(hash);
      setStage("sent");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "E_PREVIEW_STALE") {
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
          <h2 className="text-lg font-semibold">Broadcast.</h2>
          <p className="mt-2 text-sm text-ink-500">
            Txid: <span className="break-all font-mono">{txid}</span>
          </p>
          <p className="mt-2 text-xs text-ink-500">
            Confirming on chain — this can take a few minutes.
          </p>
          {txid && (
            <a
              href={pearlTxExplorerUrl(pearlNetwork, txid)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-pearl-700 underline dark:text-pearl-300"
            >
              View on explorer →
            </a>
          )}
          <div className="mt-4 flex gap-2">
            <button onClick={() => navigate("/dashboard")} className="btn-primary flex-1">
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
        <div className="card">
          <h2 className="text-lg font-semibold">Confirm</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-500">To</dt>
              <dd className="break-all font-mono">{v?.dest}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Amount</dt>
              <dd>{v ? formatGrains(v.grains) : "—"} PRL</dd>
            </div>
            {composed && (
              <>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Fee ({tier})</dt>
                  <dd>{formatGrains(composed.feeGrains)} PRL</dd>
                </div>
                {composed.tipGrains > 0n && (
                  <div className="flex justify-between">
                    <dt className="text-ink-500">
                      Tip to PearlWallet Devs (10 bps, min 1 PRL)
                    </dt>
                    <dd>{formatGrains(composed.tipGrains)} PRL</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-ink-500">Change back to you</dt>
                  <dd>{formatGrains(composed.changeGrains)} PRL</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Inputs</dt>
                  <dd>
                    {composed.utxos.length} UTXO
                    {composed.utxos.length === 1 ? "" : "s"}
                    {composed.utxos.length > 50 && (
                      <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">
                        (large tx — signing may take a moment)
                      </span>
                    )}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-ink-200 pt-2 dark:border-ink-700">
                  <dt className="font-medium">Total leaving wallet</dt>
                  <dd className="font-medium">
                    {formatGrains(v!.grains + composed.feeGrains + composed.tipGrains)} PRL
                  </dd>
                </div>
              </>
            )}
          </dl>

          {previewQ.isLoading && <ComposingHint usingCache={!!cachedUtxos && !deepWalk} />}
          {previewQ.isFetching && !!composed && (
            <p className="mt-2 text-xs text-ink-500">Refreshing UTXO selection…</p>
          )}

          {/* Structured insufficient-funds diagnostic + deep-retry CTA. */}
          {insufficient && (
            <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-900/20 dark:text-red-200">
              <div className="font-medium">Not enough spendable PRL for this send.</div>
              <ul className="mt-1 list-disc pl-4">
                <li>Need: {formatGrains(insufficient.need)} PRL (amount + fee + tip)</li>
                <li>
                  Found: {formatGrains(insufficient.have)} PRL across{" "}
                  {insufficient.utxoCount} UTXO
                  {insufficient.utxoCount === 1 ? "" : "s"}
                </li>
                <li>
                  Short by: {formatGrains(insufficient.need - insufficient.have)} PRL
                </li>
              </ul>
              {insufficient.degraded && (
                <div className="mt-2">
                  The UTXO walk hit its page cap before scanning everything —
                  the chain may hold more coins than shown.
                  <button
                    className="ml-2 underline"
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

          {previewQ.isError && !insufficient && (
            <p className="mt-3 text-sm text-red-600">
              Couldn't compose: {(previewQ.error as Error).message}
            </p>
          )}
          {composed?.degraded && !insufficient && (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              Some receive addresses returned partial UTXO sets. The send
              composed successfully but the visible balance may under-report
              your actual chain balance.
            </div>
          )}

          {composed && composeFresh && (
            <p className="mt-2 text-xs text-ink-500">
              Preview fresh for {secondsToStale}s
              {composed.spendableGrains > 0n && (
                <>
                  {" · "}
                  {formatGrains(composed.spendableGrains)} PRL across{" "}
                  {composed.spendableUtxoCount} UTXO
                  {composed.spendableUtxoCount === 1 ? "" : "s"} spendable
                </>
              )}
            </p>
          )}

          <label className="mt-4 flex items-start gap-2 rounded-xl border border-ink-200 p-3 text-sm dark:border-ink-700">
            <input
              type="checkbox"
              checked={tipThisTx}
              onChange={(e) => setTipThisTx(e.target.checked)}
              className="mt-1"
            />
            <span>
              Tip the PearlWallet devs{" "}
              <span className="font-medium">10 bps</span> (min{" "}
              <span className="font-medium">1 PRL</span>) on this transaction.
              <span className="ml-1 text-xs text-ink-500">
                You can turn this off permanently in{" "}
                <Link to="/settings" className="underline">Settings</Link>
                {" "}— the wallet is free to use.
              </span>
            </span>
          </label>
          <p className="mt-2 break-all text-xs text-ink-500">
            Tip goes to <span className="font-mono">{tipAddressFor(pearlNetwork)}</span>.
          </p>
          <p className="mt-4 text-sm text-amber-700 dark:text-amber-400">
            This cannot be undone.
          </p>

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button onClick={() => setStage("compose")} className="btn-secondary" disabled={sending}>
              Back
            </button>
            <button
              disabled={!composed || sending || !!insufficient}
              onClick={broadcast}
              className="btn-primary flex-1"
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
      <div className="card flex flex-col gap-3">
        <label className="block">
          <span className="label">Destination address</span>
          <input
            className="input mono"
            placeholder="prl1p..."
            value={destination}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">Amount (PRL)</span>
          <input
            className="input mono"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <fieldset>
          <legend className="label">Fee tier</legend>
          <div className="grid grid-cols-3 gap-2">
            {(["low", "normal", "high"] as FeeTier[]).map((t) => (
              <label
                key={t}
                className={
                  tier === t
                    ? "cursor-pointer rounded-xl border-2 border-pearl-700 bg-pearl-50 p-3 text-center text-sm dark:bg-pearl-900/30"
                    : "cursor-pointer rounded-xl border border-ink-300 p-3 text-center text-sm dark:border-ink-700"
                }
              >
                <input
                  type="radio"
                  className="sr-only"
                  checked={tier === t}
                  onChange={() => setTier(t)}
                />
                <div className="font-medium capitalize">{t}</div>
                <div className="text-xs text-ink-500">
                  {FEERATE_BY_TIER[t].toString()} sat/vB
                </div>
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="text-sm text-red-600">{error}</p>}

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
          className="btn-primary"
        >
          Review
        </button>
      </div>
    </Page>
  );
}
