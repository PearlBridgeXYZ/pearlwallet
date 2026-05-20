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
  feeSuspiciousReason,
} from "../../services/multisig";
import { bytesToHex } from "../../crypto/descriptor";
import { formatGrains } from "../../lib/format";
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
      // Two-pass: first inspect with a sentinel threshold + no cosigner
      // set to discover which (if any) local vault this PSBT belongs to.
      // If matched, re-inspect with the matched vault's pubkey set so
      // foreign signatures are counted separately (audit pass 2 Med #2).
      const first = inspectPsbt(psbtB64, 99);
      const vault = vaultByScriptHex.get(first.witnessScriptHex);
      if (!vault) {
        return {
          match: { kind: "unknown", witnessScriptHex: first.witnessScriptHex },
          info: first,
          error: null,
        };
      }
      const info = inspectPsbt(psbtB64, vault.threshold, vault.sortedPubkeysHex);
      return {
        match: { kind: "matched", vault, witnessScriptHex: info.witnessScriptHex },
        info,
        error: null,
      };
    } catch (e) {
      return {
        match: { kind: "unknown", witnessScriptHex: "" },
        info: null,
        error: e instanceof Error ? e.message : String(e),
      };
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
          <>
            <SignSummary
              vault={analysis.match.vault}
              signerCount={analysis.info.signerCount}
              signersHex={analysis.info.signersHex}
              inputCount={analysis.info.inputCount}
              thresholdMet={analysis.info.signerCount >= analysis.match.vault.threshold}
            />
            <OutputsPreview
              outputs={analysis.info.outputs}
              vaultAddress={analysis.match.vault.pearlAddress}
              feeGrains={analysis.info.feeGrains}
              feeUnknown={analysis.info.feeUnknown}
              totalInputGrains={analysis.info.totalInputGrains}
            />
            {analysis.info.foreignSignersHex.length > 0 && (
              <p className="rounded-md border-2 border-red-600 bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
                ⚠ This PSBT contains {analysis.info.foreignSignersHex.length}{" "}
                signature(s) from pubkeys outside the vault. Signing is blocked.
              </p>
            )}
            {(() => {
              const reason = feeSuspiciousReason(analysis.info);
              if (!reason) return null;
              return (
                <p className="rounded-md border-2 border-red-600 bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
                  ⚠ {reason}
                </p>
              );
            })()}
          </>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex flex-wrap gap-2">
          {analysis?.match.kind === "matched" && analysis.info && (
            <button
              className="btn-primary"
              disabled={
                busy ||
                analysis.info.signersHex.includes(
                  analysis.match.vault.myPubkeyHex,
                ) ||
                analysis.info.foreignSignersHex.length > 0 ||
                feeSuspiciousReason(analysis.info) !== null
              }
              onClick={doSign}
              title={
                analysis.info.foreignSignersHex.length > 0
                  ? "Refusing — PSBT has signatures from pubkeys outside the vault"
                  : feeSuspiciousReason(analysis.info)
                    ? "Refusing — fee looks abnormal"
                    : "Add your cosigner signature"
              }
            >
              {busy ? "Signing…" : "Sign"}
            </button>
          )}
          {psbtCurrent &&
            analysis?.match.kind === "matched" &&
            analysis.info &&
            analysis.info.signerCount >= analysis.match.vault.threshold && (
              <button
                className="btn-primary"
                disabled={
                  busy ||
                  analysis.info.foreignSignersHex.length > 0 ||
                  feeSuspiciousReason(analysis.info) !== null
                }
                onClick={doBroadcast}
              >
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

// OutputsPreview — the user is signing a PSBT they did NOT compose. The
// witness script proves it spends FROM their vault, but the OUTPUTS are
// the originator's choice. Render destination address(es) and amount(s)
// prominently before the Sign button so the user can refuse a malicious
// or wrong-address spend (audit pass 2 Med #1, applied to this page).
function OutputsPreview(props: {
  outputs: import("../../services/multisig").PsbtOutputInfo[];
  vaultAddress: string;
  feeGrains: bigint;
  feeUnknown: boolean;
  totalInputGrains: bigint;
}) {
  const { outputs, vaultAddress, feeGrains, feeUnknown, totalInputGrains } = props;
  if (outputs.length === 0) {
    return (
      <p className="rounded-md border border-amber-500 bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
        PSBT has no outputs — refuse to sign.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-ink-300 bg-white p-3 text-sm dark:border-ink-700 dark:bg-ink-900">
      <div className="text-xs font-semibold uppercase text-ink-500">
        Outputs you are about to sign
      </div>
      <ul className="mt-2 space-y-2">
        {outputs.map((o, i) => {
          const isChange = o.address === vaultAddress;
          return (
            <li key={i} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-ink-500">
                  #{i}
                  {isChange && (
                    <span className="ml-1 rounded bg-ink-100 px-1 text-[10px] uppercase dark:bg-ink-800">
                      change
                    </span>
                  )}
                </span>
                <span className="text-right font-medium">
                  {formatGrains(o.amountGrains)} PRL
                </span>
              </div>
              <div className="break-all font-mono text-xs text-ink-700 dark:text-ink-300">
                {o.address ?? `<non-Pearl script: ${o.scriptHex.slice(0, 24)}…>`}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-col gap-1 border-t border-ink-200 pt-2 text-xs dark:border-ink-700">
        <div className="flex justify-between">
          <span className="text-ink-500">Total inputs</span>
          <span className="font-medium">
            {feeUnknown ? "—" : `${formatGrains(totalInputGrains)} PRL`}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-500">Fee (paid to miner)</span>
          <span className="font-medium">
            {feeUnknown ? "unknown — refuse" : `${formatGrains(feeGrains)} PRL`}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs text-ink-500">
        Confirm each destination AND the fee are correct before signing. Once
        signed, you cannot un-sign.
      </p>
    </div>
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
