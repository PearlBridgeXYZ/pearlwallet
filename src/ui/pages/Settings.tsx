import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import InstallPWA from "../components/InstallPWA";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { pearlParams } from "../../chains/pearl/network";
import { ETH_RPC_PRESETS } from "../../chains/ethereum/network";
import { passwordAcceptable } from "../../lib/validate";

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
  const ethRpcOverride = useUI((s) => s.ethRpcOverride);
  const setEthRpcOverride = useUI((s) => s.setEthRpcOverride);
  const tipEnabled = useUI((s) => s.tipEnabled);
  const setTipEnabled = useUI((s) => s.setTipEnabled);
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const setMultisigEnabled = useUI((s) => s.setMultisigEnabled);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const setEthEnabled = useUI((s) => s.setEthEnabled);
  const offlineSigningEnabled = useUI((s) => s.offlineSigningEnabled);
  const setOfflineSigningEnabled = useUI((s) => s.setOfflineSigningEnabled);
  const btxEnabled = useUI((s) => s.btxEnabled);
  const setBtxEnabled = useUI((s) => s.setBtxEnabled);
  const btxRpcOverride = useUI((s) => s.btxRpcOverride);
  const setBtxRpcOverride = useUI((s) => s.setBtxRpcOverride);

  const defaultRpcUrl = pearlParams().rpcUrl;
  const defaultEthRpcUrl = "https://ethereum-rpc.publicnode.com";
  const [rpcDraft, setRpcDraft] = useState(pearlRpcOverride);
  const [rpcStatus, setRpcStatus] = useState<string | null>(null);
  const [ethRpcDraft, setEthRpcDraft] = useState(ethRpcOverride);
  const [ethRpcStatus, setEthRpcStatus] = useState<string | null>(null);
  const [btxRpcDraft, setBtxRpcDraft] = useState(btxRpcOverride);

  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicValue, setMnemonicValue] = useState<string | null>(null);
  const [mnemonicSecondsLeft, setMnemonicSecondsLeft] = useState(0);
  const mnemonicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pwExport, setPwExport] = useState("");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [wipePhrase, setWipePhrase] = useState("");
  const [wipePassword, setWipePassword] = useState("");
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

  // Tab-switch hide: when the tab is backgrounded, the 1Hz countdown is
  // throttled to ~1/min, so the 60s auto-hide effectively freezes. A user
  // who reveals their mnemonic, then alt-tabs, sees the phrase on the
  // next visibility check — exactly the shoulder-surf gap v0.1.5's
  // visible countdown was meant to address. Hide on `hidden` regardless
  // of how long ago they revealed it.
  useEffect(() => {
    function onHide() {
      if (document.hidden) hideMnemonic();
    }
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doChangePassword() {
    setError(null);
    setSuccess(null);
    if (newPw !== newPw2) {
      setError("New passwords don't match.");
      return;
    }
    const pw = passwordAcceptable(newPw);
    if (!pw.ok) {
      setError(pw.reason);
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

  function saveRpc(rawValue?: string) {
    setRpcStatus(null);
    const trimmed = (rawValue ?? rpcDraft).trim();
    if (trimmed === "") {
      try {
        setPearlRpcOverride("");
      } catch (e) {
        setRpcStatus(e instanceof Error ? e.message : "Failed to clear override.");
        return;
      }
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
    // v0.1.8 audit Opus2 M-3 / H-2: the store throws E_RPC_OVERRIDE_NOT_ALLOWED
    // for hosts outside the allowlist. The previous shape let the throw
    // propagate uncaught, surfacing as an unhandled promise rejection
    // (silent in prod, scary error in dev) while the UI showed a green
    // "Using custom: …" tick. Catch and translate to a clear inline message.
    try {
      setPearlRpcOverride(parsed.toString());
    } catch (e) {
      if (e instanceof Error && e.message === "E_RPC_OVERRIDE_NOT_ALLOWED") {
        setRpcStatus(
          "That host isn't on the wallet's Pearl RPC allowlist. Use one of: rpc.pearlbridge.xyz, pearlbridge.xyz, or a pearl-sentry-{fsn1,nbg1,hel1}-1.pearlbridge.xyz host.",
        );
      } else {
        setRpcStatus(e instanceof Error ? e.message : "Failed to save RPC override.");
      }
      return;
    }
    setRpcDraft(parsed.toString());
    setRpcStatus(`Using custom: ${parsed.toString()}`);
  }

  function resetRpc() {
    // Route the reset through saveRpc's validated path. setRpcDraft is
    // async so we pass "" explicitly rather than relying on state having
    // settled by the time saveRpc reads it.
    setRpcDraft("");
    saveRpc("");
  }

  function saveEthRpc(rawValue?: string) {
    setEthRpcStatus(null);
    const trimmed = (rawValue ?? ethRpcDraft).trim();
    if (trimmed === "") {
      try {
        setEthRpcOverride("");
      } catch (e) {
        setEthRpcStatus(e instanceof Error ? e.message : "Failed to clear override.");
        return;
      }
      setEthRpcStatus(`Using default (${defaultEthRpcUrl} → eth.drpc.org fallback).`);
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setEthRpcStatus("That's not a valid URL.");
      return;
    }
    if (parsed.protocol !== "https:") {
      setEthRpcStatus("RPC URL must use https://.");
      return;
    }
    try {
      setEthRpcOverride(parsed.toString());
    } catch (e) {
      if (e instanceof Error && e.message === "E_ETH_RPC_OVERRIDE_NOT_ALLOWED") {
        setEthRpcStatus(
          "That host isn't on the wallet's Ethereum RPC allowlist. Use one of: ethereum-rpc.publicnode.com, eth.drpc.org.",
        );
      } else {
        setEthRpcStatus(e instanceof Error ? e.message : "Failed to save RPC override.");
      }
      return;
    }
    setEthRpcDraft(parsed.toString());
    setEthRpcStatus(`Using custom: ${parsed.toString()}`);
  }

  function resetEthRpc() {
    setEthRpcDraft("");
    saveEthRpc("");
  }

  async function doWipe() {
    setError(null);
    if (wipePhrase.trim().toLowerCase() !== "wipe my wallet") {
      setError('Type "wipe my wallet" exactly to confirm.');
      return;
    }
    if (!wipePassword) {
      setError("Enter your password to confirm the wipe.");
      return;
    }
    try {
      await wipe(wipePassword);
      navigate("/");
    } catch (e) {
      setError(
        e instanceof Error && e.message === "E_PASSWORD_WRONG"
          ? "Incorrect password."
          : e instanceof Error ? e.message : "Wipe failed.",
      );
    }
  }

  return (
    <Page title="Settings">
      <p className="mb-6 text-sm leading-7 text-text-2">Manage access to this device, network connections and wallet preferences.</p>
      {/* Install PWA card — InstallPWA self-suppresses when already
          installed, when running from file://, or when the browser
          offers no install path (desktop Safari/Firefox). Sits at the
          top of Settings because finding the install option is the
          number-one reason users open this page on mobile. */}
      <div className="mb-4">
        <InstallPWA variant="card" />
      </div>

      <section className="card mb-6">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">Device access</h2>
        <p className="mt-3 text-sm leading-7 text-text-2">Lock this wallet when you step away. It also locks automatically after five minutes of inactivity.</p>
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

      <section className="card mb-6">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">Change password</h2>
        <div className="mt-4 flex flex-col gap-4">
          <label className="block min-w-0 flex-1">
            <span className="label">Current password</span>
            <input
              className="input"
              type="password"
              placeholder="Current password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
            />
          </label>
          <label className="block min-w-0 flex-1">
            <span className="label">New password</span>
            <input
              className="input"
              type="password"
              placeholder="New password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
          </label>
          <label className="block min-w-0 flex-1">
            <span className="label">Confirm new password</span>
            <input
              className="input"
              type="password"
              placeholder="Confirm new password"
              value={newPw2}
              onChange={(e) => setNewPw2(e.target.value)}
            />
          </label>
          <button onClick={doChangePassword} className="btn-primary self-start">
            Change password
          </button>
        </div>
      </section>

      <section className="card mb-6">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">Export recovery phrase</h2>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Re-enter your password to view your recovery phrase. Write it down privately and never share it. Only enter it when importing into a wallet you trust.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block min-w-0 flex-1">
            <span className="label">Password to reveal phrase</span>
            <input
              className="input"
              type="password"
              placeholder="Password"
              value={pwExport}
              onChange={(e) => setPwExport(e.target.value)}
            />
          </label>
          <button onClick={doExport} className="btn-secondary">Show</button>
        </div>
        {showMnemonic && (
          <div className="card mt-3 border-warn-line bg-warn-bg">
            <p className="text-xs text-warn">
              Don't screenshot this. Write it down.
            </p>
            {mnemonicValue ? (
              <>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">
                  {mnemonicValue}
                </pre>
                <p className="mt-2 text-xs text-warn">
                  Auto-hiding in {mnemonicSecondsLeft}s.
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm leading-7 text-text-2">
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

      <section className="card mb-6">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">Pearl RPC endpoint</h2>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Uses the PearlBridge RPC at{" "}
          <span className="font-mono">{defaultRpcUrl}</span>
          {pearlRpcOverride && " (currently overridden — see below)"}. Leave blank
          to use the default, or enter a supported PearlBridge RPC URL.
        </p>
        <p className="mt-3 border-l-2 border-warn-line pl-3 text-xs leading-6 text-warn">
          RPC services can see your addresses and can report incorrect balances or
          transaction details. Use an endpoint you trust.
        </p>
        <p className="mt-2 text-xs leading-6 text-text-3">
          This wallet accepts only supported RPC hosts. Other hosts are blocked.
        </p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
          <label className="block min-w-0 flex-1">
            <span className="label">Pearl RPC URL</span>
            <input
              className="input mono min-w-0 flex-1"
              placeholder={defaultRpcUrl}
              value={rpcDraft}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setRpcDraft(e.target.value)}
            />
          </label>
          <button onClick={() => saveRpc()} className="btn-primary">Save</button>
          <button onClick={resetRpc} className="btn-secondary" disabled={!pearlRpcOverride && !rpcDraft}>
            Reset
          </button>
        </div>
        {rpcStatus && <p className="mt-3 text-sm leading-7 text-text-2">{rpcStatus}</p>}
      </section>

      <section className="card mb-6 border-line-strong">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">Ethereum and bridging</h2>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Enable WPRL, ETH and PearlBridge. Turn this off for a Pearl-only
          view with no Ethereum balance lookups. Enabled by default.
        </p>
        <p className="mt-2 text-xs leading-6 text-text-3">
          Your Ethereum address stays the same when you turn this setting off
          and back on. Your recovery phrase does not change.
        </p>
        <label className="mt-4 flex min-h-11 items-center gap-3 border-t border-line pt-3 text-sm">
          <input
            type="checkbox"
            checked={ethEnabled}
            onChange={(e) => setEthEnabled(e.target.checked)}
          />
          Show WPRL, ETH and Bridge
        </label>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Status:{" "}
          {ethEnabled
            ? "Ethereum on — WPRL, ETH and Bridge are visible"
            : "Ethereum off — Pearl-only view"}
        </p>
      </section>

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">
          BTX surface{" "}
          <span className="text-xs font-normal text-amber-700 dark:text-amber-400">
            (beta · post-quantum)
          </span>
        </h2>
        <p className="mt-2 text-xs text-ink-500">
          BTX is a post-quantum L1 (ML-DSA / SLH-DSA keys, P2MR{" "}
          <span className="font-mono">btx1z…</span> addresses). With the surface
          on you get the BTX balance card, a BTX receive tab, and Send BTX. Same
          seed — the toggle is purely a UI gate, not a key change.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={btxEnabled}
            onChange={(e) => setBtxEnabled(e.target.checked)}
          />
          Enable BTX surface (balance, receive, send)
        </label>
        <p className="mt-2 text-xs text-ink-500">
          Status:{" "}
          {btxEnabled
            ? "BTX surface ON — balance, receive, and send are visible"
            : "BTX surface OFF — hidden from the wallet"}
        </p>
      </section>

      {btxEnabled && (
        <section className="card mb-4">
          <h2 className="text-sm font-semibold">BTX RPC endpoint</h2>
          <p className="mt-2 text-xs text-ink-500">
            Defaults to the public BTX edge pool (btx-rpc, btx-rpc2, btx-rpc3)
            {btxRpcOverride && " (currently overridden)"}. Point at any BTX
            RPC/indexer endpoint you trust, or leave blank for the defaults.
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            A malicious RPC can lie about your balance and UTXOs, and can see
            your address. It cannot move funds — your keys never leave this
            browser — so point only at endpoints you trust.
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Note: the wallet&apos;s CSP only permits the default BTX edge hosts;
            a custom host is blocked unless you run from source with an adjusted
            CSP.
          </p>
          <label className="mt-3 block text-xs text-ink-500">
            RPC URL
            <input
              type="text"
              value={btxRpcDraft}
              onChange={(e) => setBtxRpcDraft(e.target.value)}
              placeholder="https://btx-rpc.pearlbridge.xyz"
              className="input mt-1 w-full font-mono text-xs"
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setBtxRpcOverride(btxRpcDraft.trim())}
              className="btn-secondary"
              disabled={btxRpcDraft.trim() === btxRpcOverride}
            >
              Save
            </button>
            <button
              onClick={() => {
                setBtxRpcOverride("");
                setBtxRpcDraft("");
              }}
              className="btn-secondary"
              disabled={!btxRpcOverride && !btxRpcDraft}
            >
              Reset to default
            </button>
          </div>
        </section>
      )}

      {ethEnabled && (
        <section className="card mb-6">
          <h2 className="border-b border-line pb-3 text-lg font-semibold">Ethereum RPC endpoint</h2>
          <p className="mt-3 text-sm leading-7 text-text-2">
            Use the default Ethereum connection or choose a supported RPC preset.
            {ethRpcOverride && " A custom connection is currently selected."}{" "}
            Leave the URL blank to return to the default.
          </p>
          <p className="mt-3 border-l-2 border-warn-line pl-3 text-xs leading-6 text-warn">
            RPC services can see your address and can report incorrect balances,
            network fees or transaction details. Use an endpoint you trust.
          </p>
          <p className="mt-2 text-xs leading-6 text-text-3">
            This wallet accepts only supported RPC hosts. Other hosts are blocked.
          </p>
          <label className="mt-3 block text-xs text-text-3">
            Provider preset
            <select
              className="input mt-1 w-full"
              value={ETH_RPC_PRESETS.some((p) => p.url === ethRpcDraft) ? ethRpcDraft : ""}
              onChange={(e) => {
                const url = e.target.value;
                setEthRpcDraft(url);
                if (url) saveEthRpc(url); // presets are allowlisted — apply immediately
              }}
            >
              <option value="">Default connection</option>
              {ETH_RPC_PRESETS.map((p) => (
                <option key={p.url} value={p.url}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
            <label className="block min-w-0 flex-1">
              <span className="label">Ethereum RPC URL</span>
              <input
                className="input mono min-w-0 flex-1"
                placeholder="Supported https:// RPC URL"
                value={ethRpcDraft}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setEthRpcDraft(e.target.value)}
              />
            </label>
            <button onClick={() => saveEthRpc()} className="btn-primary">Save</button>
            <button onClick={resetEthRpc} className="btn-secondary" disabled={!ethRpcOverride && !ethRpcDraft}>
              Reset
            </button>
          </div>
          {ethRpcStatus && <p className="mt-3 text-sm leading-7 text-text-2">{ethRpcStatus}</p>}
        </section>
      )}

      <section className="card mb-6">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">Optional developer tip</h2>
        <p className="mt-3 text-sm leading-7 text-text-2">
          PRL sends can include a <span className="font-medium">0.1%</span> tip
          to support development, with a minimum of <span className="font-medium">1 PRL</span>.
          The tip is on by default and is shown in the send preview.
        </p>
        <p className="mt-2 text-xs leading-6 text-text-3">
          Turn it off below to remove the tip from future sends. The setting
          saves immediately. Network and bridge fees are separate.
        </p>
        <label className="mt-4 flex min-h-11 items-center gap-3 border-t border-line pt-3 text-sm">
          <input
            type="checkbox"
            checked={tipEnabled}
            onChange={(e) => setTipEnabled(e.target.checked)}
          />
          Enable tip on outgoing PRL transactions (default on)
        </label>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Status:{" "}
          {tipEnabled
            ? "Tip on — 0.1%, minimum 1 PRL, shown before sending"
            : "Tip off — no developer tip added"}
        </p>
      </section>

      <section className="card mb-6">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">
          Multisig vaults
        </h2>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Create and co-sign shared vaults with a chosen number of required
          approvals. Enabled by default.
        </p>
        <p className="mt-2 text-xs leading-6 text-text-3">
          Turning this off hides vaults. Existing vault records stay on this
          device and reappear when you turn it back on.
        </p>
        <label className="mt-4 flex min-h-11 items-center gap-3 border-t border-line pt-3 text-sm">
          <input
            type="checkbox"
            checked={multisigEnabled}
            onChange={(e) => setMultisigEnabled(e.target.checked)}
          />
          Show multisig vaults
        </label>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Status:{" "}
          {multisigEnabled
            ? "Vaults on — available in your wallet"
            : "Vaults off — hidden from your wallet"}
        </p>
      </section>

      <section className="card mb-6 border-warn-line">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">
          Offline signing · Experimental
        </h2>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Prepare a transaction online, sign it on an offline machine, then
          broadcast it online. Transfer transaction data between machines using
          QR codes or copy and paste. Keep your recovery phrase on the offline signer.
        </p>
        <p className="mt-2 text-xs leading-6 text-text-3">
          Advanced users can also prepare a transaction offline by supplying
          a list of unspent outputs.
        </p>
        <p className="mt-3 border-l-2 border-warn-line pl-3 text-xs leading-6 text-warn">
          Use matching wallet versions on all machines. The transaction format
          may change between releases.
        </p>
        <label className="mt-4 flex min-h-11 items-center gap-3 border-t border-line pt-3 text-sm">
          <input
            type="checkbox"
            checked={offlineSigningEnabled}
            onChange={(e) => setOfflineSigningEnabled(e.target.checked)}
          />
          Enable offline signing (experimental, default off)
        </label>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Status:{" "}
          {offlineSigningEnabled
            ? "Offline signing on — available from your dashboard"
            : "Offline signing off"}
        </p>
      </section>

      <section className="card mb-6">
        <h2 className="border-b border-line pb-3 text-lg font-semibold">Display</h2>
        <p className="mt-3 text-sm leading-7 text-text-2">PearlWallet currently uses the light paper theme. Your saved preference is retained.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span>Theme:</span>
          {(["system", "light", "dark"] as const).map((t) => (
            <label key={t} className="flex min-h-11 items-center gap-2 capitalize">
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

      <section className="card mb-6 border-danger-line">
        <h2 className="border-b border-line pb-3 text-lg font-semibold text-danger">Danger zone</h2>
        <p className="mt-3 text-sm leading-7 text-text-2">
          Wiping removes the encrypted wallet from this browser. Save your recovery
          phrase first; you will need it to restore access. Enter your password
          and the confirmation below to remove this wallet.
        </p>
        <div className="mt-4 flex flex-col gap-4">
          <label className="block min-w-0 flex-1">
            <span className="label">Type “wipe my wallet” to confirm</span>
            <input
              className="input"
              placeholder='Type "wipe my wallet"'
              value={wipePhrase}
              onChange={(e) => setWipePhrase(e.target.value)}
            />
          </label>
          <label className="block min-w-0 flex-1">
            <span className="label">Confirm your password</span>
            <input
              className="input"
              type="password"
              placeholder="Your password"
              value={wipePassword}
              onChange={(e) => setWipePassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button onClick={doWipe} className="btn-danger self-start">Wipe wallet from this browser</button>
        </div>
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-ok">{success}</p>}
    </Page>
  );
}
