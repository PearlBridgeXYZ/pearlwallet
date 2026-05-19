import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { pearlParams } from "../../chains/pearl/network";

export default function Settings() {
  const navigate = useNavigate();
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);
  const wipe = useWallet((s) => s.wipe);
  const exportMnemonic = useWallet((s) => s.exportMnemonic);
  const changePassword = useWallet((s) => s.changePassword);
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const setPearlNetwork = useWallet((s) => s.setPearlNetwork);
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const mockMode = useUI((s) => s.mockMode);
  const setMockMode = useUI((s) => s.setMockMode);
  const pearlRpcOverride = useUI((s) => s.pearlRpcOverride);
  const setPearlRpcOverride = useUI((s) => s.setPearlRpcOverride);

  const defaultRpcUrl = pearlParams(pearlNetwork).rpcUrl;
  const [rpcDraft, setRpcDraft] = useState(pearlRpcOverride);
  const [rpcStatus, setRpcStatus] = useState<string | null>(null);

  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicValue, setMnemonicValue] = useState<string | null>(null);
  const [pwExport, setPwExport] = useState("");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [wipePhrase, setWipePhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function doExport() {
    setError(null);
    try {
      const mnemonic = await exportMnemonic(pwExport);
      setMnemonicValue(mnemonic);
      setShowMnemonic(true);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "E_PASSWORD_WRONG"
          ? "Incorrect password."
          : e instanceof Error ? e.message : "Export failed.",
      );
    }
  }

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
        {showMnemonic && mnemonicValue && (
          <div className="card mt-3 bg-amber-50 dark:bg-amber-900/20">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Don't screenshot this. Write it down.
            </p>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">
              {mnemonicValue}
            </pre>
            <button
              onClick={() => {
                setShowMnemonic(false);
                setMnemonicValue(null);
                setPwExport("");
              }}
              className="btn-secondary mt-3"
            >
              Hide
            </button>
          </div>
        )}
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Network</h2>
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span>Pearl L1:</span>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={pearlNetwork === "mainnet"}
              onChange={() => setPearlNetwork("mainnet")}
            />
            Mainnet
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={pearlNetwork === "testnet"}
              onChange={() => setPearlNetwork("testnet")}
            />
            Testnet
          </label>
        </div>
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

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Developer</h2>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mockMode}
            onChange={(e) => setMockMode(e.target.checked)}
          />
          Mock mode (balances + send + bridge are simulated until live RPCs are wired)
        </label>
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
