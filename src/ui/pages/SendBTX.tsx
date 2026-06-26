import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/Page";
import { cryptoWorker } from "../../crypto/worker-client";
import { fetchBtxBalance } from "../../services/btx-indexer";
import { prepareBtxSpend, broadcastBtxTx, assertValidBtxRecipient, type BtxSpendPlan } from "../../services/btx-send";
import { isValidBtxAddress } from "../../chains/btx/address";
import { btxTxExplorerUrl, BTX_SEND_ENABLED } from "../../chains/btx/network";
import { formatGrains, parsePRL } from "../../lib/format";

type Stage = "form" | "preview" | "sending" | "done";

export default function SendBTX() {
  const navigate = useNavigate();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [plan, setPlan] = useState<BtxSpendPlan | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addrQ = useQuery({
    queryKey: ["btxAddress"],
    queryFn: () => cryptoWorker.call<"deriveBtx", { btx: string }>("deriveBtx", {}),
    staleTime: Infinity,
  });
  const from = addrQ.data?.btx;
  const balQ = useQuery({
    queryKey: ["btxBalance", from],
    queryFn: () => fetchBtxBalance(from!),
    enabled: !!from,
  });

  const toValid = isValidBtxAddress(to.trim());
  let amountSat: bigint | null = null;
  try {
    amountSat = amount.trim() ? parsePRL(amount.trim()) : null;
  } catch {
    amountSat = null;
  }
  const hasBalance = !!balQ.data && !!amountSat && amountSat <= balQ.data.confirmedSat;
  const canPreview = !!from && toValid && !!amountSat && amountSat > 0n && hasBalance;

  async function onPreview() {
    setError(null);
    try {
      assertValidBtxRecipient(to.trim());
      const p = await prepareBtxSpend(from!, to.trim(), amountSat!);
      setPlan(p);
      setStage("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not build transaction");
    }
  }

  async function onSend() {
    if (!plan) return;
    setStage("sending");
    setError(null);
    try {
      const signed = await cryptoWorker.call<"signBtxTx", { txid: string; hex: string }>("signBtxTx", {
        ins: plan.ins,
        outs: plan.outs,
      });
      const id = await broadcastBtxTx(signed.hex);
      setTxid(id);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "broadcast failed");
      setStage("preview");
    }
  }

  if (!BTX_SEND_ENABLED) {
    return (
      <Page>
        <div className="card">
          <h1 className="text-lg font-semibold">Send BTX</h1>
          <p className="mt-3 text-sm text-ink-500">
            BTX send is in final fund-safety validation (verifying the post-quantum signature
            path against on-chain data). It will be enabled shortly. Receiving works now.
          </p>
          <Link to="/dashboard" className="btn-primary mt-4 block w-full text-center">Back</Link>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <div className="card">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Send BTX</h1>
          <Link to="/dashboard" className="text-xs text-pearl-700 hover:underline">Cancel</Link>
        </div>
        <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">Beta · post-quantum · pre-production network</div>

        {stage === "form" && (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs text-ink-500">Recipient (btx1z…)</span>
              <input className="input mt-1 w-full font-mono text-sm" value={to} onChange={(e) => setTo(e.target.value)} placeholder="btx1z…" />
              {to.trim() && !toValid && <span className="text-xs text-red-600">Not a valid BTX address.</span>}
            </label>
            <label className="block">
              <span className="text-xs text-ink-500">Amount (BTX)</span>
              <input className="input mt-1 w-full" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0" />
              <span className="text-xs text-ink-500">
                Balance: {balQ.data ? `${formatGrains(balQ.data.confirmedSat)} BTX` : "…"}
              </span>
            </label>
            {error && <div className="text-xs text-red-600">{error}</div>}
            <button className="btn-primary w-full" disabled={!canPreview} onClick={onPreview}>Preview</button>
          </div>
        )}

        {stage === "preview" && plan && (
          <div className="mt-4 space-y-2 text-sm">
            <Row label="To" value={to} mono />
            <Row label="Amount" value={`${formatGrains(amountSat!)} BTX`} />
            <Row label="Network fee" value={`${formatGrains(plan.feeSat)} BTX`} />
            <Row label="Inputs" value={String(plan.ins.length)} />
            {plan.changeSat > 0n && <Row label="Change" value={`${formatGrains(plan.changeSat)} BTX`} />}
            {error && <div className="text-xs text-red-600">{error}</div>}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button className="btn-secondary" onClick={() => setStage("form")}>Back</button>
              <button className="btn-primary" onClick={onSend}>Sign &amp; Send</button>
            </div>
          </div>
        )}

        {stage === "sending" && <div className="mt-4 text-sm text-ink-500">Signing (post-quantum) &amp; broadcasting…</div>}

        {stage === "done" && txid && (
          <div className="mt-4 space-y-2 text-sm">
            <div className="text-green-700 dark:text-green-400">Broadcast ✓</div>
            <Row label="txid" value={txid} mono />
            <a className="text-xs text-pearl-700 hover:underline" href={btxTxExplorerUrl("mainnet", txid)} target="_blank" rel="noreferrer">View in explorer</a>
            <button className="btn-primary mt-2 w-full" onClick={() => navigate("/dashboard")}>Done</button>
          </div>
        )}
      </div>
    </Page>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-ink-500">{label}</span>
      <span className={`text-right ${mono ? "break-all font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}
