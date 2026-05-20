import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { pearlParams } from "../../chains/pearl/network";

// Auto-mask exported mnemonic after this many seconds so a phrase left
// onscreen during a coffee break stops being a shoulder-surf target.
// Audit follow-up: "mnemonic export does not clear state on hide" (v0.1.0
// LOW #1). The display is also cleared on unmount so navigating away
// kills the in-DOM copy immediately.
const MNEMONIC_REVEAL_SECONDS = 60;

export default function Settings() {
  const navigate = useNavigate();
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);
  const wipe = useWallet((s) => s.wipe);
  const exportMnemonic = useWallet((s) => s.exportMnemonic);
  const changePassword = useWallet((s) => s.changePassword);
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const pearlRpcOverride = useUI((s) => s.pearlRpcOverride);
  const setPearlRpcOverride = useUI((s) => s.setPearlRpcOverride);
  const tipEnabled = useUI((s) => s.tipEnabled);
  const setTipEnabled = useUI((s) => s.setTipEnabled);

  const defaultRpcUrl = pearlParams().rpcUrl;
  const [rpcDraft, setRpcDraft] = useState(pearlRpcOverride);
  const [rpcStatus, setRpcStatus] = useState<string | null>(null);

  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicValue, setMnemonicValue] = useState<string | null>(null);
  const [mnemonicSecondsLeft, setMnemonicSecondsLeft] = useState(0);
  const mnemonicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pwExport, setPwExport] = useState("");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [wipePhrase, setWipePhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function clearMnemonicTimer() {
    if (mnemonicTimerRef.current) {
      clearInterval(mnemonicTimerRef.current);
      mnemonicTimerRef.current = null;
    }
  }

  function hideMnemonic() {
    clearMnemonicTimer();
    setShowMnemonic(false);
    setMnemonicValue(null);
    setMnemonicSecondsLeft(0);
    setPwExport("");
  }

  async function doExport() {
    setError(null);
    try {
      const mnemonic = await exportMnemonic(pwExport);
      setMnemonicValue(mnemonic);
      setShowMnemonic(true);
      setMnemonicSecondsLeft(MNEMONIC_REVEAL_SECONDS);
      clearMnemonicTimer();
      mnemonicTimerRef.current = setInterval(() => {
        setMnemonicSecondsLeft((s) => {
          if (s <= 1) {
            clearMnemonicTimer();
            setMnemonicValue(null);
            setPwExport("");
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "E_PASSWORD_WRONG"
          ? "Incorrect password."
          : e instanceof Error ? e.message : "Export failed.",
      );
    }
  }

  // Belt-and-braces: nuke any revealed mnemonic when the user navigates
  // away from Settings. Without this, the string would live in the React
  // tree until the next render that knocked it out — long enough for a
  // tab-switch screenshot to capture it.
  useEffect(() => {
    return () => {
      clearMnemonicTimer();
    };
  }, []);

  async function doChangePassword() {
    setError(null);
    setSuccess(null);
    if (newPw !== newPw2) {
      setError("New passwords don't match.");
      return;
    }
    if (newPw.length < 10) {
      setError("New password must be at least 10 characters.");
      return;
    }
    try {
      await changePassword(oldPw, newPw);
      setSuccess("Password changed.");
      setOldPw("");
      setNewPw("");
      setNewPw2("");
    } catch (e) {
      setError(
        e instanceof Error && e.message === "E_PASSWORD_WRONG"
          ? "Incorrect current password."
          : e instanceof Error ? e.message : "Change failed.",
      );
    }
  }

  function saveRpc() {
    setRpcStatus(null);
    const trimmed = rpcDraft.trim();
    if (trimmed === "") {
      setPearlRpcOverride("");
      setRpcStatus(`Using default (${defaultRpcUrl}).`);
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setRpcStatus("That's not a valid URL.");
      return;
    }
    if (parsed.protocol !== "https:") {
      setRpcStatus("RPC URL must use https://.");
      return;
    }
    setPearlRpcOverride(parsed.toString());
    setRpcDraft(parsed.toString());
    setRpcStatus(`Using custom: ${parsed.toString()}`);
  }

  function resetRpc() {
    setRpcDraft("");
    setPearlRpcOverride("");
    setRpcStatus(`Using default (${defaultRpcUrl}).`);
  }

  async function doWipe() {
    if (wipePhrase.trim().toLowerCase() !== "wipe my wallet") {
      setError('Type "wipe my wallet" exactly to confirm.');
      return;
    }
    await wipe();
    navigate("/");
  }

  return (
    <Page title="Settings">
      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Account</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            disabled={status !== "unlocked"}
            onClick={async () => {
              await lock();
              navigate("/unlock");
            }}
            className="btn-secondary"
          >
            Lock now
          </button>
        </div>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Change password</h2>
        <div className="mt-3 flex flex-col gap-2">
          <input
            className="input"
            type="password"
            placeholder="Current password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="New password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="Confirm new password"
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
          />
          <button onClick={doChangePassword} className="btn-primary self-start">
            Change password
          </button>
        </div>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Export recovery phrase</h2>
        <p className="mt-2 text-xs text-ink-500">
          Re-enter your password to view your 12-word phrase. Never share it. Never enter it on any website.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={pwExport}
            onChange={(e) => setPwExport(e.target.value)}
          />
          <button onClick={doExport} className="btn-secondary">Show</button>
        </div>
        {showMnemonic && (
          <div className="card mt-3 bg-amber-50 dark:bg-amber-900/20">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Don't screenshot this. Write it down.
            </p>
            {mnemonicValue ? (
              <>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">
                  {mnemonicValue}
                </pre>
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  Auto-hiding in {mnemonicSecondsLeft}s.
                </p>
              </>
            ) : (
              <p className="mt-2 text-xs text-ink-500">
                Hidden. Re-enter your password above to reveal again.
              </p>
            )}
            <button
              onClick={hideMnemonic}
              className="btn-secondary mt-3"
            >
              Hide
            </button>
          </div>
        )}
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Pearl RPC endpoint</h2>
        <p className="mt-2 text-xs text-ink-500">
          Defaults to the PearlBridgeXYZ team RPC at{" "}
          <span className="font-mono">{defaultRpcUrl}</span>
          {pearlRpcOverride && " (currently overridden — see below)"}. Point at any
          btcd-compatible JSON-RPC endpoint you trust, or leave blank to use the default.
        </p>
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          A malicious RPC can lie about your balance and tx state, and can see your addresses.
          It cannot move funds (your keys never leave this browser), but only point at endpoints you trust.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            className="input mono flex-1"
            placeholder={defaultRpcUrl}
            value={rpcDraft}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setRpcDraft(e.target.value)}
          />
          <button onClick={saveRpc} className="btn-primary">Save</button>
          <button onClick={resetRpc} className="btn-secondary" disabled={!pearlRpcOverride && !rpcDraft}>
            Reset
          </button>
        </div>
        {rpcStatus && <p className="mt-2 text-xs text-ink-500">{rpcStatus}</p>}
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Tip the PearlBridge devs</h2>
        <p className="mt-2 text-xs text-ink-500">
          When you send PRL, the wallet can add a small tip output to the
          PearlBridge developer fees address — <span className="font-medium">10 bps</span>{" "}
          of the send amount, with a <span className="font-medium">1 PRL</span> floor for
          small transactions. The tip helps keep the project running.
        </p>
        <p className="mt-1 text-xs text-ink-500">
          <span className="font-medium">It's fully optional.</span> Uncheck this box, save,
          and the wallet will never add a tip output — using the wallet is free
          beyond on-chain fees.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={tipEnabled}
            onChange={(e) => setTipEnabled(e.target.checked)}
          />
          Enable tip on outgoing PRL transactions (default on)
        </label>
        <p className="mt-2 text-xs text-ink-500">
          Status:{" "}
          {tipEnabled
            ? "tip ON — 10 bps / 1 PRL min will appear in send previews"
            : "tip OFF — no extra output is added to your transactions"}
        </p>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Display</h2>
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span>Theme:</span>
          {(["system", "light", "dark"] as const).map((t) => (
            <label key={t} className="flex items-center gap-1 capitalize">
              <input
                type="radio"
                checked={theme === t}
                onChange={() => setTheme(t)}
              />
              {t}
            </label>
          ))}
        </div>
      </section>

      <section className="card mb-4 border-red-200 dark:border-red-900/40">
        <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">Danger zone</h2>
        <p className="mt-2 text-xs text-ink-500">
          Wiping the wallet from this browser deletes the encrypted keystore here.
          You'll need your recovery phrase to restore.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className="input"
            placeholder='Type "wipe my wallet"'
            value={wipePhrase}
            onChange={(e) => setWipePhrase(e.target.value)}
          />
          <button onClick={doWipe} className="btn-danger">Wipe</button>
        </div>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm text-emerald-700">{success}</p>}
    </Page>
  );
}
