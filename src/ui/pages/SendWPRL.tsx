import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { resolveEthDestination } from "../../services/ens";
import { formatWei, formatWprl, parseWPRL } from "../../lib/format";
import {
  estimateWprlGas,
  evaluateGasCoverage,
  sendWprl,
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

export default function SendWPRL() {
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
  const [resolvedEns, setResolvedEns] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sending, setSending] = useState(false);

  // Pre-flight quote: estimate gas + suggested fee market + current ETH
  // balance. Gates the "Send" button so a user without enough native ETH
  // to pay gas never even sees an enabled broadcast button — far better
  // UX than letting them sign a tx that the mempool will reject.
  // The query is keyed on the validated send so it refetches when amount
  // or destination change, and only enables on the preview stage so the
  // compose step doesn't blast the RPC on every keystroke.
  const previewQ = useQuery({
    queryKey: [
      "wprl-preview",
      ethAddr,
      ethNetwork,
      tier,
      validated?.dest,
      validated?.wei.toString(),
    ],
    enabled: stage === "preview" && !!validated && !!ethAddr,
    queryFn: async () => {
      const [gas, fees, ethBal] = await Promise.all([
        estimateWprlGas(ethNetwork, ethAddr!, validated!.dest, validated!.wei),
        suggestGas(ethNetwork, tier),
        fetchEthBalanceWei(ethAddr!, ethNetwork),
      ]);
      const coverage = evaluateGasCoverage(ethBal, gas, fees.maxFeePerGas);
      // Stamp so broadcast can refuse a stale preview.
      return { gas, fees, ethBal, coverage, composedAt: Date.now() };
    },
  });

  function checkAmount(): { ok: true; wei: bigint } | { ok: false; reason: string } {
    let wei: bigint;
    try {
      wei = parseWPRL(amount);
    } catch {
      return { ok: false, reason: "Enter a valid WPRL amount." };
    }
    if (wei <= 0n) {
      return { ok: false, reason: "Amount must be greater than 0." };
    }
    return { ok: true, wei };
  }

  // Resolve destination (0x address with EIP-55 checksum, OR ENS name on
  // mainnet) then validate amount. Resolved 0x address always shown in the
  // preview for confirmation.
  async function reviewSend(): Promise<void> {
    setError(null);
    setResolvedEns(null);
    const amt = checkAmount();
    if (!amt.ok) {
      setError(amt.reason);
      return;
    }
    setResolving(true);
    let res;
    try {
      res = await resolveEthDestination(destination, ethNetwork);
    } finally {
      setResolving(false);
    }
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setResolvedEns(res.ensName);
    setValidated({ dest: res.address, wei: amt.wei });
    setStage("preview");
  }

  async function broadcast() {
    if (!validated || !ethAddr) return;
    const q = previewQ.data;
    if (!q) return;
    setSending(true);
    setError(null);
    try {
      const { txHash: hash } = await sendWprl({
        network: ethNetwork,
        from: ethAddr,
        to: validated.dest,
        amount: validated.wei,
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
      } else if (msg.includes("E_WPRL_NOT_DEPLOYED")) {
        setError("WPRL isn't deployed on this network yet.");
      } else if (msg.includes("insufficient funds")) {
        setError("Insufficient ETH for gas, or insufficient WPRL for amount.");
      } else {
        setError(`Broadcast failed: ${msg}`);
      }
    } finally {
      setSending(false);
    }
  }

  if (stage === "sent") {
    return (
      <Page title="Send WPRL">
        <div className="card">
          <h2 className="text-lg font-semibold tracking-tight">Transaction broadcast</h2>
          <p className="mt-2 text-sm leading-relaxed break-words">
            Tx hash: <span className="break-all font-mono min-w-0 tabular-nums">{txHash}</span>
          </p>
          <p className="mt-2 text-xs text-text-3 leading-relaxed break-words">
            Confirming on Ethereum — this can take a few minutes.
          </p>
          {txHash && (
            <a
              href={ethTxExplorerUrl(ethNetwork, txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-accent underline underline-offset-4 leading-relaxed"
            >
              View on Etherscan →
            </a>
          )}
          <button onClick={() => navigate("/dashboard")} className="btn-primary mt-4 w-full min-w-11">
            Back to dashboard
          </button>
        </div>
      </Page>
    );
  }

  if (stage === "preview") {
    const v = validated;
    const q = previewQ.data;
    const covered = q?.coverage.covered ?? false;
    return (
      <Page title="Send WPRL">
        <div className="card shadow-slabsm sm:shadow-slab">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Transaction preview</p>
          <h2 className="text-xl font-semibold tracking-tight">Review before you sign</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-2">Check the destination, amount and fees. A transfer cannot be undone.</p>
          <dl className="mt-3 space-y-2 text-sm leading-relaxed divide-y divide-line [&>div]:grid [&>div]:grid-cols-1 [&>div]:gap-2 [&>div]:py-3 sm:[&>div]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-[.12em] [&_dd]:min-w-0 [&_dd]:break-all [&_dd]:font-mono [&_dd]:tabular-nums [&_dd]:text-left sm:[&_dd]:text-right">
            <div className="flex justify-between">
              <dt className="text-text-3">To</dt>
              <dd className="break-all text-right">
                {resolvedEns && (
                  <div className="font-medium text-accent">{resolvedEns}</div>
                )}
                <div className="font-mono text-xs break-all min-w-0 tabular-nums leading-relaxed">{v?.dest}</div>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">Amount</dt>
              <dd>{v ? formatWprl(v.wei) : "—"} WPRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">Gas tier</dt>
              <dd>{tier} ({GAS_BY_TIER[tier]} priority)</dd>
            </div>
            {q && (
              <>
                <div className="flex justify-between">
                  <dt className="text-text-3">Worst-case gas</dt>
                  <dd>{formatWei(q.coverage.worstCaseWei)} ETH</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-3">Your ETH</dt>
                  <dd>{formatWei(q.coverage.ethBalanceWei)} ETH</dd>
                </div>
              </>
            )}
          </dl>

          {previewQ.isLoading && (
            <p className="mt-3 text-xs text-text-3 leading-relaxed break-words">Estimating gas…</p>
          )}
          {previewQ.isError && (
            <p className="mt-3 text-sm text-danger leading-relaxed break-words">
              Couldn't estimate gas: {(previewQ.error as Error).message}
            </p>
          )}
          {q && !covered && (
            <div className="mt-3 rounded-pb border border-danger-line bg-danger-bg p-3 text-xs text-danger leading-relaxed">
              You don't have enough ETH to cover gas. Fund this address with
              a small amount of ETH before sending WPRL — even the smallest
              ERC-20 transfer needs native gas.
            </div>
          )}

          {error && <p className="mt-2 text-sm text-danger leading-relaxed break-words">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button onClick={() => setStage("compose")} className="btn-secondary min-w-11" disabled={sending}>
              Back
            </button>
            <button
              disabled={!q || !covered || sending}
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
    <Page title="Send WPRL">
      <div className="card flex flex-col gap-5 shadow-slabsm sm:shadow-slab">
        <label className="block">
          <span className="label">Destination address or ENS name</span>
          <input
            className="input mono break-all min-w-0 tabular-nums"
            placeholder="0x… or name.eth"
            value={destination}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">Amount (WPRL)</span>
          <input
            className="input mono break-all min-w-0 tabular-nums"
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
                <div className="text-xs text-text-3 leading-relaxed">{GAS_BY_TIER[t]}</div>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="text-sm text-danger leading-relaxed break-words">{error}</p>}
        <button
          onClick={() => void reviewSend()}
          disabled={resolving}
          className="btn-primary disabled:opacity-50 min-w-11"
        >
          {resolving ? "Resolving ENS…" : "Review"}
        </button>
      </div>
    </Page>
  );
}
