import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import InstallPWA from "../components/InstallPWA";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { pearlParams } from "../../chains/pearl/network";
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

  const defaultRpcUrl = pearlParams().rpcUrl;
  const defaultEthRpcUrl = "https://ethereum-rpc.publicnode.com";
  const [rpcDraft, setRpcDraft] = useState(pearlRpcOverride);
  const [rpcStatus, setRpcStatus] = useState<string | null>(null);
  const [ethRpcDraft, setEthRpcDraft] = useState(ethRpcOverride);
  const [ethRpcStatus, setEthRpcStatus] = useState<string | null>(null);

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
          "That host isn't on the wallet's RPC allowlist. Use one of: rpc.pearlbridge.xyz, ethereum-rpc.publicnode.com, eth.drpc.org, or pearlbridge.xyz.",
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
      {/* Install PWA card — InstallPWA self-suppresses when already
          installed, when running from file://, or when the browser
          offers no install path (desktop Safari/Firefox). Sits at the
          top of Settings because finding the install option is the
          number-one reason users open this page on mobile. */}
      <div className="mb-4">
        <InstallPWA variant="card" />
      </div>

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
        <p className="mt-1 text-xs text-ink-500">
          Note: the wallet&apos;s strict Content Security Policy only permits
          requests to the default RPC hosts. A custom RPC URL on a different
          host will be blocked by the browser unless you&apos;re running the
          wallet from source with an adjusted CSP.
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
          <button onClick={() => saveRpc()} className="btn-primary">Save</button>
          <button onClick={resetRpc} className="btn-secondary" disabled={!pearlRpcOverride && !rpcDraft}>
            Reset
          </button>
        </div>
        {rpcStatus && <p className="mt-2 text-xs text-ink-500">{rpcStatus}</p>}
      </section>

      <section className="card mb-4 border-pearl-200 dark:border-pearl-900/40">
        <h2 className="text-sm font-semibold">Ethereum surface (WPRL + ETH + Bridge)</h2>
        <p className="mt-2 text-xs text-ink-500">
          The Ethereum side of the wallet — Wrapped PRL on Ethereum, native
          ETH for gas, and the PearlBridge mint/burn flow — is{" "}
          <span className="font-medium">off by default</span> in v0.2.0.
          If you only hold PRL on Pearl L1, leave it off and the wallet
          stays Pearl-only: no Eth RPC calls, no WPRL/ETH tiles, no
          Bridge button. Turning it on exposes the Send WPRL, Send ETH,
          and Bridge surfaces and starts polling the Eth chain for
          balances.
        </p>
        <p className="mt-1 text-xs text-ink-500">
          Same BIP-39 seed, same Eth address (BIP-44{" "}
          <span className="font-mono">m/44'/60'/0'/0/0</span>) — the
          toggle is purely a UI gate, not a key change. Your Eth address
          is identical whether the surface is on or off.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ethEnabled}
            onChange={(e) => setEthEnabled(e.target.checked)}
          />
          Enable Ethereum surface (WPRL, ETH, Bridge)
        </label>
        <p className="mt-2 text-xs text-ink-500">
          Status:{" "}
          {ethEnabled
            ? "Eth surface ON — WPRL, ETH, and Bridge are visible"
            : "Eth surface OFF — Pearl-only wallet"}
        </p>
      </section>

      {ethEnabled && (
        <section className="card mb-4">
          <h2 className="text-sm font-semibold">Ethereum RPC endpoint</h2>
          <p className="mt-2 text-xs text-ink-500">
            Defaults to{" "}
            <span className="font-mono">{defaultEthRpcUrl}</span> with{" "}
            <span className="font-mono">eth.drpc.org</span> as fallback
            {ethRpcOverride && " (currently overridden — see below)"}.
            Point at any Ethereum JSON-RPC endpoint you trust, or leave
            blank to use the defaults.
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            A malicious RPC can lie about your balance, gas market, and tx
            state, and can see your address. It cannot move funds (your
            keys never leave this browser) but only point at endpoints
            you trust.
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Note: the wallet&apos;s strict Content Security Policy only
            permits requests to the default Eth RPC hosts. A custom RPC
            URL on a different host will be blocked by the browser unless
            you&apos;re running the wallet from source with an adjusted
            CSP.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              className="input mono flex-1"
              placeholder={defaultEthRpcUrl}
              value={ethRpcDraft}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setEthRpcDraft(e.target.value)}
            />
            <button onClick={() => saveEthRpc()} className="btn-primary">Save</button>
            <button onClick={resetEthRpc} className="btn-secondary" disabled={!ethRpcOverride && !ethRpcDraft}>
              Reset
            </button>
          </div>
          {ethRpcStatus && <p className="mt-2 text-xs text-ink-500">{ethRpcStatus}</p>}
        </section>
      )}

      <section className="card mb-4">
        <h2 className="text-sm font-semibold">Tip the PearlWallet devs</h2>
        <p className="mt-2 text-xs text-ink-500">
          When you send PRL, the wallet can add a small tip output to the
          PearlWallet developer fees address — <span className="font-medium">10 bps</span>{" "}
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

      <section className="card mb-4 border-amber-200 dark:border-amber-900/40">
        <h2 className="text-sm font-semibold">
          Experimental: multisig vaults
        </h2>
        <p className="mt-2 text-xs text-ink-500">
          Multisig vaults are an opt-in experimental feature. Turning
          this on adds a <span className="font-medium">Vaults</span>{" "}
          surface to the wallet that exposes the on-chain primitives —
          BIP-342 tapscript m-of-n under a NUMS-bound P2TR output,
          BIP-67-sorted cosigner pubkeys, and the cosigner pubkey
          descriptor format — so the construction can be independently
          audited.
        </p>
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          The user-facing flows (create vault, exchange cosigner
          descriptors, draft and co-sign transactions) are{" "}
          <span className="font-medium">in development</span> and not
          yet shipped. Don't move funds into a vault until those
          flows land. Off by default.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={multisigEnabled}
            onChange={(e) => setMultisigEnabled(e.target.checked)}
          />
          Enable Vaults surface (experimental, default off)
        </label>
        <p className="mt-2 text-xs text-ink-500">
          Status:{" "}
          {multisigEnabled
            ? "Vaults surface ON — primitives are visible at /vaults"
            : "Vaults surface OFF — wallet behaves exactly as singlesig"}
        </p>
      </section>

      <section className="card mb-4 border-amber-200 dark:border-amber-900/40">
        <h2 className="text-sm font-semibold">
          Experimental: offline signing (Armory-style)
        </h2>
        <p className="mt-2 text-xs text-ink-500">
          Offline signing splits the wallet into three roles —{" "}
          <span className="font-medium">Watcher</span> (online, builds an
          unsigned transaction with current UTXO data),{" "}
          <span className="font-medium">Signer</span> (offline / air-gapped,
          adds signatures), and{" "}
          <span className="font-medium">Broadcaster</span> (online, pushes
          the signed transaction). The three machines exchange payloads
          by QR or copy-paste — no shared network, no key on the online
          side. The same wallet code runs in all three roles.
        </p>
        <p className="mt-1 text-xs text-ink-500">
          A fully-offline machine can also{" "}
          <span className="font-medium">compose</span> a transaction
          itself by pasting a manually-curated UTXO list. The signer
          page then accepts that just like a watcher-built payload.
        </p>
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          The wire format is v1 and may evolve. Don't trust a payload
          encoded today to be decodable by a future major release —
          keep watcher + signer + broadcaster on matching versions.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={offlineSigningEnabled}
            onChange={(e) => setOfflineSigningEnabled(e.target.checked)}
          />
          Enable offline signing surface (experimental, default off)
        </label>
        <p className="mt-2 text-xs text-ink-500">
          Status:{" "}
          {offlineSigningEnabled
            ? "Offline signing ON — see Offline Signing in the nav"
            : "Offline signing OFF"}
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
          You&apos;ll need your recovery phrase to restore. Password required so
          a passer-by with brief device access can&apos;t nuke your keystore.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <input
            className="input"
            placeholder='Type "wipe my wallet"'
            value={wipePhrase}
            onChange={(e) => setWipePhrase(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="Your password"
            value={wipePassword}
            onChange={(e) => setWipePassword(e.target.value)}
            autoComplete="current-password"
          />
          <button onClick={doWipe} className="btn-danger self-start">Wipe</button>
        </div>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm text-emerald-700">{success}</p>}
    </Page>
  );
}
