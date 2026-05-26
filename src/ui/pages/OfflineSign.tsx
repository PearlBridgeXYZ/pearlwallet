// Offline signing surface — Armory-style watcher / signer / broadcaster.
//
// Three tabs, one page:
//
//   Compose   — build an unsigned Pearl tx. Online mode uses the live
//               UTXO pool; offline mode lets the user paste a manual
//               UTXO list. Output: animated QR + copyable text.
//   Sign      — paste an unsigned payload (text or scanned QR text),
//               review it, sign with the loaded wallet keys, then emit
//               a signed payload as animated QR + text. No network.
//   Broadcast — paste a signed payload, decode, push to the Pearl RPC.
//
// The same page renders correctly in all three roles — a user can keep
// the wallet on one machine that's online for Compose + Broadcast, and
// another machine (or the same downloaded HTML file on an air-gapped
// laptop) running ONLY the Sign tab.
//
// Gated behind the experimental `offlineSigningEnabled` flag. Bounces
// to /dashboard if a deep-link arrives while the flag is off.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import AnimatedPayloadQR from "../components/AnimatedPayloadQR";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { cryptoWorker } from "../../crypto/worker-client";
import { composePearlSend } from "../../services/pearl-tx";
import { broadcastPearlTx } from "../../services/pearl-rpc";
import type { PearlNetwork } from "../../chains/pearl/network";
import {
  decodePayload,
  encodePayload,
  type PearlSignedPayload,
  type PearlUnsignedPayload,
} from "../../lib/offline-signing/payload";
import {
  parseManualUtxos,
  sumManualUtxoValue,
} from "../../lib/offline-signing/manual-utxo";
import type { PearlTxRequest } from "../../crypto/worker";

type Tab = "compose" | "sign" | "broadcast";

function grainsToPrl(grains: string | bigint): string {
  const g = typeof grains === "string" ? BigInt(grains) : grains;
  const whole = g / 100_000_000n;
  const frac = g % 100_000_000n;
  return `${whole}.${frac.toString().padStart(8, "0")}`.replace(/0+$/, "").replace(/\.$/, ".0");
}

export default function OfflineSign() {
  const navigate = useNavigate();
  const status = useWallet((s) => s.status);
  const addresses = useWallet((s) => s.addresses);
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const offlineSigningEnabled = useUI((s) => s.offlineSigningEnabled);
  const [tab, setTab] = useState<Tab>("compose");

  // Bounce to /dashboard if the feature flag is off (deep-link safety —
  // App.tsx also bounces but the page-level guard prevents a brief
  // render flash).
  useEffect(() => {
    if (status === "unlocked" && !offlineSigningEnabled) {
      navigate("/dashboard", { replace: true });
    }
  }, [status, offlineSigningEnabled, navigate]);

  return (
    <Page title="Offline signing">
      <p className="mb-4 text-xs text-amber-700 dark:text-amber-400">
        Experimental. The wire format is v1 and may evolve — keep all
        machines in your offline-signing flow on matching wallet versions.
      </p>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {(["compose", "sign", "broadcast"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`tap rounded-md px-3 py-2 text-sm capitalize ${
              tab === t
                ? "bg-pearl-700 text-white"
                : "border bg-transparent hover:bg-ink-100 dark:hover:bg-ink-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "compose" && (
        <ComposeTab pool={addresses?.pearlPool ?? null} network={pearlNetwork} />
      )}
      {tab === "sign" && (
        <SignTab network={pearlNetwork} pool={addresses?.pearlPool ?? null} />
      )}
      {tab === "broadcast" && <BroadcastTab />}
    </Page>
  );
}

// ── Compose tab ──────────────────────────────────────────────────────────

interface ComposeTabProps {
  pool: string[] | null;
  network: PearlNetwork;
}

function ComposeTab({ pool, network }: ComposeTabProps) {
  const [mode, setMode] = useState<"live" | "manual">("live");
  const [destination, setDestination] = useState("");
  const [amountPrl, setAmountPrl] = useState("");
  const [manualUtxoText, setManualUtxoText] = useState("");
  const [feeGrainsInput, setFeeGrainsInput] = useState("500000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<PearlUnsignedPayload | null>(null);
  const encoded = useMemo(() => (payload ? encodePayload(payload) : ""), [payload]);

  // Parse manual UTXOs as the user types so we can show feedback.
  const manualParsed = useMemo(
    () => (mode === "manual" ? parseManualUtxos(manualUtxoText) : null),
    [mode, manualUtxoText],
  );

  const amountGrains = useMemo(() => {
    if (!amountPrl.trim()) return null;
    try {
      const [whole, frac = ""] = amountPrl.trim().split(".");
      const fracPadded = (frac + "00000000").slice(0, 8);
      return BigInt(whole!) * 100_000_000n + BigInt(fracPadded || "0");
    } catch {
      return null;
    }
  }, [amountPrl]);

  async function generateLive() {
    setBusy(true);
    setError(null);
    setPayload(null);
    try {
      if (!pool || pool.length === 0) {
        throw new Error("E_NO_POOL: wallet must be unlocked to use live UTXO mode");
      }
      if (!destination.trim()) throw new Error("Destination address required");
      if (amountGrains === null || amountGrains <= 0n) {
        throw new Error("Amount must be > 0");
      }
      const composed = await composePearlSend({
        network,
        pool,
        destination: destination.trim(),
        amountGrains,
        includeTip: false,
      });
      const p: PearlUnsignedPayload = {
        v: 1,
        k: "pearl-unsigned",
        network,
        utxos: composed.utxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          valueGrains: u.valueGrains.toString(),
          scriptHex: u.scriptHex,
          poolIndex: u.poolIndex,
        })),
        outputs: composed.outputs.map((o) => ({
          address: o.address,
          amountGrains: o.amountGrains.toString(),
        })),
        meta: {
          composedAt: Date.now(),
          summary: `Send ${grainsToPrl(composed.outputs[0]!.amountGrains)} PRL${
            composed.outputs.length > 1
              ? ", change " + grainsToPrl(composed.changeGrains) + " PRL"
              : ""
          }`,
          pool,
          feeGrains: composed.feeGrains.toString(),
        },
      };
      setPayload(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function generateManual() {
    setError(null);
    setPayload(null);
    try {
      if (!manualParsed || manualParsed.errors.length > 0) {
        throw new Error("Fix the UTXO entries above first");
      }
      if (manualParsed.utxos.length === 0) {
        throw new Error("At least one UTXO required");
      }
      if (!destination.trim()) throw new Error("Destination address required");
      if (amountGrains === null || amountGrains <= 0n) {
        throw new Error("Amount must be > 0");
      }
      const inputs = manualParsed.utxos;
      // The signer needs scriptHex on every input. Fill in any missing
      // ones from the pool (the user only typed `txid:vout:amount:idx`).
      // We can only do this if the pool is loaded — when the wallet is
      // locked / not present, the user MUST provide scriptHex.
      const filledUtxos: Array<{
        txid: string;
        vout: number;
        valueGrains: string;
        scriptHex: string;
        poolIndex: number;
      }> = [];
      for (const u of inputs) {
        let scriptHex = u.scriptHex;
        if (!scriptHex) {
          if (!pool || !pool[u.poolIndex]) {
            throw new Error(
              `UTXO ${u.txid.slice(0, 8)}… missing scriptHex and pool[${u.poolIndex}] is unknown (wallet not loaded)`,
            );
          }
          // We have the address but not the scriptHex; tell the user we
          // can't auto-derive without bech32m wiring on this page.
          // The honest path is to require scriptHex in manual mode.
          throw new Error(
            `UTXO ${u.txid.slice(0, 8)}… missing scriptHex. Include it as the 5th colon-separated field.`,
          );
        }
        filledUtxos.push({
          txid: u.txid,
          vout: u.vout,
          valueGrains: u.valueGrains,
          scriptHex,
          poolIndex: u.poolIndex,
        });
      }
      const totalIn = sumManualUtxoValue(inputs);
      const feeGrains = BigInt(feeGrainsInput || "0");
      if (feeGrains < 0n) throw new Error("Fee cannot be negative");
      const changeAddr = pool && pool.length > 0 ? pool[0] : "";
      const changeGrains = totalIn - amountGrains - feeGrains;
      if (changeGrains < 0n) {
        throw new Error(
          `Insufficient: inputs ${grainsToPrl(totalIn)} PRL, need ${grainsToPrl(amountGrains)} + fee ${grainsToPrl(feeGrains)}`,
        );
      }
      const outputs: Array<{ address: string; amountGrains: string }> = [
        { address: destination.trim(), amountGrains: amountGrains.toString() },
      ];
      if (changeGrains > 0n) {
        if (!changeAddr) {
          throw new Error(
            "Change > 0 but no change address (load the wallet, or set amount = total inputs - fee)",
          );
        }
        outputs.push({ address: changeAddr, amountGrains: changeGrains.toString() });
      }
      const p: PearlUnsignedPayload = {
        v: 1,
        k: "pearl-unsigned",
        network,
        utxos: filledUtxos,
        outputs,
        meta: {
          composedAt: Date.now(),
          summary: `Manual: ${grainsToPrl(amountGrains)} PRL to ${destination.trim().slice(0, 12)}…, change ${grainsToPrl(changeGrains)} PRL`,
          feeGrains: feeGrains.toString(),
        },
      };
      setPayload(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold">Source of UTXOs</h2>
        <div className="mt-3 flex gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={mode === "live"}
              onChange={() => setMode("live")}
            />
            Live UTXOs (online watcher)
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={mode === "manual"}
              onChange={() => setMode("manual")}
            />
            Manual UTXO list (offline)
          </label>
        </div>
        {mode === "manual" && (
          <>
            <p className="mt-2 text-xs text-ink-500">
              One UTXO per line as{" "}
              <span className="font-mono">txid:vout:amountGrains:poolIndex:scriptHex</span>.
              Lines starting with <span className="font-mono">#</span> are comments.
              scriptHex is the P2TR scriptPubKey (66 hex chars starting{" "}
              <span className="font-mono">5120</span>).
            </p>
            <textarea
              className="input mono mt-2 h-32 w-full text-xs"
              placeholder={`# example\n${"a".repeat(64)}:0:50000000:0:5120${"a".repeat(64)}`}
              value={manualUtxoText}
              onChange={(e) => setManualUtxoText(e.target.value)}
            />
            {manualParsed && (
              <div className="mt-2 text-xs">
                <span className="text-ink-500">
                  {manualParsed.utxos.length} UTXO(s) parsed,{" "}
                  total {grainsToPrl(sumManualUtxoValue(manualParsed.utxos))} PRL
                </span>
                {manualParsed.errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-red-600">
                    {manualParsed.errors.map((e, i) => (
                      <li key={i}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <label className="mt-3 block text-xs text-ink-500">
              Fee (grains, manual)
              <input
                className="input mt-1 w-40"
                value={feeGrainsInput}
                onChange={(e) => setFeeGrainsInput(e.target.value)}
              />
            </label>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold">Destination</h2>
        <label className="mt-3 block text-xs text-ink-500">
          Address
          <input
            className="input mono mt-1 w-full"
            placeholder="prl1q…"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label className="mt-3 block text-xs text-ink-500">
          Amount (PRL)
          <input
            className="input mt-1 w-40"
            placeholder="0.0"
            value={amountPrl}
            onChange={(e) => setAmountPrl(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-primary mt-4"
          disabled={busy}
          onClick={mode === "live" ? generateLive : generateManual}
        >
          {busy ? "Composing…" : "Generate unsigned payload"}
        </button>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      {payload && (
        <div className="card">
          <h2 className="text-sm font-semibold">Unsigned payload</h2>
          <p className="mt-2 text-xs text-ink-500">
            Show this QR to the signer, or copy the text below into the
            signer's "Sign" tab.
          </p>
          <div className="mt-3">
            <AnimatedPayloadQR payload={encoded} />
          </div>
          <textarea
            className="input mono mt-3 h-24 w-full text-xs"
            readOnly
            value={encoded}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <div className="mt-2 text-xs text-ink-500">
            {encoded.length.toLocaleString()} chars · {payload.utxos.length} input(s) ·{" "}
            {payload.outputs.length} output(s)
            {payload.meta?.summary && <> · {payload.meta.summary}</>}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Sign tab ─────────────────────────────────────────────────────────────

interface SignTabProps {
  network: PearlNetwork;
  pool: string[] | null;
}

function SignTab({ network, pool }: SignTabProps) {
  const status = useWallet((s) => s.status);
  const [inputText, setInputText] = useState("");
  const [decoded, setDecoded] = useState<PearlUnsignedPayload | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [signed, setSigned] = useState<PearlSignedPayload | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function doDecode() {
    setDecodeError(null);
    setSigned(null);
    setSignError(null);
    try {
      const p = decodePayload(inputText);
      if (p.k !== "pearl-unsigned") {
        throw new Error(
          `Expected an unsigned Pearl payload, got ${p.k}. Did you paste a signed payload into the signer tab?`,
        );
      }
      if (p.network !== network) {
        throw new Error(
          `Payload network is ${p.network} but this wallet is loaded for ${network}.`,
        );
      }
      setDecoded(p);
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
      setDecoded(null);
    }
  }

  async function doSign() {
    if (!decoded) return;
    setBusy(true);
    setSignError(null);
    try {
      if (status !== "unlocked") {
        throw new Error("Wallet must be unlocked to sign");
      }
      const req: PearlTxRequest = {
        utxos: decoded.utxos,
        outputs: decoded.outputs,
        network,
      };
      const { raw } = await cryptoWorker.call<"signPearlTx", { raw: string }>("signPearlTx", { req });
      const out: PearlSignedPayload = {
        v: 1,
        k: "pearl-signed",
        network,
        raw,
      };
      setSigned(out);
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Soft-warn if the payload's pool snapshot differs from the signer's
  // — a clear signal the user pasted into the wrong wallet.
  const poolMismatch = useMemo(() => {
    if (!decoded?.meta?.pool || !pool) return false;
    if (decoded.meta.pool.length !== pool.length) return true;
    for (let i = 0; i < pool.length; i++) {
      if (decoded.meta.pool[i] !== pool[i]) return true;
    }
    return false;
  }, [decoded, pool]);

  return (
    <section className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold">Paste unsigned payload</h2>
        <p className="mt-2 text-xs text-ink-500">
          Paste the text from the watcher's screen, or every frame's text
          concatenated. (Camera scanning ships in a later release; for
          now copy-paste the text the watcher displays beneath the QR.)
        </p>
        <textarea
          className="input mono mt-3 h-32 w-full text-xs"
          placeholder="Paste base64url-encoded payload…"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <button type="button" className="btn-secondary mt-3" onClick={doDecode}>
          Decode payload
        </button>
        {decodeError && <p className="mt-2 text-sm text-red-600">{decodeError}</p>}
      </div>

      {decoded && (
        <div className="card">
          <h2 className="text-sm font-semibold">Review transaction</h2>
          <p className="mt-1 text-xs text-ink-500">
            Verify EVERY line below matches what the watcher showed you
            before signing. The signer trusts what you paste — a swap
            here can redirect funds.
          </p>
          {poolMismatch && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              ⚠ Payload's pool snapshot doesn't match this wallet's pool.
              Are you signing for the correct wallet?
            </p>
          )}
          <div className="mt-3 space-y-3 text-xs">
            <div>
              <span className="font-semibold">Network:</span> {decoded.network}
            </div>
            <div>
              <span className="font-semibold">Inputs ({decoded.utxos.length}):</span>
              <ul className="ml-4 list-disc">
                {decoded.utxos.map((u, i) => (
                  <li key={i} className="font-mono">
                    {u.txid.slice(0, 12)}…:{u.vout} · {grainsToPrl(u.valueGrains)} PRL · pool[{u.poolIndex}]
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <span className="font-semibold">Outputs ({decoded.outputs.length}):</span>
              <ul className="ml-4 list-disc">
                {decoded.outputs.map((o, i) => (
                  <li key={i} className="font-mono">
                    {grainsToPrl(o.amountGrains)} PRL → {o.address}
                  </li>
                ))}
              </ul>
            </div>
            {decoded.meta?.feeGrains && (
              <div>
                <span className="font-semibold">Fee:</span>{" "}
                {grainsToPrl(decoded.meta.feeGrains)} PRL
              </div>
            )}
            {decoded.meta?.summary && (
              <div>
                <span className="font-semibold">Summary:</span> {decoded.meta.summary}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn-primary mt-4"
            disabled={busy}
            onClick={doSign}
          >
            {busy ? "Signing…" : "Sign this transaction"}
          </button>
          {signError && <p className="mt-2 text-sm text-red-600">{signError}</p>}
        </div>
      )}

      {signed && (
        <div className="card">
          <h2 className="text-sm font-semibold">Signed payload</h2>
          <p className="mt-2 text-xs text-ink-500">
            Carry this back to an online machine and paste into the
            Broadcast tab. The signer can now be wiped or shut down.
          </p>
          <div className="mt-3">
            <AnimatedPayloadQR payload={encodePayload(signed)} />
          </div>
          <textarea
            className="input mono mt-3 h-24 w-full text-xs"
            readOnly
            value={encodePayload(signed)}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
        </div>
      )}
    </section>
  );
}

// ── Broadcast tab ────────────────────────────────────────────────────────

function BroadcastTab() {
  const [inputText, setInputText] = useState("");
  const [decoded, setDecoded] = useState<PearlSignedPayload | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function doDecode() {
    setDecodeError(null);
    setTxid(null);
    setBroadcastError(null);
    try {
      const p = decodePayload(inputText);
      if (p.k !== "pearl-signed") {
        throw new Error(
          `Expected a signed Pearl payload, got ${p.k}. Did you paste an unsigned payload?`,
        );
      }
      setDecoded(p);
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
      setDecoded(null);
    }
  }

  async function doBroadcast() {
    if (!decoded) return;
    setBusy(true);
    setBroadcastError(null);
    try {
      const id = await broadcastPearlTx(decoded.raw);
      setTxid(id);
    } catch (e) {
      setBroadcastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold">Paste signed payload</h2>
        <textarea
          className="input mono mt-3 h-32 w-full text-xs"
          placeholder="Paste base64url-encoded signed payload…"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <button type="button" className="btn-secondary mt-3" onClick={doDecode}>
          Decode payload
        </button>
        {decodeError && <p className="mt-2 text-sm text-red-600">{decodeError}</p>}
      </div>

      {decoded && (
        <div className="card">
          <h2 className="text-sm font-semibold">Ready to broadcast</h2>
          <div className="mt-3 space-y-2 text-xs">
            <div>
              <span className="font-semibold">Network:</span> {decoded.network}
            </div>
            <div>
              <span className="font-semibold">Raw hex:</span>{" "}
              <span className="font-mono break-all">
                {decoded.raw.slice(0, 48)}…{decoded.raw.slice(-32)}
              </span>
              <span className="text-ink-500">
                {" "}
                ({(decoded.raw.length / 2).toLocaleString()} bytes)
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn-primary mt-4"
            disabled={busy}
            onClick={doBroadcast}
          >
            {busy ? "Broadcasting…" : "Broadcast"}
          </button>
          {broadcastError && (
            <p className="mt-2 text-sm text-red-600">{broadcastError}</p>
          )}
          {txid && (
            <div className="mt-3 rounded bg-emerald-50 p-3 text-xs dark:bg-emerald-950/30">
              <div className="font-semibold text-emerald-800 dark:text-emerald-300">
                Sent.
              </div>
              <div className="mt-1 font-mono break-all">{txid}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
