import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { cryptoWorker } from "../../crypto/worker-client";
import { passwordStrength } from "../../lib/validate";

type Step = "generate" | "verify" | "password" | "done";

export default function OnboardingCreate() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("generate");
  const [strength, setStrength] = useState<128 | 256>(128);
  const [mnemonic, setMnemonic] = useState<string>("");
  const [canContinue, setCanContinue] = useState(false);
  const [verifyInputs, setVerifyInputs] = useState<{ w3: string; w7: string; w11: string }>({
    w3: "",
    w7: "",
    w11: "",
  });
  const [verifyAttempts, setVerifyAttempts] = useState(0);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<{ pearl: string; eth: string } | null>(null);

  // Generate mnemonic on mount (and on strength change).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = await cryptoWorker.call<"generateMnemonic", { mnemonic: string }>(
          "generateMnemonic",
          { strength },
        );
        if (!cancelled) {
          setMnemonic(out.mnemonic);
          setCanContinue(false);
          const t = setTimeout(() => setCanContinue(true), 5000);
          return () => clearTimeout(t);
        }
      } catch (e) {
        setError(String(e));
      }
      return undefined;
    })();
    return () => {
      cancelled = true;
    };
  }, [strength]);

  const words = useMemo(() => mnemonic.split(/\s+/).filter(Boolean), [mnemonic]);
  const pwStrength = useMemo(() => passwordStrength(password), [password]);

  function checkVerify(): boolean {
    return (
      verifyInputs.w3.trim().toLowerCase() === words[2] &&
      verifyInputs.w7.trim().toLowerCase() === words[6] &&
      verifyInputs.w11.trim().toLowerCase() === words[10]
    );
  }

  async function submit() {
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("Passwords don't match.");
      return;
    }
    if (!acknowledged) {
      setError("Please confirm you understand there is no recovery.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // We already have a mnemonic from step 1 — use restoreWallet path to preserve it.
      // But useWallet.createWallet generates a fresh one. To use the user-displayed mnemonic,
      // we call restoreWallet (which accepts a mnemonic).
      const out = await useWallet
        .getState()
        .restoreWallet(mnemonic, password);
      setAddresses(out.addresses);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === "generate") {
    return (
      <div className="mx-auto max-w-md px-4 py-8">
        <h1 className="text-2xl font-semibold">Your new wallet is ready.</h1>
        <p className="mt-2 text-sm text-ink-500">
          Write these words down on paper and store them somewhere safe.
          Anyone with these words controls your wallet.
        </p>

        <div className="mt-4 flex items-center gap-3 text-sm">
          <span>Phrase length:</span>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={strength === 128}
              onChange={() => setStrength(128)}
            />
            12 words
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={strength === 256}
              onChange={() => setStrength(256)}
            />
            24 words
          </label>
        </div>

        <div className="card mt-4">
          <ol className="grid grid-cols-3 gap-3 font-mono text-sm">
            {words.map((w, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="w-6 text-right text-xs text-ink-400">{i + 1}.</span>
                <span>{w}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="mt-3 text-xs text-ink-500">
          Writing down is safer. Clipboard can be read by malware.
        </p>

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={!canContinue || words.length === 0}
            onClick={() => setStep("verify")}
            className="btn-primary flex-1"
          >
            {canContinue ? "I've written it down" : "Look carefully..."}
          </button>
        </div>
      </div>
    );
  }

  if (step === "verify") {
    return (
      <div className="mx-auto max-w-md px-4 py-8">
        <h1 className="text-2xl font-semibold">Confirm your phrase.</h1>
        <p className="mt-2 text-sm text-ink-500">
          Type words 3, 7, and 11 below.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          {[
            { key: "w3" as const, n: 3 },
            { key: "w7" as const, n: 7 },
            { key: "w11" as const, n: 11 },
          ].map((row) => (
            <label key={row.key} className="block">
              <span className="label">Word #{row.n}</span>
              <input
                className="input"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={verifyInputs[row.key]}
                onChange={(e) =>
                  setVerifyInputs((p) => ({ ...p, [row.key]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>

        {verifyAttempts > 0 && !checkVerify() && (
          <p className="mt-3 text-sm text-red-600">Words don't match. Check what you wrote down.</p>
        )}

        <div className="mt-6 flex gap-3">
          <button type="button" onClick={() => setStep("generate")} className="btn-secondary">
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              if (checkVerify()) setStep("password");
              else setVerifyAttempts((a) => a + 1);
            }}
            className="btn-primary flex-1"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (step === "password") {
    return (
      <div className="mx-auto max-w-md px-4 py-8">
        <h1 className="text-2xl font-semibold">Set an unlock password.</h1>
        <p className="mt-2 text-sm text-ink-500">
          This password protects your wallet on this device. It's separate from your recovery phrase.
          If you forget the password, restore from the recovery phrase. If you lose both, your funds are gone.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <label className="block">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="mt-1 block text-xs text-ink-500">
              Strength: {pwStrength.label}
            </span>
          </label>
          <label className="block">
            <span className="label">Confirm password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-1"
            />
            <span>I understand there is no recovery. If I lose my recovery phrase, my funds are gone.</span>
          </label>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex gap-3">
          <button type="button" onClick={() => setStep("verify")} className="btn-secondary">
            Back
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="btn-primary flex-1"
          >
            {busy ? "Creating..." : "Create wallet"}
          </button>
        </div>
      </div>
    );
  }

  // done
  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-2xl font-semibold">Wallet created.</h1>
      <div className="card mt-6 space-y-3 text-sm">
        <div>
          <div className="text-xs text-ink-500">Your Pearl address</div>
          <div className="break-all font-mono">{addresses?.pearl}</div>
        </div>
        <div>
          <div className="text-xs text-ink-500">Your Ethereum address (for WPRL)</div>
          <div className="break-all font-mono">{addresses?.eth}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate("/dashboard")}
        className="btn-primary mt-6 w-full"
      >
        Open dashboard
      </button>
    </div>
  );
}
