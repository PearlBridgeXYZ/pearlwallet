import { useMemo, useState, type ClipboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../state/wallet-store";
import { cryptoWorker } from "../../crypto/worker-client";
import { passwordAcceptable, passwordStrength } from "../../lib/validate";
import { applyMnemonicPaste, parseMnemonicPaste } from "../../lib/mnemonic-paste";

export default function OnboardingRestore() {
  const navigate = useNavigate();
  const restore = useWallet((s) => s.restoreWallet);

  const [length, setLength] = useState<12 | 24>(12);
  const [words, setWords] = useState<string[]>(() => Array(12).fill(""));
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // If an encrypted keystore already lives in IndexedDB, the store throws
  // E_WALLET_EXISTS. The only way to reach Settings → Danger Zone is to be
  // unlocked, which a "I forgot my password" user by definition cannot do
  // — so we surface an explicit overwrite confirm right here. The seed
  // phrase the user is typing IS the recovery for the wallet they're
  // restoring; the wallet that gets erased is whichever was in this
  // browser before. (v0.1.10 — bug reported on first deploy.)
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const pwStrength = useMemo(() => passwordStrength(password), [password]);

  function setLen(n: 12 | 24) {
    setLength(n);
    setWords((prev) => {
      const next = Array(n).fill("") as string[];
      for (let i = 0; i < Math.min(prev.length, n); i++) next[i] = prev[i] ?? "";
      return next;
    });
  }

  function setWord(i: number, v: string) {
    setWords((prev) => {
      const next = prev.slice();
      next[i] = v.trim().toLowerCase();
      return next;
    });
  }

  function onPasteAt(i: number, e: ClipboardEvent<HTMLInputElement>) {
    const raw = e.clipboardData.getData("text");
    const parsed = parseMnemonicPaste(raw);
    if (parsed.length <= 1) return;
    e.preventDefault();
    const result = applyMnemonicPaste(parsed, words, length, i);
    if (result.bulkApplied && result.length !== length) setLength(result.length);
    setWords(result.words);
  }

  async function submit(allowOverwrite = false) {
    setError(null);
    const mnemonic = words.join(" ").trim();
    const v = await cryptoWorker.call<"validateMnemonic", { valid: boolean }>(
      "validateMnemonic",
      { mnemonic },
    );
    if (!v.valid) {
      setError("That doesn't look like a valid BIP-39 phrase. Check the words.");
      return;
    }
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
    try {
      await restore(mnemonic, password, allowOverwrite ? { allowOverwrite: true } : undefined);
      setOverwriteOpen(false);
      navigate("/dashboard");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "E_WALLET_EXISTS") {
        setOverwriteOpen(true);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-2xl font-semibold">Restore your wallet.</h1>
      <p className="mt-2 text-sm text-ink-500">
        Enter your 12- or 24-word recovery phrase. Words are masked by default.
      </p>

      <div className="mt-4 flex items-center gap-3 text-sm">
        <span>Phrase length:</span>
        <label className="flex items-center gap-1">
          <input type="radio" checked={length === 12} onChange={() => setLen(12)} />
          12 words
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={length === 24} onChange={() => setLen(24)} />
          24 words
        </label>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {words.map((w, i) => (
          <label key={i} className="block">
            <span className="label">#{i + 1}</span>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={w}
              onChange={(e) => setWord(i, e.target.value)}
              onPaste={(e) => onPasteAt(i, e)}
            />
          </label>
        ))}
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <label className="block">
          <span className="label">Set an unlock password</span>
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

      <button
        type="button"
        onClick={() => submit(false)}
        disabled={busy}
        className="btn-primary mt-6 w-full"
      >
        {busy ? "Restoring..." : "Restore wallet"}
      </button>

      {overwriteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="card max-w-md">
            <h2 className="text-lg font-semibold">Replace the wallet on this device?</h2>
            <p className="mt-2 text-sm text-ink-500">
              A different wallet is already stored in this browser. Restoring
              will overwrite it. Anything currently on this device will be
              unreachable unless you also have its recovery phrase saved
              elsewhere.
            </p>
            <p className="mt-2 text-sm text-ink-500">
              If you don't know what the existing wallet is, cancel and check
              with whoever uses this browser first.
            </p>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => setOverwriteOpen(false)}
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
  );
}
