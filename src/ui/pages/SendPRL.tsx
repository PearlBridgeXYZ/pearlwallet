import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { validPearl } from "../../lib/validate";
import { formatGrains, parsePRL } from "../../lib/format";
import { pearlTxExplorerUrl } from "../../chains/pearl/network";
import { tipAddressFor } from "../../chains/pearl/tip";
import {
  broadcastPearlPrecomposed,
  composePearlSend,
} from "../../services/pearl-tx";

type FeeTier = "low" | "normal" | "high";

// sat/vbyte by tier. Pearl mempool relay floor is ~1 sat/vbyte on
// btcd-derived nodes; we offer 1/2/4 so a fee-bump epoch doesn't strand
// a normal-tier tx but a low-tier still relays under quiet conditions.
const FEERATE_BY_TIER: Record<FeeTier, bigint> = {
  low: 1n,
  normal: 2n,
  high: 4n,
};

interface ValidatedSend {
  dest: string;
  grains: bigint;
}

// The Pearl pool walk is serialized across receive addresses and can
// take a few seconds on a cold sentry. A flat "Walking UTXOs…" line
// looked frozen — users assumed the page was broken. Cycle through a
// few status messages with a pulsing dot so it feels alive.
function ComposingHint() {
  const messages = [
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
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const pool = useWallet((s) => s.addresses?.pearlPool ?? (s.addresses ? [s.addresses.pearl] : []));

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [tier, setTier] = useState<FeeTier>("normal");
  const [stage, setStage] = useState<"compose" | "preview" | "sent">("compose");
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  // The per-tx tip checkbox always starts on, independent of any
  // previously persisted Settings toggle. The Settings page remains the
  // way to opt out of all tips going forward; this default keeps the
  // in-tx flow consistent with how the wallet should ship by default.
  const [tipThisTx, setTipThisTx] = useState(true);
  const [validated, setValidated] = useState<ValidatedSend | null>(null);
  const [sending, setSending] = useState(false);

  // Pre-flight: compose the tx so the user sees the actual fee + change
  // + UTXO count BEFORE clicking Send. Same composePearlSend the
  // broadcast path uses — no preview/broadcast drift. Refetches when any
  // input changes; tightly keyed on validated state so the compose stage
  // doesn't pre-walk the UTXO set on every keystroke.
  const previewQ = useQuery({
    queryKey: [
      "prl-preview",
      pool.join(","),
      tier,
      tipThisTx,
      validated?.dest,
      validated?.grains.toString(),
    ],
    enabled: stage === "preview" && !!validated && pool.length > 0,
    queryFn: async () => {
      const composed = await composePearlSend({
        network: pearlNetwork,
        pool,
        destination: validated!.dest,
        amountGrains: validated!.grains,
        feerateSatPerVbyte: FEERATE_BY_TIER[tier],
        includeTip: tipThisTx,
      });
      // Stamp so broadcast can refuse a stale preview. v0.1.9 audit
      // O2-H-1: a hostile sentry can return a different UTXO set on a
      // second walk — the user must sign the set they saw.
      return { ...composed, composedAt: Date.now() };
    },
  });

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
      const { composedAt, ...composed } = q;
      const { txid: hash } = await broadcastPearlPrecomposed(
        { composed, composedAt },
        pearlNetwork,
      );
      setTxid(hash);
      setStage("sent");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "E_PREVIEW_STALE") {
        setError("UTXO selection is stale — re-confirm to refresh.");
        previewQ.refetch();
      } else if (msg.includes("E_INSUFFICIENT_FUNDS")) {
        setError("Insufficient PRL to cover amount + fee.");
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
    const composed = previewQ.data;
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
                  <dd>{composed.utxos.length} UTXO{composed.utxos.length === 1 ? "" : "s"}</dd>
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

          {previewQ.isLoading && <ComposingHint />}
          {previewQ.isError && (
            <p className="mt-3 text-sm text-red-600">
              Couldn't compose: {(previewQ.error as Error).message}
            </p>
          )}
          {composed?.degraded && (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              Some receive addresses returned partial UTXO sets. The send
              may not use every available coin; consider retrying if it
              fails for insufficient funds.
            </div>
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
              disabled={!composed || sending}
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
