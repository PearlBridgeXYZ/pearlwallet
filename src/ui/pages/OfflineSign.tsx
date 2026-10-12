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
import { refusalMessage } from "../components/PendingBroadcasts";
import AnimatedPayloadQR from "../components/AnimatedPayloadQR";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { cryptoWorker } from "../../crypto/worker-client";
import { broadcastSignedPearlTx, composePearlSend, DUST_LIMIT_GRAINS } from "../../services/pearl-tx";
import { dustErrorMessage } from "../pearl-messages";
import { BroadcastStatusUnknownError } from "../../services/pearl-rpc";
import { PendingSpendConflictError } from "../../services/pending-spends";
import type { PearlNetwork } from "../../chains/pearl/network";
import {
  checkPearlUnsignedFee,
  decodePayload,
  encodePayload,
  pearlUnsignedVersion,
  type PearlSignedPayload,
  type PearlUnsignedPayload,
} from "../../lib/offline-signing/payload";
import {
  parseManualUtxos,
  planManualSpend,
  sumManualUtxoValue,
} from "../../lib/offline-signing/manual-utxo";
import type { PearlTxRequest } from "../../crypto/worker";
import { parsePRL } from "../../lib/format";

type Tab = "compose" | "sign" | "broadcast";

function grainsToPrl(grains: string | bigint): string {
  const g = typeof grains === "string" ? BigInt(grains) : grains;
  const whole = g / 100_000_000n;
  const frac = g % 100_000_000n;
  return `${whole}.${frac.toString().padStart(8, "0")}`.replace(/0+$/, "").replace(/\.$/, ".0");
}

/** Two address lists of the same wallet differ only in length (the
 *  watcher discovered more addresses than a seed-restored signer derives):
 *  they disagree only when an index both have holds different addresses. */
export function poolsDisagree(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return true;
  return false;
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
      <p className="mb-6 rounded-pb border border-warn-line bg-warn-bg p-4 text-sm leading-relaxed text-warn">
        Experimental. The wire format may evolve — keep all machines in your
        offline-signing flow on matching wallet versions.
      </p>
      <div className="mb-6 grid grid-cols-3 gap-1 rounded-pb bg-surface-2 p-1">
        {(["compose", "sign", "broadcast"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`tap rounded-pb px-3 py-2 text-sm capitalize leading-relaxed ${
              tab === t
                ? "bg-accent-bg text-on-accent"
                : "border border-transparent bg-transparent text-text-2 hover:border-line-strong"
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

/** The composer's amount in grains; null for empty or invalid input. Same
 *  parser as every other amount field: a minus sign or more than 8
 *  decimals is invalid, never silently dropped or truncated. */
export function offlineAmountGrains(text: string): bigint | null {
  if (!text.trim()) return null;
  try {
    return parsePRL(text);
  } catch {
    return null;
  }
}

function ComposeTab({ pool, network }: ComposeTabProps) {
  const changePool = useWallet((s) => s.addresses?.pearlChange);
  const deriveMore = useWallet((s) => s.derivePearlAddresses);
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

  const amountGrains = useMemo(() => offlineAmountGrains(amountPrl), [amountPrl]);

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
        changePool,
        deriveMore,
        // Bound to the address generation when this walk starts.
        onDiscovered: useWallet.getState().pearlDiscoveryHandler(),
        destination: destination.trim(),
        amountGrains,
        includeTip: false,
      });
      const utxos: PearlUnsignedPayload["utxos"] = composed.utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        valueGrains: u.valueGrains.toString(),
        scriptHex: u.scriptHex,
        poolIndex: u.index,
        ...(u.branch === 1 ? { branch: 1 as const } : {}),
      }));
      const p: PearlUnsignedPayload = {
        v: pearlUnsignedVersion(utxos),
        k: "pearl-unsigned",
        network,
        utxos,
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
      setError(dustErrorMessage(e) ?? (e instanceof Error ? e.message : String(e)));
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
        branch?: 0 | 1;
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
          ...(u.branch === 1 ? { branch: 1 as const } : {}),
        });
      }
      const totalIn = sumManualUtxoValue(inputs);
      // Dust destination refused, digits-only fee, sub-dust change paid
      // as fee (same rules as Send).
      const { feeGrains, changeGrains } = planManualSpend({
        totalInGrains: totalIn,
        amountGrains,
        feeInput: feeGrainsInput,
        dustLimitGrains: DUST_LIMIT_GRAINS,
      });
      const changeAddr = pool && pool.length > 0 ? pool[0] : "";
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
        v: pearlUnsignedVersion(filledUtxos),
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
      setError(dustErrorMessage(e) ?? (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <section className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Source of UTXOs</h2>
        <div className="mt-3 flex gap-3 text-sm leading-relaxed">
          <label className="flex min-h-11 cursor-pointer items-center gap-2">
            <input
              type="radio"
              checked={mode === "live"}
              onChange={() => setMode("live")}
            />
            Live UTXOs (online watcher)
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2">
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
            <p className="mt-2 text-xs text-text-3 leading-relaxed break-words">
              One UTXO per line as{" "}
              <span className="font-mono break-all min-w-0 tabular-nums">txid:vout:amountGrains:poolIndex:scriptHex</span>.
              Lines starting with <span className="font-mono break-all min-w-0 tabular-nums">#</span> are comments.
              scriptHex is the P2TR scriptPubKey (66 hex chars starting{" "}
              <span className="font-mono break-all min-w-0 tabular-nums">5120</span>).
            </p>
            <label className="block">
              <span className="label">Manual UTXOs</span>
              <textarea
                className="input mono mt-2 h-32 w-full sm:text-xs break-all min-w-0 tabular-nums leading-relaxed"
                placeholder={`# example\n${"a".repeat(64)}:0:50000000:0:5120${"a".repeat(64)}`}
                value={manualUtxoText}
                onChange={(e) => setManualUtxoText(e.target.value)}
              />
            </label>
            {manualParsed && (
              <div className="mt-2 text-xs leading-relaxed">
                <span className="break-all font-mono text-text-3 tabular-nums">
                  {manualParsed.utxos.length} UTXO(s) parsed,{" "}
                  total {grainsToPrl(sumManualUtxoValue(manualParsed.utxos))} PRL
                </span>
                {manualParsed.errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-danger">
                    {manualParsed.errors.map((e, i) => (
                      <li key={i}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <label className="mt-3 block text-xs text-text-3 leading-relaxed">
              Fee (grains, manual)
              <input
                className="input mt-2 w-full font-mono tabular-nums sm:w-48"
                value={feeGrainsInput}
                onChange={(e) => setFeeGrainsInput(e.target.value)}
              />
            </label>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Destination</h2>
        <label className="mt-3 block">
          <span className="label">Address</span>
          <input
            className="input mono w-full break-all min-w-0 tabular-nums"
            placeholder="prl1p…"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label className="mt-3 block">
          <span className="label">Amount (PRL)</span>
          <input
            className="input w-full font-mono tabular-nums sm:w-48"
            placeholder="0.0"
            value={amountPrl}
            onChange={(e) => setAmountPrl(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-primary mt-4 min-w-11"
          disabled={busy}
          onClick={mode === "live" ? generateLive : generateManual}
        >
          {busy ? "Composing…" : "Generate unsigned payload"}
        </button>
        {error && <p className="mt-2 text-sm text-danger leading-relaxed break-words">{error}</p>}
      </div>

      {payload && (
        <div className="card">
          <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Unsigned payload</h2>
          <p className="mt-2 text-xs text-text-3 leading-relaxed break-words">
            Show this QR to the signer, or copy the text below into the
            signer's "Sign" tab.
          </p>
          <div className="mt-3">
            <AnimatedPayloadQR payload={encoded} />
          </div>
          <label className="block">
            <span className="label">Unsigned payload to copy</span>
            <textarea
              className="input mono mt-3 h-24 w-full sm:text-xs break-all min-w-0 tabular-nums leading-relaxed"
              readOnly
              value={encoded}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          </label>
          {payload.v === 2 && (
            <p className="mt-3 rounded-pb border border-warn-line bg-warn-bg p-3 text-xs leading-relaxed text-warn">
              This transaction spends coins on change addresses, so the payload uses format
              v2. The offline signer must run this wallet version (v0.7) or newer; an older
              signer refuses it with E_PAYLOAD_VERSION instead of signing.
            </p>
          )}
          <div className="mt-2 break-all font-mono text-xs leading-relaxed text-text-3">
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
  // Fee the payload really pays, from its inputs and outputs. meta.feeGrains
  // is watcher-supplied display text and is never what we show as the fee.
  const feeCheck = useMemo(() => (decoded ? checkPearlUnsignedFee(decoded) : null), [decoded]);
  const [feeAck, setFeeAck] = useState(false);

  function doDecode() {
    setDecodeError(null);
    setSigned(null);
    setSignError(null);
    setFeeAck(false);
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
      const fee = checkPearlUnsignedFee(decoded);
      if (!fee.valid) throw new Error("E_PEARL_FEE: outputs add up to more than the inputs — refusing to sign");
      if (fee.needsAck && !feeAck) throw new Error("Confirm the network fee above before signing");
      // Payload poolIndex is the HD index within `branch` (absent = 0).
      // The worker derives that key and refuses any input whose script
      // it does not reproduce (E_PEARL_FOREIGN_INPUT).
      const req: PearlTxRequest = {
        utxos: decoded.utxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          valueGrains: u.valueGrains,
          scriptHex: u.scriptHex,
          branch: u.branch ?? 0,
          index: u.poolIndex,
        })),
        outputs: decoded.outputs,
        network,
        // The signer refuses anything paying more than the fee shown here.
        maxFeeGrains: fee.feeGrains.toString(),
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
      const msg = e instanceof Error ? e.message : String(e);
      setSignError(
        msg.includes("E_PEARL_FOREIGN_INPUT")
          ? "This request spends a coin that does not belong to this wallet, so it was not signed. Check that the request was made for this wallet. (E_PEARL_FOREIGN_INPUT)"
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  // Soft-warn if the payload's pool snapshot differs from the signer's
  // — a clear signal the user pasted into the wrong wallet.
  const poolMismatch = useMemo(
    () => !!decoded?.meta?.pool && !!pool && poolsDisagree(decoded.meta.pool, pool),
    [decoded, pool],
  );

  return (
    <section className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Paste unsigned payload</h2>
        <p className="mt-2 text-xs text-text-3 leading-relaxed break-words">
          Paste the text from the watcher's screen, or every frame's text
          concatenated. (Camera scanning ships in a later release; for
          now copy-paste the text the watcher displays beneath the QR.)
        </p>
        <label className="block">
          <span className="label">Transaction payload</span>
          <textarea
            className="input mono mt-3 h-32 w-full sm:text-xs break-all min-w-0 tabular-nums leading-relaxed"
            placeholder="Paste base64url-encoded payload…"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
        </label>
        <button type="button" className="btn-secondary mt-3 min-w-11" onClick={doDecode}>
          Decode payload
        </button>
        {decodeError && <p className="mt-2 text-sm text-danger leading-relaxed break-words">{decodeError}</p>}
      </div>

      {decoded && (
        <div className="card shadow-slabsm sm:shadow-slab">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-accent">Offline transaction preview</p>
          <h2 className="text-xl font-semibold tracking-tight">Review before you sign</h2>
          <p className="mt-1 text-xs text-text-3 leading-relaxed break-words">
            Verify EVERY line below matches what the watcher showed you
            before signing. The signer trusts what you paste — a swap
            here can redirect funds.
          </p>
          {poolMismatch && (
            <p className="mt-2 text-sm text-warn leading-relaxed break-words">
              ⚠ Payload's pool snapshot doesn't match this wallet's pool.
              Are you signing for the correct wallet?
            </p>
          )}
          <div className="mt-4 space-y-4 rounded-pb border border-line bg-surface-2 p-4 text-sm leading-relaxed">
            <div>
              <span className="font-semibold">Network:</span> {decoded.network}
            </div>
            <div>
              <span className="font-semibold">Inputs ({decoded.utxos.length}):</span>
              <ul className="mt-2 space-y-2 border-l border-line pl-3">
                {decoded.utxos.map((u, i) => (
                  <li key={i} className="font-mono break-all min-w-0 tabular-nums">
                    {u.txid.slice(0, 12)}…:{u.vout} · {grainsToPrl(u.valueGrains)} PRL · {u.branch === 1 ? "change" : "pool"}[{u.poolIndex}]
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <span className="font-semibold">Outputs ({decoded.outputs.length}):</span>
              <ul className="mt-2 space-y-2 border-l border-line pl-3">
                {decoded.outputs.map((o, i) => (
                  <li key={i} className="font-mono break-all min-w-0 tabular-nums">
                    {grainsToPrl(o.amountGrains)} PRL → {o.address}
                  </li>
                ))}
              </ul>
            </div>
            {feeCheck && feeCheck.valid && (
              <div className="break-all font-mono tabular-nums">
                <span className="font-sans font-semibold">Network fee (inputs − outputs):</span>{" "}
                {grainsToPrl(feeCheck.feeGrains)} PRL
              </div>
            )}
            {feeCheck && !feeCheck.valid && (
              <p className="font-semibold text-danger break-words">
                The outputs add up to more than the inputs. This payload can't be signed.
              </p>
            )}
            {feeCheck?.claimMismatch && feeCheck.claimedFeeGrains !== null && (
              <p className="rounded-pb border border-danger-line bg-danger-bg p-3 text-danger break-words">
                ⚠ The watcher's summary claims a fee of {grainsToPrl(feeCheck.claimedFeeGrains)} PRL,
                but the inputs and outputs pay {grainsToPrl(feeCheck.valid ? feeCheck.feeGrains : 0n)} PRL.
                Trust the computed fee; the watcher may be compromised.
              </p>
            )}
            {feeCheck?.highFee && (
              <p className="rounded-pb border border-warn-line bg-warn-bg p-3 text-warn break-words">
                ⚠ This fee is more than 2% of the coins being spent.
              </p>
            )}
            {decoded.meta?.summary && (
              <div className="break-all font-mono tabular-nums">
                <span className="font-sans font-semibold">Summary:</span> {decoded.meta.summary}
              </div>
            )}
          </div>
          {feeCheck?.needsAck && (
            <label className="mt-4 flex items-start gap-2 rounded-pb border border-warn-line p-3 text-sm leading-relaxed">
              <input type="checkbox" className="mt-1" checked={feeAck} onChange={(e) => setFeeAck(e.target.checked)} />
              <span>
                I checked the network fee of{" "}
                <span className="font-mono tabular-nums">{grainsToPrl(feeCheck.feeGrains)} PRL</span> and want to
                pay it.
              </span>
            </label>
          )}
          <button
            type="button"
            className="btn-primary mt-4 min-w-11"
            disabled={busy || !feeCheck?.valid || (feeCheck.needsAck && !feeAck)}
            onClick={doSign}
          >
            {busy ? "Signing…" : "Sign this transaction"}
          </button>
          {signError && <p className="mt-2 text-sm text-danger leading-relaxed break-words">{signError}</p>}
        </div>
      )}

      {signed && (
        <div className="card">
          <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Signed payload</h2>
          <p className="mt-2 text-xs text-text-3 leading-relaxed break-words">
            Carry this back to an online machine and paste into the
            Broadcast tab. The signer can now be wiped or shut down.
          </p>
          <div className="mt-3">
            <AnimatedPayloadQR payload={encodePayload(signed)} />
          </div>
          <label className="block">
            <span className="label">Signed payload to copy</span>
            <textarea
              className="input mono mt-3 h-24 w-full sm:text-xs break-all min-w-0 tabular-nums leading-relaxed"
              readOnly
              value={encodePayload(signed)}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          </label>
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
      // Same recorded path as Send and consolidation: inputs, destination
      // and amount are decoded from the raw hex and recorded first.
      const id = await broadcastSignedPearlTx(decoded.raw, { kind: "offline" });
      setTxid(id);
    } catch (e) {
      if (e instanceof BroadcastStatusUnknownError) {
        setBroadcastError(
          "Broadcast status unknown — the network didn't confirm receipt. " +
            (e.txid ? `Check the explorer for txid ${e.txid} ` : "Check the explorer ") +
            "before trying again. Broadcasting this same payload again is safe. It stays listed in the banner at the top until checked.",
        );
      } else if (e instanceof PendingSpendConflictError) {
        setBroadcastError(
          "A coin in this transaction is already being spent by another transaction this wallet broadcast recently. Not broadcast. " +
            "If that transaction's status is unknown, check it in the banner at the top — it can be released there only if the network doesn't have it and its coins haven't moved.",
        );
      } else if (refusalMessage(e)) {
        setBroadcastError(refusalMessage(e));
      } else {
        setBroadcastError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Paste signed payload</h2>
        <label className="block">
          <span className="label">Transaction payload</span>
          <textarea
            className="input mono mt-3 h-32 w-full sm:text-xs break-all min-w-0 tabular-nums leading-relaxed"
            placeholder="Paste base64url-encoded signed payload…"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
        </label>
        <button type="button" className="btn-secondary mt-3 min-w-11" onClick={doDecode}>
          Decode payload
        </button>
        {decodeError && <p className="mt-2 text-sm text-danger leading-relaxed break-words">{decodeError}</p>}
      </div>

      {decoded && (
        <div className="card">
          <h2 className="text-sm font-semibold leading-relaxed tracking-tight">Ready to broadcast</h2>
          <div className="mt-3 space-y-2 text-xs leading-relaxed">
            <div>
              <span className="font-semibold">Network:</span> {decoded.network}
            </div>
            <div>
              <span className="font-semibold">Raw hex:</span>{" "}
              <span className="font-mono break-all min-w-0 tabular-nums">
                {decoded.raw.slice(0, 48)}…{decoded.raw.slice(-32)}
              </span>
              <span className="text-text-3">
                {" "}
                ({(decoded.raw.length / 2).toLocaleString()} bytes)
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn-primary mt-4 min-w-11"
            disabled={busy}
            onClick={doBroadcast}
          >
            {busy ? "Broadcasting…" : "Broadcast"}
          </button>
          {broadcastError && (
            <p className="mt-2 text-sm text-danger leading-relaxed break-words">{broadcastError}</p>
          )}
          {txid && (
            <div className="mt-3 rounded-pb bg-surface-2 p-3 text-xs leading-relaxed">
              <div className="font-semibold text-ok">
                Sent.
              </div>
              <div className="mt-1 font-mono break-all min-w-0 tabular-nums">{txid}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
