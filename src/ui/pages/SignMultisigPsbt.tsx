import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { useWallet } from "../../state/wallet-store";
import {
  inspectPsbt,
  listVaults,
  signVaultPsbt,
  signVaultSigProof,
  finalizeVaultPsbt,
  broadcastVaultTx,
  descriptorFromRecord,
  feeSuspiciousReason,
} from "../../services/multisig";
import { bytesToHex } from "../../crypto/descriptor";
import { formatGrains } from "../../lib/format";
import { useProposal } from "../../state/proposal-store";
import {
  postPartialSig,
  PostPartialSigError,
  fetchProposalStatus,
  type ProposalStatus,
} from "../../services/vault-relay";
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

  // Phase 1 sig-return state. When the PSBT arrived via a relay link
  // (VaultProposal stashed it), the token is held here so the user can
  // POST their partial sig back instead of having to manually email /
  // paste the signed PSBT to the originator.
  const [proposalToken, setProposalToken] = useState<string | null>(null);
  const [postState, setPostState] = useState<
    | { kind: "idle" }
    | { kind: "posting" }
    | { kind: "posted"; sigsCollected: number; threshold: number; thresholdMet: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [relayStatus, setRelayStatus] = useState<ProposalStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Latch the signedAt for an attempted post so retry-after-error reuses
  // the same (psbt, signedAt) pair and lands as idempotent rather than
  // as a 409 conflict. Cleared by anything that invalidates the prior
  // attempt (a re-sign, manual edit of the PSBT, new proposal).
  const postSignedAtRef = useRef<number | null>(null);

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

  // Prefill from a relay-delivered proposal if VaultProposal stashed one.
  // We consume it (single-shot) so a later tab refresh of /vaults/sign
  // doesn't re-stuff the textarea with stale content. Hold the proposal
  // token so the "Post to relay" button can find its way home.
  const consumePsbtProposal = useProposal((s) => s.consumePsbt);
  useEffect(() => {
    const pending = consumePsbtProposal();
    if (pending) {
      setPsbtIn(pending.payload);
      setProposalToken(pending.token);
    }
  }, [consumePsbtProposal]);

  // Status polling — only active when we have a proposal token. 5s
  // cadence is gentle on the relay (it's a single SQLite read) and
  // matches the spec's "wallet shows live progress" goal. Polling
  // stops once the threshold is met OR after a few terminal errors.
  const pollErrorsRef = useRef(0);
  useEffect(() => {
    if (!proposalToken) return;
    if (relayStatus?.thresholdMet) return;

    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const s = await fetchProposalStatus(proposalToken);
        if (cancelled) return;
        setRelayStatus(s);
        setStatusError(null);
        pollErrorsRef.current = 0;
        if (s.thresholdMet) return; // stop scheduling
      } catch (e) {
        if (cancelled) return;
        pollErrorsRef.current += 1;
        setStatusError(e instanceof Error ? e.message : String(e));
        if (pollErrorsRef.current >= 5) return; // give up after 5 failures
      }
      timer = window.setTimeout(tick, 5000);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [proposalToken, relayStatus?.thresholdMet]);

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
      // Re-signing invalidates any previous post attempt's latched
      // signedAt — the new PSBT bytes change the proof digest, so the
      // next /sig POST must be a fresh attempt rather than a retry.
      postSignedAtRef.current = null;
      setPostState({ kind: "idle" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doPostToRelay() {
    if (!psbtCurrent) return;
    if (!proposalToken) return;
    if (!analysis || analysis.match.kind !== "matched") return;

    setBusy(true);
    setPostState({ kind: "posting" });
    setError(null);
    try {
      // Reuse a latched signedAt if the user is retrying after a flake.
      // Without this, every click mints a fresh signedAt → a fresh
      // proof → and the relay sees it as a CONFLICT (different signed_at
      // under the same (token, signer)) rather than an idempotent retry.
      const signedAt =
        postSignedAtRef.current ?? Math.floor(Date.now() / 1000);
      postSignedAtRef.current = signedAt;
      const proof = await signVaultSigProof({
        vault: analysis.match.vault,
        token: proposalToken,
        psbtBase64: psbtCurrent,
        signedAt,
      });
      const r = await postPartialSig({
        token: proposalToken,
        psbtBase64: psbtCurrent,
        signerPubkeyHex: proof.signerPubkeyHex,
        signedAt,
        hmacProofHex: proof.hmacProofHex,
      });
      setPostState({
        kind: "posted",
        sigsCollected: r.sigsCollected,
        threshold: r.threshold,
        thresholdMet: r.thresholdMet,
      });
      // Kick a status refresh so the polling view shows our sig immediately.
      try {
        const s = await fetchProposalStatus(proposalToken);
        setRelayStatus(s);
      } catch {
        // tolerate — polling will retry
      }
    } catch (e) {
      const msg =
        e instanceof PostPartialSigError
          ? (e.code === "conflict"
              ? "The relay already has a different sig from this cosigner for this proposal. Refusing to overwrite."
              : e.code === "unauthorized"
                ? "The relay rejected your sig (proof or pubkey not accepted). Did the proposal whitelist your cosigner key?"
                : e.code === "not_found"
                  ? "Proposal expired before your sig arrived."
                  : e.code === "too_large"
                    ? "Signed PSBT is larger than the relay's per-sig cap."
                    : e.message)
          : e instanceof Error ? e.message : String(e);
      setPostState({ kind: "error", message: msg });
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
          {psbtCurrent && proposalToken && analysis?.match.kind === "matched" && (
            <button
              className="btn-primary"
              disabled={
                busy ||
                postState.kind === "posting" ||
                (postState.kind === "posted" && postState.thresholdMet)
              }
              onClick={doPostToRelay}
              title="Send your partial sig back to the relay so other cosigners and the originator can see it."
            >
              {postState.kind === "posting" ? "Posting…" : "Post sig to relay"}
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

        {postState.kind === "error" && (
          <p className="rounded-md border border-red-500 bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            Post failed: {postState.message}
          </p>
        )}
        {postState.kind === "posted" && (
          <p className="rounded-md border border-pearl-300 bg-pearl-50 p-2 text-sm text-pearl-800 dark:border-pearl-700 dark:bg-pearl-900/30 dark:text-pearl-200">
            Posted. Relay now has {postState.sigsCollected} of {postState.threshold}{" "}
            sig{postState.threshold === 1 ? "" : "s"}.
            {postState.thresholdMet && " Threshold met — the relay can assemble + broadcast."}
          </p>
        )}

        {proposalToken && (
          <RelayStatusPanel status={relayStatus} statusError={statusError} />
        )}

        {psbtCurrent &&
          !proposalToken &&
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

// RelayStatusPanel — small read-only view that polls /status every 5s and
// surfaces who's signed, who hasn't, and whether the threshold is met.
// Rendered only when the PSBT arrived via a relay-delivered proposal
// (i.e. we have a token to poll). Pure stateless presentation — the
// polling lives in SignMultisigPsbt's useEffect so we don't double-poll.
function RelayStatusPanel(props: {
  status: ProposalStatus | null;
  statusError: string | null;
}) {
  const { status, statusError } = props;
  if (!status && !statusError) {
    return (
      <div className="rounded-xl border border-ink-200 bg-ink-50 p-3 text-xs text-ink-600 dark:border-ink-700 dark:bg-ink-900/30 dark:text-ink-400">
        Checking relay status…
      </div>
    );
  }
  if (!status && statusError) {
    return (
      <div className="rounded-xl border border-amber-400 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
        Relay status unavailable: {statusError}
      </div>
    );
  }
  if (!status) return null;
  const signed = status.signers.filter((s) => s.signedAt !== null).length;
  return (
    <div className="rounded-xl border border-pearl-300 bg-pearl-50 p-3 text-sm dark:border-pearl-700 dark:bg-pearl-900/30">
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-semibold uppercase text-ink-500">
          Relay status
        </div>
        <div className="text-xs text-ink-500">
          {signed} / {status.threshold} signed
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-xs">
        {status.signers.map((s) => (
          <li key={s.pubkey} className="flex items-baseline justify-between gap-2">
            <span className="break-all font-mono text-ink-700 dark:text-ink-300">
              {s.pubkey.slice(0, 12)}…{s.pubkey.slice(-8)}
            </span>
            <span className="shrink-0 text-ink-500">
              {s.signedAt === null
                ? "waiting"
                : new Date(s.signedAt * 1000).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs">
        {status.thresholdMet ? (
          <span className="text-pearl-800 dark:text-pearl-200">
            Threshold met — the originating relay will assemble the witness
            and broadcast.
          </span>
        ) : (
          <span className="text-ink-600 dark:text-ink-400">
            Waiting for the remaining cosigner
            {status.threshold - signed === 1 ? "" : "s"} to post.
          </span>
        )}
      </p>
    </div>
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
