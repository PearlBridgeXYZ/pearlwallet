import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { useWallet } from "../../state/wallet-store";
import {
  inspectPsbt,
  listVaults,
  signVaultPsbt,
  finalizeVaultPsbt,
  broadcastVaultTx,
  descriptorFromRecord,
} from "../../services/multisig";
import { bytesToHex } from "../../crypto/descriptor";
import type { VaultRecord } from "../../storage/db";

// SignMultisigPsbt — paste a PSBT, match it to a local vault by its
// witness script (which uniquely identifies the vault address), then
// sign and either re-share or broadcast.

type Match =
  | { kind: "unknown"; witnessScriptHex: string }
  | { kind: "matched"; vault: VaultRecord; witnessScriptHex: string };

export default function SignMultisigPsbt() {
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const status = useWallet((s) => s.status);
  const [psbtIn, setPsbtIn] = useState("");
  const [psbtCurrent, setPsbtCurrent] = useState<string | null>(null);
  const [vaults, setVaults] = useState<VaultRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [broadcastTxid, setBroadcastTxid] = useState<string | null>(null);

  useEffect(() => {
    if (!multisigEnabled) navigate("/dashboard", { replace: true });
  }, [multisigEnabled, navigate]);
  useEffect(() => {
    if (status !== "unlocked") navigate("/unlock", { replace: true });
  }, [status, navigate]);

  useEffect(() => {
    (async () => {
      try {
        setVaults(await listVaults());
      } catch {
        // tolerate; matching just falls through to "unknown"
      }
    })();
  }, []);

  // Re-derive every vault's outputScript so we can match by hex. We do
  // this once after vaults load — it's cheap (one taproot tweak per
  // vault) and lets the match be a single map lookup.
  const vaultByScriptHex = useMemo(() => {
    const map = new Map<string, VaultRecord>();
    for (const v of vaults) {
      try {
        const desc = descriptorFromRecord(v);
        map.set(bytesToHex(desc.outputScript), v);
      } catch {
        // skip — a corrupt record shouldn't break the rest
      }
    }
    return map;
  }, [vaults]);

  function analyse(psbtB64: string): {
    match: Match;
    info: ReturnType<typeof inspectPsbt> | null;
    error: string | null;
  } {
    try {
      // Use threshold=99 here as a sentinel — the match step needs the
      // info object; the actual threshold check below uses the matched
      // vault's threshold.
      const info = inspectPsbt(psbtB64, 99);
      const vault = vaultByScriptHex.get(info.witnessScriptHex);
      const match: Match = vault
        ? { kind: "matched", vault, witnessScriptHex: info.witnessScriptHex }
        : { kind: "unknown", witnessScriptHex: info.witnessScriptHex };
      return { match, info, error: null };
    } catch (e) {
      return { match: { kind: "unknown", witnessScriptHex: "" }, info: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const psbt = psbtCurrent ?? psbtIn;
  const analysis = useMemo(() => (psbt.trim() ? analyse(psbt.trim()) : null), [psbt, vaultByScriptHex]);

  async function doSign() {
    if (!analysis || analysis.match.kind !== "matched") return;
    setBusy(true);
    setError(null);
    try {
      const { psbtBase64 } = await signVaultPsbt({
        vault: analysis.match.vault,
        psbtBase64: psbt.trim(),
      });
      setPsbtCurrent(psbtBase64);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doBroadcast() {
    if (!psbtCurrent) return;
    setBusy(true);
    setError(null);
    try {
      const { rawHex } = finalizeVaultPsbt(psbtCurrent);
      const txid = await broadcastVaultTx(rawHex);
      setBroadcastTxid(txid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (broadcastTxid) {
    return (
      <Page title="Broadcast">
        <div className="card">
          <h2 className="text-lg font-semibold">Broadcast.</h2>
          <p className="mt-2 text-sm">
            Txid: <span className="break-all font-mono">{broadcastTxid}</span>
          </p>
          <p className="mt-2 text-xs text-ink-500">
            Confirming on chain — this can take a few minutes.
          </p>
          <div className="mt-4 flex gap-2">
            <Link to="/vaults" className="btn-primary flex-1 text-center">
              Back to vaults
            </Link>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Sign multisig PSBT">
      <div className="card flex flex-col gap-3">
        <p className="text-sm">
          Paste a base64 PSBT from any cosigner. The wallet matches it to
          one of your local vaults by its witness script — if no match,
          the vault hasn't been imported on this device yet and signing
          isn't safe.
        </p>

        <label className="block">
          <span className="label">PSBT (base64)</span>
          <textarea
            className="input mono"
            rows={8}
            value={psbtCurrent ?? psbtIn}
            onChange={(e) => {
              if (psbtCurrent) {
                // user is editing the signed-and-returned PSBT — drop our
                // session-current state so analysis runs on their input
                setPsbtCurrent(null);
              }
              setPsbtIn(e.target.value);
            }}
            placeholder="cHNidP8B..."
          />
        </label>

        {analysis && analysis.error && (
          <p className="text-sm text-red-600">Couldn't parse PSBT: {analysis.error}</p>
        )}
        {analysis && analysis.match.kind === "unknown" && !analysis.error && (
          <p className="text-sm text-amber-700">
            This PSBT doesn't match any vault on this device. Import the
            vault first ({" "}
            <Link to="/vaults/new" className="underline">
              create or join
            </Link>{" "}
            ) — signing without the local vault record means we can't
            verify the cosigner set, so we refuse.
          </p>
        )}
        {analysis && analysis.match.kind === "matched" && analysis.info && (
          <SignSummary
            vault={analysis.match.vault}
            signerCount={analysis.info.signerCount}
            signersHex={analysis.info.signersHex}
            inputCount={analysis.info.inputCount}
            thresholdMet={analysis.info.signerCount >= analysis.match.vault.threshold}
          />
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex flex-wrap gap-2">
          {analysis?.match.kind === "matched" && (
            <button
              className="btn-primary"
              disabled={
                busy ||
                analysis.info?.signersHex.includes(
                  analysis.match.vault.myPubkeyHex,
                ) === true
              }
              onClick={doSign}
            >
              {busy ? "Signing…" : "Sign"}
            </button>
          )}
          {psbtCurrent &&
            analysis?.match.kind === "matched" &&
            analysis.info &&
            analysis.info.signerCount >= analysis.match.vault.threshold && (
              <button className="btn-primary" disabled={busy} onClick={doBroadcast}>
                Broadcast
              </button>
            )}
          {psbtCurrent && (
            <button
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(psbtCurrent);
              }}
            >
              Copy signed PSBT
            </button>
          )}
        </div>

        {psbtCurrent &&
          analysis?.match.kind === "matched" &&
          analysis.info &&
          analysis.info.signerCount < analysis.match.vault.threshold && (
            <p className="text-xs text-ink-500">
              Send the signed PSBT back to the originator (or to the next
              cosigner) so the threshold can be reached.
            </p>
          )}
      </div>
    </Page>
  );
}

function SignSummary(props: {
  vault: VaultRecord;
  signerCount: number;
  signersHex: string[];
  inputCount: number;
  thresholdMet: boolean;
}) {
  const { vault, signerCount, signersHex, inputCount, thresholdMet } = props;
  const meSigned = signersHex.includes(vault.myPubkeyHex);
  return (
    <div className="rounded-xl border border-pearl-300 bg-pearl-50 p-3 text-sm dark:border-pearl-700 dark:bg-pearl-900/30">
      <div className="font-medium">Matched: {vault.label}</div>
      <div className="text-xs text-ink-500">
        {vault.threshold} of {vault.total} · {inputCount} input
        {inputCount === 1 ? "" : "s"}
      </div>
      <div className="mt-2 text-xs">
        Signatures: <span className="font-medium">{signerCount}</span> /{" "}
        {vault.threshold}
        {thresholdMet && (
          <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-[10px] uppercase text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
            threshold met
          </span>
        )}
      </div>
      {meSigned && (
        <p className="mt-1 text-xs text-pearl-700 dark:text-pearl-300">
          Your signature is already on this PSBT.
        </p>
      )}
    </div>
  );
}
