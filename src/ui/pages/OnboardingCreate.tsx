import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet, E_WALLET_EXISTS_ELSEWHERE, subscribeStoredWalletChange, WalletExistsError } from "../../state/wallet-store";
import type { KeystoreBlobJSON } from "../../storage/db";
import { cryptoWorker } from "../../crypto/worker-client";
import { passwordAcceptable, passwordStrength } from "../../lib/validate";
import TopBar from "../components/TopBar";

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
  // See OnboardingRestore for the rationale — a user creating a fresh wallet
  // may also hit E_WALLET_EXISTS, and the only Settings → Danger Zone path
  // out requires being unlocked. (v0.1.10.)
  // The stored wallet the dialog was opened over (from E_WALLET_EXISTS):
  // the overwrite replaces only that exact record (else E_WALLET_CHANGED),
  // and the dialog closes if this tab sees the stored wallet change.
  const [overwriteOver, setOverwriteOver] = useState<KeystoreBlobJSON | null>(null);
  const overwriteOpen = overwriteOver !== null;
  const submittingOverwrite = useRef(false);
  useEffect(() => {
    if (!overwriteOver) return;
    return subscribeStoredWalletChange(() => {
      if (submittingOverwrite.current) return; // our own replace finishing
      setOverwriteOver(null);
      setError("The wallet stored in this browser changed in another tab, so the replace was cancelled and nothing was replaced. Submit again to review the wallet stored now.");
    });
  }, [overwriteOver]);

  // Generate mnemonic on mount (and on strength change).
  // Timer ref lives outside the async IIFE so the useEffect cleanup can
  // actually clear it. Previously the inner `return () => clearTimeout(t)`
  // was the IIFE's return value, NOT useEffect's — so toggling between
  // 12-word / 24-word during the 5s wait stacked timers (each one would
  // still fire and flip canContinue to true even after unmount). Flagged
  // in v0.1.7 audit (opus1 M-5).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const out = await cryptoWorker.call<"generateMnemonic", { mnemonic: string }>(
          "generateMnemonic",
          { strength },
        );
        if (!cancelled) {
          setMnemonic(out.mnemonic);
          setCanContinue(false);
          timer = setTimeout(() => setCanContinue(true), 5000);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
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

  async function submit(allowOverwrite = false) {
    const pw = passwordAcceptable(password);
    if (!pw.ok) {
      setError(pw.reason);
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
    submittingOverwrite.current = allowOverwrite;
    setError(null);
    try {
      // We already have a mnemonic from step 1 — use restoreWallet path to preserve it.
      // createWallet would generate a fresh one; restoreWallet accepts the user-displayed
      // mnemonic so the words shown in step 1 are the words backing the keystore.
      const out = await useWallet
        .getState()
        .restoreWallet(mnemonic, password, allowOverwrite && overwriteOver ? { allowOverwrite: true, observedBlob: overwriteOver } : undefined);
      setAddresses(out.addresses);
      setOverwriteOver(null);
      setStep("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === E_WALLET_EXISTS_ELSEWHERE) {
        // Another tab stored a wallet while this one was saving: nothing
        // was saved here and the other wallet is untouched.
        setOverwriteOver(null);
        setError("A wallet was just created in another tab, so nothing was saved here. Reload this page to use that wallet.");
      } else if (msg === "E_WALLET_CHANGED") {
        // Overwrite confirmed, but another tab stored, replaced or removed
        // a wallet while this one was saving: nothing was saved here.
        setOverwriteOver(null);
        setError("The wallet stored in this browser changed in another tab while this one was saving, so nothing was saved and nothing was replaced. Reload this page and check the stored wallet before replacing it.");
      } else if (e instanceof WalletExistsError) {
        setOverwriteOver(e.observedBlob);
      } else {
        setError(msg);
      }
    } finally {
      submittingOverwrite.current = false;
      setBusy(false);
    }
  }

  if (step === "generate") {
    return (
      <>
      <TopBar />
      <div className="shell-width my-8 max-w-lg sm:my-12">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Create wallet · 1 / 3</p>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-.6px] sm:text-[34px]">Back up your recovery phrase.</h1>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Write these words down on paper and store them somewhere safe.
          Anyone with these words controls your wallet.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-line py-2 text-sm">
          <span>Phrase length:</span>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              checked={strength === 128}
              onChange={() => setStrength(128)}
            />
            12 words
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              checked={strength === 256}
              onChange={() => setStrength(256)}
            />
            24 words
          </label>
        </div>

        <div className="card mt-6 shadow-slabsm sm:shadow-slab">
          <ol className="grid grid-cols-2 gap-x-4 gap-y-3 font-mono text-sm sm:grid-cols-3">
            {words.map((w, i) => (
              <li key={i} className="flex min-w-0 items-baseline gap-2 border-b border-line pb-2">
                <span className="w-6 text-right text-xs text-text-3">{i + 1}.</span>
                <span>{w}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="mt-3 text-xs text-text-3">
          Keep a paper backup somewhere private. Avoid screenshots and clipboard copies.
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
      </>
    );
  }

  if (step === "verify") {
    return (
      <>
      <TopBar />
      <div className="shell-width my-8 max-w-lg sm:my-12">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Create wallet · 2 / 3</p>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-.6px] sm:text-[34px]">Confirm your phrase.</h1>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Use your paper backup to enter words 3, 7 and 11. This checks that you saved your phrase correctly.
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
          <p className="mt-3 text-sm text-danger">Words don't match. Check what you wrote down.</p>
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
      </>
    );
  }

  if (step === "password") {
    return (
      <>
      <TopBar />
      <div className="shell-width my-8 max-w-lg sm:my-12">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Create wallet · 3 / 3</p>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-.6px] sm:text-[34px]">Set an unlock password.</h1>
        <p className="mt-3 text-sm leading-7 text-text-2">
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
            <span className="mt-1 block text-xs text-text-3">
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
          <label className="mt-2 flex min-h-11 items-start gap-3 border-t border-line pt-4 text-sm leading-6">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-1"
            />
            <span>I understand that only my recovery phrase can restore my wallet. If I lose it, my funds are gone. The PearlBridge team cannot recover them.</span>
          </label>
        </div>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <div className="mt-6 flex gap-3">
          <button type="button" onClick={() => setStep("verify")} className="btn-secondary">
            Back
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit(false)}
            className="btn-primary flex-1"
          >
            {busy ? "Creating..." : "Create wallet"}
          </button>
        </div>

        {overwriteOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 px-4 py-6">
            <div className="card max-w-md">
              <h2 className="text-lg font-semibold">Replace the wallet on this device?</h2>
              <p className="mt-3 text-sm leading-7 text-text-2">
                A wallet is already stored in this browser. Creating a new one
                will overwrite it. Anything currently on this device will be
                unreachable unless you have its recovery phrase saved elsewhere.
              </p>
              <p className="mt-3 text-sm leading-7 text-text-2">
                If you're not sure, cancel and unlock the existing wallet first.
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  onClick={() => setOverwriteOver(null)}
                  disabled={busy}
                  className="btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => submit(true)}
                  disabled={busy}
                  className="btn-primary flex-1"
                >
                  {busy ? "Replacing..." : "Replace existing wallet"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      </>
    );
  }

  // done
  return (
    <>
    <TopBar />
    <div className="shell-width my-8 max-w-lg sm:my-12">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Ready to receive</p>
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-.6px] sm:text-[34px]">Wallet created.</h1>
      <div className="card mt-6 space-y-3 text-sm">
        <div>
          <div className="text-xs text-text-3">Your Pearl address</div>
          <div className="break-all font-mono">{addresses?.pearl}</div>
        </div>
        <div>
          <div className="text-xs text-text-3">Your Ethereum address (for WPRL)</div>
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
    </>
  );
}
