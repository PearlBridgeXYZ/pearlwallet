import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { validPearl } from "../../lib/validate";
import { formatGrains, parsePRL } from "../../lib/format";
import { computeTipGrains, tipAddressFor } from "../../chains/pearl/tip";

type FeeTier = "low" | "normal" | "high";

const FEE_BY_TIER: Record<FeeTier, bigint> = {
  low: 1000n,      // 0.00001 PRL placeholder
  normal: 5000n,   // 0.00005 PRL
  high: 20000n,    // 0.0002 PRL
};

export default function SendPRL() {
  const navigate = useNavigate();
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const mockMode = useUI((s) => s.mockMode);
  const tipEnabledGlobal = useUI((s) => s.tipEnabled);

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [tier, setTier] = useState<FeeTier>("normal");
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState<"compose" | "preview" | "sent">("compose");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Per-transaction override: starts at the global preference so the
  // user can turn this off for a single send without changing settings.
  const [tipThisTx, setTipThisTx] = useState(tipEnabledGlobal);

  function validate(): { dest: string; grains: bigint } | null {
    if (!validPearl(destination, pearlNetwork)) {
      setError("That doesn't look like a valid Pearl address.");
      return null;
    }
    let grains: bigint;
    try {
      grains = parsePRL(amount);
    } catch {
      setError("Enter a valid PRL amount.");
      return null;
    }
    if (grains <= 0n) {
      setError("Amount must be greater than 0.");
      return null;
    }
    setError(null);
    return { dest: destination.trim(), grains };
  }

  async function broadcast() {
    if (!mockMode) {
      setError("Live Pearl RPC not wired yet (gated on Q3/Q4 in docs/11).");
      return;
    }
    if (password.length < 1) {
      setError("Enter your password to authorize the send.");
      return;
    }
    // Mock: pretend we built + signed + broadcast. Use a real CSPRNG
    // so the placeholder hash doesn't look like attacker-predictable noise.
    await new Promise((r) => setTimeout(r, 800));
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const fakeHash = "mock_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    setTxHash(fakeHash);
    setStage("sent");
  }

  if (stage === "sent") {
    return (
      <Page title="Send PRL">
        <div className="card">
          <h2 className="text-lg font-semibold">Broadcast.</h2>
          <p className="mt-2 text-sm text-ink-500">
            Tx hash: <span className="break-all font-mono">{txHash}</span>
          </p>
          <p className="mt-2 text-xs text-ink-500">
            Confirming on chain — this can take a few minutes.
          </p>
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
    const v = validate();
    const feeFor = FEE_BY_TIER[tier];
    const tipGrains = v && tipThisTx ? computeTipGrains(v.grains) : 0n;
    const totalGrains = v ? v.grains + feeFor + tipGrains : 0n;
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
            <div className="flex justify-between">
              <dt className="text-ink-500">Fee ({tier})</dt>
              <dd>{formatGrains(feeFor)} PRL</dd>
            </div>
            {tipThisTx && (
              <div className="flex justify-between">
                <dt className="text-ink-500">
                  Tip to PearlBridge (10 bps, min 1 PRL)
                </dt>
                <dd>{formatGrains(tipGrains)} PRL</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-ink-200 pt-2 dark:border-ink-700">
              <dt className="font-medium">Total</dt>
              <dd className="font-medium">{formatGrains(totalGrains)} PRL</dd>
            </div>
          </dl>

          <label className="mt-4 flex items-start gap-2 rounded-xl border border-ink-200 p-3 text-sm dark:border-ink-700">
            <input
              type="checkbox"
              checked={tipThisTx}
              onChange={(e) => setTipThisTx(e.target.checked)}
              className="mt-1"
            />
            <span>
              Tip the PearlBridge dev team{" "}
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

          <label className="mt-4 block">
            <span className="label">Password (re-confirm)</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button onClick={() => setStage("compose")} className="btn-secondary">
              Back
            </button>
            <button onClick={broadcast} className="btn-primary flex-1">
              Send
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
                <div className="text-xs text-ink-500">{formatGrains(FEE_BY_TIER[t])} PRL</div>
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          onClick={() => {
            if (validate()) setStage("preview");
          }}
          className="btn-primary"
        >
          Review
        </button>
      </div>
    </Page>
  );
}
