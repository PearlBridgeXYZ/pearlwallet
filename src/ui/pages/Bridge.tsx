import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { formatGrains, formatWei, parsePRL, parseWPRL, shortAddr } from "../../lib/format";
import { readBridgeFees, type BridgeFees } from "../../services/bridge";
import { MINT_FEE_BPS_DEFAULT, BURN_FEE_BPS_DEFAULT } from "../../chains/ethereum/network";

type Direction = "prl-to-wprl" | "wprl-to-prl";
type Step = "compose" | "preview" | "status";

export default function Bridge() {
  const navigate = useNavigate();
  const addresses = useWallet((s) => s.addresses);
  const mockMode = useUI((s) => s.mockMode);

  const [direction, setDirection] = useState<Direction>("prl-to-wprl");
  const [amount, setAmount] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<Step>("compose");
  const [error, setError] = useState<string | null>(null);
  const [statusStep, setStatusStep] = useState<0 | 1 | 2 | 3>(0);
  const [fees, setFees] = useState<BridgeFees>({
    mintFeeBps: MINT_FEE_BPS_DEFAULT,
    burnFeeBps: BURN_FEE_BPS_DEFAULT,
    source: "fallback",
  });

  // Read live fees from the BridgeController on mount. Falls back to defaults.
  useEffect(() => {
    let cancelled = false;
    if (mockMode) return;
    readBridgeFees("mainnet")
      .then((f) => { if (!cancelled) setFees(f); })
      .catch(() => { /* fee defaults already set */ });
    return () => { cancelled = true; };
  }, [mockMode]);

  const isPrlSide = direction === "prl-to-wprl";
  const symbol = isPrlSide ? "PRL" : "WPRL";
  const recvSymbol = isPrlSide ? "WPRL" : "PRL";

  const activeFeeBps = isPrlSide ? fees.mintFeeBps : fees.burnFeeBps;

  const preview = useMemo(() => {
    try {
      if (!amount.trim()) return null;
      const native = isPrlSide ? parsePRL(amount) : parseWPRL(amount);
      const feeBps = BigInt(activeFeeBps);
      const fee = (native * feeBps) / 10000n;
      const recv = native - fee;
      return { native, fee, recv };
    } catch {
      return null;
    }
  }, [amount, isPrlSide, activeFeeBps]);

  async function bridge() {
    if (!mockMode) {
      setError("Live bridge integration gated on docs/11 Q6 (relayer API) and Q4 (contract addresses).");
      return;
    }
    if (!password) {
      setError("Enter your password to authorize.");
      return;
    }
    setStep("status");
    // Mock the 3-step progression.
    setStatusStep(1);
    await new Promise((r) => setTimeout(r, 1500));
    setStatusStep(2);
    await new Promise((r) => setTimeout(r, 1500));
    setStatusStep(3);
  }

  if (step === "status") {
    const steps = isPrlSide
      ? ["Pearl deposit", "Relayer signature", "Eth mint"]
      : ["Eth burn", "Relayer signature", "Pearl release"];
    return (
      <Page title="Bridge in progress">
        <div className="card">
          <ol className="space-y-3 text-sm">
            {steps.map((label, i) => {
              const done = statusStep > i;
              const active = statusStep === i;
              return (
                <li key={label} className="flex items-center gap-3">
                  <span
                    className={
                      done
                        ? "h-6 w-6 rounded-full bg-emerald-600 text-center text-white"
                        : active
                          ? "h-6 w-6 animate-pulse rounded-full bg-pearl-600 text-center text-white"
                          : "h-6 w-6 rounded-full border border-ink-300 text-center dark:border-ink-700"
                    }
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className={done ? "text-ink-500 line-through" : ""}>{label}</span>
                </li>
              );
            })}
          </ol>
          <p className="mt-4 text-xs text-ink-500">
            Bridge actions can't be cancelled once broadcast.
          </p>
          {statusStep === 3 && (
            <button onClick={() => navigate("/dashboard")} className="btn-primary mt-4 w-full">
              Done
            </button>
          )}
        </div>
      </Page>
    );
  }

  if (step === "preview" && preview) {
    return (
      <Page title="Confirm bridge">
        <div className="card">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-500">You send</dt>
              <dd>{isPrlSide ? formatGrains(preview.native) : formatWei(preview.native)} {symbol}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">
                Bridge fee ({activeFeeBps / 100}%)
                {fees.source === "fallback" && (
                  <span className="ml-1 text-xs text-amber-600">· est.</span>
                )}
              </dt>
              <dd>{isPrlSide ? formatGrains(preview.fee) : formatWei(preview.fee)} {symbol}</dd>
            </div>
            <div className="flex justify-between border-t border-ink-200 pt-2 dark:border-ink-700">
              <dt className="font-medium">You receive</dt>
              <dd className="font-medium">
                {isPrlSide ? formatGrains(preview.recv) : formatWei(preview.recv)} {recvSymbol}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">Recipient</dt>
              <dd className="break-all font-mono text-xs">
                {isPrlSide
                  ? addresses?.eth && shortAddr(addresses.eth, 8, 6)
                  : addresses?.pearl && shortAddr(addresses.pearl, 12, 8)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-amber-700 dark:text-amber-400">
            This cannot be undone.
          </p>
          <label className="mt-4 block">
            <span className="label">Password</span>
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
            <button onClick={() => setStep("compose")} className="btn-secondary">Back</button>
            <button onClick={bridge} className="btn-primary flex-1">Bridge</button>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Bridge">
      <div className="card flex flex-col gap-3">
        <div className="inline-flex self-start rounded-xl border border-ink-200 p-1 text-sm dark:border-ink-800">
          <button
            type="button"
            onClick={() => setDirection("prl-to-wprl")}
            className={
              direction === "prl-to-wprl"
                ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                : "rounded-lg px-3 py-1 text-ink-500"
            }
          >
            PRL → WPRL
          </button>
          <button
            type="button"
            onClick={() => setDirection("wprl-to-prl")}
            className={
              direction === "wprl-to-prl"
                ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                : "rounded-lg px-3 py-1 text-ink-500"
            }
          >
            WPRL → PRL
          </button>
        </div>

        <label className="block">
          <span className="label">Amount ({symbol})</span>
          <input
            className="input mono"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        {preview && (
          <div className="rounded-xl bg-ink-100 p-3 text-xs dark:bg-ink-800/60">
            You'll receive ≈ {isPrlSide ? formatGrains(preview.recv) : formatWei(preview.recv)} {recvSymbol}
            <br />
            Estimated time: ≈ 8 minutes
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          onClick={() => {
            if (!preview) {
              setError("Enter an amount greater than 0.");
              return;
            }
            setError(null);
            setStep("preview");
          }}
          className="btn-primary"
        >
          Review
        </button>
      </div>
    </Page>
  );
}
