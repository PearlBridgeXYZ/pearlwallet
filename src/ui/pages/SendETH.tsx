import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { validEth } from "../../lib/validate";
import { formatWei, parseWPRL } from "../../lib/format";
import {
  estimateNativeGas,
  sendNative,
  suggestGas,
  type FeeTier,
} from "../../services/eth-tx";
import { fetchEthBalanceWei } from "../../services/balances";
import { ethTxExplorerUrl } from "../../chains/ethereum/network";

const GAS_BY_TIER: Record<FeeTier, string> = {
  low: "1 gwei",
  normal: "2 gwei",
  high: "3 gwei",
};

interface ValidatedSend {
  dest: `0x${string}`;
  wei: bigint;
}

export default function SendETH() {
  const navigate = useNavigate();
  const ethAddr = useWallet((s) => s.addresses?.eth as `0x${string}` | undefined);
  const ethNetwork = useWallet((s) => s.ethNetwork);

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [tier, setTier] = useState<FeeTier>("normal");
  const [stage, setStage] = useState<"compose" | "preview" | "sent">("compose");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [validated, setValidated] = useState<ValidatedSend | null>(null);
  const [sending, setSending] = useState(false);

  // Preview combines (a) the estimated gas cost the user will pay and
  // (b) a forward-looking solvency check: amount + worstCaseGas must fit
  // inside the current ETH balance. The check is conservative — the
  // mempool only burns `gasUsed * effectiveGasPrice`, not the full
  // `gas * maxFeePerGas` ceiling, so we may over-warn. Better than the
  // alternative (silently broadcast a tx that bounces).
  const previewQ = useQuery({
    queryKey: [
      "eth-preview",
      ethAddr,
      ethNetwork,
      tier,
      validated?.dest,
      validated?.wei.toString(),
    ],
    enabled: stage === "preview" && !!validated && !!ethAddr,
    queryFn: async () => {
      const [gas, fees, ethBal] = await Promise.all([
        estimateNativeGas(ethNetwork, ethAddr!, validated!.dest, validated!.wei),
        suggestGas(ethNetwork, tier),
        fetchEthBalanceWei(ethAddr!, ethNetwork),
      ]);
      const worstCaseWei = gas * fees.maxFeePerGas;
      const required = validated!.wei + worstCaseWei;
      return {
        gas,
        fees,
        ethBal,
        worstCaseWei,
        required,
        covered: ethBal >= required,
        // Stamp at compose time so broadcast can refuse a stale preview.
        // The user signs the numbers above, not a re-quote.
        composedAt: Date.now(),
      };
    },
  });

  function checkSend(): { ok: true; v: ValidatedSend } | { ok: false; reason: string } {
    if (!validEth(destination)) {
      return { ok: false, reason: "That doesn't look like a valid Ethereum address." };
    }
    let wei: bigint;
    try {
      // ETH uses 18 decimals — same as WPRL — so parseWPRL is the right
      // boundary parser. Keeps the precision rules consistent with the
      // other 18-decimal field in the app.
      wei = parseWPRL(amount);
    } catch {
      return { ok: false, reason: "Enter a valid ETH amount." };
    }
    if (wei <= 0n) {
      return { ok: false, reason: "Amount must be greater than 0." };
    }
    return { ok: true, v: { dest: destination.trim() as `0x${string}`, wei } };
  }

  async function broadcast() {
    if (!validated || !ethAddr) return;
    const q = previewQ.data;
    if (!q) return;
    setSending(true);
    setError(null);
    try {
      const { txHash: hash } = await sendNative({
        network: ethNetwork,
        from: ethAddr,
        to: validated.dest,
        value: validated.wei,
        tier,
        frozen: {
          gas: q.gas,
          maxFeePerGas: q.fees.maxFeePerGas,
          maxPriorityFeePerGas: q.fees.maxPriorityFeePerGas,
          composedAt: q.composedAt,
        },
      });
      setTxHash(hash);
      setStage("sent");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "E_PREVIEW_STALE") {
        setError("Fee estimate is stale — re-confirm to refresh the numbers.");
        previewQ.refetch();
      } else if (msg === "E_ETH_FEE_MARKET_INSANE") {
        setError("The RPC returned an unreasonable gas price. Try again or switch networks.");
      } else if (msg.includes("insufficient funds")) {
        setError("Insufficient ETH to cover both the transfer and gas.");
      } else {
        setError(`Broadcast failed: ${msg}`);
      }
    } finally {
      setSending(false);
    }
  }

  if (stage === "sent") {
    return (
      <Page title="Send ETH">
        <div className="card">
          <h2 className="text-lg font-semibold">Broadcast.</h2>
          <p className="mt-2 text-sm">
            Tx hash: <span className="break-all font-mono">{txHash}</span>
          </p>
          <p className="mt-2 text-xs text-ink-500">
            Confirming on Ethereum — this can take a few minutes.
          </p>
          {txHash && (
            <a
              href={ethTxExplorerUrl(ethNetwork, txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-pearl-700 underline dark:text-pearl-300"
            >
              View on Etherscan →
            </a>
          )}
          <button onClick={() => navigate("/dashboard")} className="btn-primary mt-4 w-full">
            Back to dashboard
          </button>
        </div>
      </Page>
    );
  }

  if (stage === "preview") {
    const v = validated;
    const q = previewQ.data;
    const covered = q?.covered ?? false;
    return (
      <Page title="Send ETH">
        <div className="card">
          <h2 className="text-lg font-semibold">Confirm</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-500">To</dt>
              <dd className="break-all font-mono">{v?.dest}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Amount</dt>
              <dd>{v ? formatWei(v.wei) : "—"} ETH</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Gas tier</dt>
              <dd>{tier} ({GAS_BY_TIER[tier]} priority)</dd>
            </div>
            {q && (
              <>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Worst-case gas</dt>
                  <dd>{formatWei(q.worstCaseWei)} ETH</dd>
                </div>
                <div className="flex justify-between border-t border-ink-200 pt-2 dark:border-ink-700">
                  <dt className="font-medium">Total (max)</dt>
                  <dd className="font-medium">{formatWei(q.required)} ETH</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Your ETH</dt>
                  <dd>{formatWei(q.ethBal)} ETH</dd>
                </div>
              </>
            )}
          </dl>

          {previewQ.isLoading && (
            <p className="mt-3 text-xs text-ink-500">Estimating gas…</p>
          )}
          {previewQ.isError && (
            <p className="mt-3 text-sm text-red-600">
              Couldn't estimate gas: {(previewQ.error as Error).message}
            </p>
          )}
          {q && !covered && (
            <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-900/20 dark:text-red-200">
              Insufficient ETH — amount + gas exceeds your balance. Reduce
              the amount or top up first.
            </div>
          )}

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button onClick={() => setStage("compose")} className="btn-secondary" disabled={sending}>
              Back
            </button>
            <button
              disabled={!q || !covered || sending}
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
    <Page title="Send ETH">
      <div className="card flex flex-col gap-3">
        <p className="text-xs text-ink-500">
          Send native ETH from your wallet's Ethereum address. Useful for
          funding gas before a WPRL transfer or moving ETH out.
        </p>
        <label className="block">
          <span className="label">Destination address</span>
          <input
            className="input mono"
            placeholder="0x..."
            value={destination}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">Amount (ETH)</span>
          <input
            className="input mono"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <fieldset>
          <legend className="label">Gas tier</legend>
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
                <div className="text-xs text-ink-500">{GAS_BY_TIER[t]}</div>
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
