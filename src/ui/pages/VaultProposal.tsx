import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useProposal } from "../../state/proposal-store";
import { fetchVaultProposal, VaultRelayError } from "../../services/vault-relay";
import { listVaults } from "../../services/multisig";

// VaultProposal — lands here from a TG/email link like
// pearlwallet.xyz/vault/tx/<43-char-token>. Behaviour:
//
//   1. If wallet is locked, prompt unlock with `?next=` so we come back.
//   2. Otherwise fetch the artifact from the relay (one-time consume).
//   3. Stash it in the transient proposal-store.
//   4. Dispatch to:
//        psbt-base64  → /vaults/sign  (prefilled PSBT)
//        tx-intent    → /vaults/<id>/send (prefilled destination + amount)
//
// We deliberately do the fetch only after unlock — the artifact is
// one-shot, so we never want to consume it while the user can't act on
// it. Same reason we never auto-redirect during the locked state: the
// user types a password, *then* the token is spent.

type Stage = "wait-unlock" | "fetching" | "dispatching" | "error";

interface UIState {
  stage: Stage;
  message: string;
  errorCode?: VaultRelayError["code"];
  consumedAt?: number;
}

export default function VaultProposal() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const status = useWallet((s) => s.status);
  const setProposal = useProposal((s) => s.set);

  const [ui, setUi] = useState<UIState>({
    stage: "wait-unlock",
    message: "Waiting for the wallet to unlock…",
  });

  // Track whether we already kicked off the fetch — strict-mode double
  // invocation would otherwise hit the one-time GET twice and the
  // second call lands a 410 on us.
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (status !== "unlocked") return;
    if (!token) return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    setUi({ stage: "fetching", message: "Loading proposal…" });

    (async () => {
      try {
        const artifact = await fetchVaultProposal(token);
        if (artifact.kind === "psbt-base64") {
          setProposal({
            kind: "psbt-base64",
            payload: artifact.payload,
            metadata: artifact.metadata,
            token,
          });
          setUi({ stage: "dispatching", message: "Loading signing screen…" });
          navigate("/vaults/sign", { replace: true });
          return;
        }
        if (artifact.kind === "tx-intent") {
          let intent: {
            vaultAddress: string;
            destination: string;
            amountGrains: string;
            memo?: string;
            network?: "mainnet" | "testnet";
          };
          try {
            const parsed = JSON.parse(artifact.payload);
            if (
              !parsed ||
              typeof parsed.vaultAddress !== "string" ||
              typeof parsed.destination !== "string" ||
              typeof parsed.amountGrains !== "string"
            ) {
              throw new Error("intent missing required fields");
            }
            intent = parsed;
          } catch (e) {
            setUi({
              stage: "error",
              message: `Malformed intent: ${
                e instanceof Error ? e.message : String(e)
              }`,
            });
            return;
          }

          const vaults = await listVaults();
          const match = vaults.find((v) => v.pearlAddress === intent.vaultAddress);
          if (!match) {
            setUi({
              stage: "error",
              message: `Proposal references a vault not in this wallet (${intent.vaultAddress}). Import or create the vault first, then re-open the link.`,
            });
            return;
          }
          setProposal({
            kind: "tx-intent",
            intent,
            metadata: artifact.metadata,
            token,
          });
          setUi({ stage: "dispatching", message: "Loading send screen…" });
          navigate(`/vaults/${match.id}/send`, { replace: true });
          return;
        }
        setUi({ stage: "error", message: "Unknown proposal kind." });
      } catch (e) {
        if (e instanceof VaultRelayError) {
          setUi({
            stage: "error",
            message:
              e.code === "not_found"
                ? "Proposal not found. It may have expired or never existed."
                : e.code === "already_consumed"
                ? "This proposal was already opened. If that wasn't you, treat it as a security incident — the link was leaked."
                : e.code === "malformed"
                ? "The relay returned an unexpected response."
                : "Could not reach the relay. Check your connection and try again.",
            errorCode: e.code,
            consumedAt: e.consumedAt,
          });
        } else {
          setUi({
            stage: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
  }, [status, token, navigate, setProposal]);

  if (!token) {
    return (
      <Page title="Proposal">
        <p className="text-sm text-ink-700">Missing token in URL.</p>
        <Link to="/dashboard" className="mt-3 inline-block text-sm text-pearl-700 hover:underline">
          Back to dashboard
        </Link>
      </Page>
    );
  }

  if (status !== "unlocked") {
    return (
      <Page title="Vault proposal">
        <p className="text-sm text-ink-700">
          Unlock the wallet first to load this proposal. The link can only be
          opened once, so we wait until you're ready.
        </p>
        <Link
          to={`/unlock?next=/vault/tx/${encodeURIComponent(token)}`}
          className="btn-primary mt-4 inline-block"
        >
          Unlock to continue
        </Link>
      </Page>
    );
  }

  return (
    <Page title="Vault proposal">
      <p className="text-sm text-ink-700">{ui.message}</p>
      {ui.stage === "error" && (
        <div className="mt-4 flex flex-col gap-2">
          {ui.errorCode === "already_consumed" && ui.consumedAt && (
            <p className="text-xs text-ink-500">
              Consumed at: {new Date(ui.consumedAt * 1000).toISOString()}
            </p>
          )}
          <div className="flex gap-2">
            <Link to="/dashboard" className="btn-secondary">
              Back to dashboard
            </Link>
            <Link to="/vaults/sign" className="btn-secondary">
              Paste a PSBT instead
            </Link>
          </div>
        </div>
      )}
    </Page>
  );
}
