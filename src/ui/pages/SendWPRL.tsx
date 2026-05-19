import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { validEth } from "../../lib/validate";
import { formatWei, parseWPRL } from "../../lib/format";

type GasTier = "low" | "normal" | "high";

const GAS_BY_TIER: Record<GasTier, string> = {
  low: "1 gwei",
  normal: "2 gwei",
  high: "3 gwei",
};

export default function SendWPRL() {
  const navigate = useNavigate();

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [tier, setTier] = useState<GasTier>("normal");
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState<"compose" | "preview" | "sent">("compose");
  const [error, setError] = useState<string | null>(null);
  const [txHash] = useState<string | null>(null);

  function validate(): { dest: string; wei: bigint } | null {
    if (!validEth(destination)) {
      setError("That doesn't look like a valid Ethereum address.");
      return null;
    }
    let wei: bigint;
    try {
      wei = parseWPRL(amount);
    } catch {
      setError("Enter a valid WPRL amount.");
      return null;
    }
    if (wei <= 0n) {
      setError("Amount must be greater than 0.");
      return null;
    }
    setError(null);
    return { dest: destination.trim(), wei };
  }

  async function broadcast() {
    setError(
      "Live WPRL send from this wallet UI is not yet enabled. Use your existing Ethereum wallet to transfer WPRL.",
    );
  }

  if (stage === "sent") {
    return (
      <Page title="Send WPRL">
        <div className="card">
          <h2 className="text-lg font-semibold">Broadcast.</h2>
          <p className="mt-2 text-sm">
            Tx hash: <span className="break-all font-mono">{txHash}</span>
          </p>
          <button onClick={() => navigate("/dashboard")} className="btn-primary mt-4 w-full">
            Back to dashboard
          </button>
        </div>
      </Page>
    );
  }

  if (stage === "preview") {
    const v = validate();
    return (
      <Page title="Send WPRL">
        <div className="card">
          <h2 className="text-lg font-semibold">Confirm</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-500">To</dt>
              <dd className="break-all font-mono">{v?.dest}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Amount</dt>
              <dd>{v ? formatWei(v.wei) : "—"} WPRL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Gas tier</dt>
              <dd>{tier} ({GAS_BY_TIER[tier]} priority)</dd>
            </div>
          </dl>
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
            <button onClick={() => setStage("compose")} className="btn-secondary">Back</button>
            <button onClick={broadcast} className="btn-primary flex-1">Send</button>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Send WPRL">
      <div className="card flex flex-col gap-3">
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
          <span className="label">Amount (WPRL)</span>
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
            {(["low", "normal", "high"] as GasTier[]).map((t) => (
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
