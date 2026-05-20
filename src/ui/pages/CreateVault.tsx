import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useUI } from "../../state/ui-store";
import { useWallet } from "../../state/wallet-store";
import {
  exportMyCosignerDescriptor,
  importCosignerDescriptor,
  createVault,
  listVaults,
  type ExportedPubkeyDescriptor,
} from "../../services/multisig";
import {
  MULTISIG_MAX_COSIGNERS,
  MULTISIG_MIN_THRESHOLD,
  vaultDescriptorFromPubkeys,
} from "../../chains/pearl/multisig";
import { pearlParams } from "../../chains/pearl/network";
import { hexToBytes } from "../../crypto/descriptor";

// CreateVault — multi-step wizard. Each stage is a discrete UI shape so
// the user can step back without losing state, and so a misclick on a
// later screen can't silently change earlier inputs.
//
// Stages:
//   1. setup    — label, m, n, our slot (BIP-32 account + key index)
//   2. mine     — derive + show our pubkey descriptor to share
//   3. peers    — paste cosigner descriptors (n-1 of them)
//   4. confirm  — preview vault address + cosigner set, save
//
// The vault is NOT persisted until the user clicks "Save vault" in step 4.

type Stage = "setup" | "mine" | "peers" | "confirm";

interface PeerEntry {
  json: string;
  pubkeyHex: string;
  label: string;
  originPath: string;
  network: "mainnet";
}

export default function CreateVault() {
  const navigate = useNavigate();
  const multisigEnabled = useUI((s) => s.multisigEnabled);
  const status = useWallet((s) => s.status);

  const [stage, setStage] = useState<Stage>("setup");
  const [error, setError] = useState<string | null>(null);

  // Step 1 — setup
  const [label, setLabel] = useState("");
  const [threshold, setThreshold] = useState(2);
  const [total, setTotal] = useState(3);
  const [vaultAccount, setVaultAccount] = useState(0);
  const [keyIndex, setKeyIndex] = useState(0);

  // Step 2 — my descriptor
  const [mine, setMine] = useState<ExportedPubkeyDescriptor | null>(null);
  const [deriving, setDeriving] = useState(false);

  // Step 3 — peer descriptors
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [peerPaste, setPeerPaste] = useState("");

  // Step 4 — saving
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!multisigEnabled) navigate("/dashboard", { replace: true });
  }, [multisigEnabled, navigate]);
  useEffect(() => {
    if (status !== "unlocked") navigate("/unlock", { replace: true });
  }, [status, navigate]);

  // If the user changes total or our slot AFTER deriving the pubkey, the
  // derived descriptor becomes stale — drop it so they can't accidentally
  // proceed with a pubkey at the wrong path.
  useEffect(() => {
    setMine(null);
    setPeers([]);
  }, [vaultAccount, keyIndex]);

  // Suggest a unique vaultAccount on first mount so two vaults created in
  // sequence don't accidentally share a derivation slot. Reads existing
  // vaults and picks max(existing.myVaultAccount) + 1.
  useEffect(() => {
    (async () => {
      try {
        const existing = await listVaults();
        const max = existing.reduce(
          (m, v) => (v.myVaultAccount > m ? v.myVaultAccount : m),
          -1,
        );
        setVaultAccount(max + 1);
      } catch {
        // If the registry can't be read, the default of 0 is fine — the
        // wizard still works, the user just might pick a colliding slot.
      }
    })();
  }, []);

  function setupValid(): true | string {
    const lbl = label.trim();
    if (lbl.length === 0 || lbl.length > 64) return "Label is required (≤ 64 chars).";
    if (!Number.isInteger(threshold) || threshold < MULTISIG_MIN_THRESHOLD) {
      return `Threshold must be at least ${MULTISIG_MIN_THRESHOLD}.`;
    }
    if (!Number.isInteger(total) || total < 1 || total > MULTISIG_MAX_COSIGNERS) {
      return `Total cosigners must be 1–${MULTISIG_MAX_COSIGNERS}.`;
    }
    if (threshold > total) return "Threshold cannot exceed total cosigners.";
    if (!Number.isInteger(vaultAccount) || vaultAccount < 0) {
      return "Vault account index must be ≥ 0.";
    }
    if (!Number.isInteger(keyIndex) || keyIndex < 0) {
      return "Key index must be ≥ 0.";
    }
    return true;
  }

  async function deriveMine() {
    setError(null);
    setDeriving(true);
    // Capture indices at call time. If the user changes account/index while
    // the worker is deriving, the in-flight result must NOT clobber a now-
    // stale slot. Audit pass 3 M2. (The service-level pubkey-vs-path check
    // is the correctness backstop; this just prevents a confusing UX where
    // a derived pubkey appears to be for a slot the user no longer chose.)
    const capturedAccount = vaultAccount;
    const capturedKeyIndex = keyIndex;
    try {
      const r = await exportMyCosignerDescriptor({
        vaultAccount: capturedAccount,
        keyIndex: capturedKeyIndex,
        label: label.trim() || "me",
      });
      // Guard against stale-result write: only commit if the indices the
      // user CURRENTLY has selected still match what we derived for.
      if (capturedAccount !== vaultAccount || capturedKeyIndex !== keyIndex) {
        return;
      }
      setMine(r);
    } catch (e) {
      setError(`Couldn't derive your cosigner pubkey: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeriving(false);
    }
  }

  function addPeerFromPaste() {
    setError(null);
    const raw = peerPaste.trim();
    if (raw.length === 0) return;
    try {
      const { descriptor, pubkeyHex } = importCosignerDescriptor(raw);
      if (mine && pubkeyHex === mine.pubkeyHex) {
        setError("That descriptor is YOUR pubkey — paste each cosigner's, not your own.");
        return;
      }
      if (peers.some((p) => p.pubkeyHex === pubkeyHex)) {
        setError("That cosigner is already added.");
        return;
      }
      setPeers([
        ...peers,
        {
          json: raw,
          pubkeyHex,
          label: descriptor.label,
          originPath: descriptor.originPath,
          network: descriptor.network,
        },
      ]);
      setPeerPaste("");
    } catch (e) {
      setError(`Invalid descriptor: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function removePeer(pubkeyHex: string) {
    setPeers(peers.filter((p) => p.pubkeyHex !== pubkeyHex));
  }

  async function save() {
    if (!mine) return;
    setError(null);
    setSaving(true);
    try {
      const allHex = [mine.pubkeyHex, ...peers.map((p) => p.pubkeyHex)];
      const rec = await createVault({
        label: label.trim(),
        threshold,
        cosignerPubkeysHex: allHex,
        myPubkeyHex: mine.pubkeyHex,
        myVaultAccount: vaultAccount,
        myKeyIndex: keyIndex,
        network: "mainnet",
      });
      navigate(`/vaults/${rec.id}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (stage === "setup") {
    return (
      <Page title="Create vault">
        <div className="card flex flex-col gap-3">
          <label className="block">
            <span className="label">Vault label</span>
            <input
              className="input"
              placeholder="e.g. Family savings 2-of-3"
              value={label}
              maxLength={64}
              onChange={(e) => setLabel(e.target.value)}
            />
            <span className="mt-1 block text-xs text-ink-500">
              Local-only label. Stays on this device.
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">Threshold (m)</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={MULTISIG_MAX_COSIGNERS}
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value || "0", 10))}
              />
            </label>
            <label className="block">
              <span className="label">Total cosigners (n)</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={MULTISIG_MAX_COSIGNERS}
                value={total}
                onChange={(e) => setTotal(parseInt(e.target.value || "0", 10))}
              />
            </label>
          </div>
          <p className="text-xs text-ink-500">
            Any {threshold || "?"} of {total || "?"} cosigners can spend.
          </p>

          <details className="rounded-xl border border-ink-200 p-3 text-xs dark:border-ink-700">
            <summary className="cursor-pointer font-medium">
              Advanced — derivation path
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">Vault account</span>
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={vaultAccount}
                  onChange={(e) => setVaultAccount(parseInt(e.target.value || "0", 10))}
                />
              </label>
              <label className="block">
                <span className="label">Key index</span>
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={keyIndex}
                  onChange={(e) => setKeyIndex(parseInt(e.target.value || "0", 10))}
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-ink-500">
              Your pubkey is derived under{" "}
              <span className="font-mono">
                m/86'/808276'/100'/{vaultAccount}'/{keyIndex}
              </span>
              . Different vaults SHOULD use different (account, index)
              pairs so a leak in one doesn't compromise the others.
            </p>
          </details>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="mt-2 flex gap-2">
            <Link to="/vaults" className="btn-secondary">
              Cancel
            </Link>
            <button
              className="btn-primary flex-1"
              onClick={() => {
                const v = setupValid();
                if (v !== true) {
                  setError(v);
                  return;
                }
                setError(null);
                setStage("mine");
              }}
            >
              Next: derive my key
            </button>
          </div>
        </div>
      </Page>
    );
  }

  if (stage === "mine") {
    return (
      <Page title="Create vault — your cosigner key">
        <div className="card flex flex-col gap-3">
          <p className="text-sm">
            Step 2 of 4 — derive your cosigner pubkey and share the
            descriptor with every other cosigner.
          </p>

          {!mine && (
            <button
              className="btn-primary"
              onClick={deriveMine}
              disabled={deriving}
            >
              {deriving ? "Deriving…" : "Derive my pubkey"}
            </button>
          )}

          {mine && (
            <>
              <div>
                <span className="label">Your x-only pubkey</span>
                <div className="break-all font-mono text-xs">{mine.pubkeyHex}</div>
              </div>
              <div>
                <span className="label">Origin path</span>
                <div className="font-mono text-xs">{mine.originPath}</div>
              </div>
              <div>
                <span className="label">Descriptor (share with cosigners)</span>
                <textarea
                  className="input mono"
                  rows={9}
                  readOnly
                  value={mine.json}
                />
                <button
                  className="btn-secondary mt-2 text-xs"
                  onClick={() => {
                    void navigator.clipboard?.writeText(mine.json);
                  }}
                >
                  Copy descriptor
                </button>
              </div>
              <p className="text-xs text-ink-500">
                Send this to your cosigners over any channel you trust.
                The descriptor contains a public key — it never leaks
                your seed.
              </p>
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="mt-2 flex gap-2">
            <button className="btn-secondary" onClick={() => setStage("setup")}>
              Back
            </button>
            <button
              className="btn-primary flex-1"
              disabled={!mine}
              onClick={() => setStage("peers")}
            >
              Next: add cosigners
            </button>
          </div>
        </div>
      </Page>
    );
  }

  if (stage === "peers") {
    const needed = Math.max(0, total - 1 - peers.length);
    return (
      <Page title="Create vault — add cosigners">
        <div className="card flex flex-col gap-3">
          <p className="text-sm">
            Step 3 of 4 — paste one cosigner descriptor at a time. You
            need <span className="font-medium">{total - 1}</span>{" "}
            descriptors from your peers (plus your own = {total} total).
          </p>

          <label className="block">
            <span className="label">Paste cosigner descriptor JSON</span>
            <textarea
              className="input mono"
              rows={8}
              value={peerPaste}
              onChange={(e) => setPeerPaste(e.target.value)}
              placeholder='{ "version": 1, "type": "pearl-multisig-pubkey", … }'
            />
          </label>
          <button
            className="btn-secondary"
            onClick={addPeerFromPaste}
            disabled={peerPaste.trim().length === 0}
          >
            Add cosigner
          </button>

          <div>
            <span className="label">
              Cosigners added ({peers.length}/{total - 1})
            </span>
            {peers.length === 0 ? (
              <p className="text-xs text-ink-500">None yet.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {peers.map((p) => (
                  <li
                    key={p.pubkeyHex}
                    className="flex items-start justify-between gap-2 rounded-xl border border-ink-200 p-2 text-xs dark:border-ink-700"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{p.label}</div>
                      <div className="break-all font-mono text-[10px] text-ink-500">
                        {p.pubkeyHex}
                      </div>
                      <div className="font-mono text-[10px] text-ink-500">
                        {p.originPath}
                      </div>
                    </div>
                    <button
                      className="shrink-0 text-red-600 underline"
                      onClick={() => removePeer(p.pubkeyHex)}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="mt-2 flex gap-2">
            <button className="btn-secondary" onClick={() => setStage("mine")}>
              Back
            </button>
            <button
              className="btn-primary flex-1"
              disabled={needed > 0}
              onClick={() => setStage("confirm")}
            >
              {needed > 0
                ? `Need ${needed} more cosigner${needed === 1 ? "" : "s"}`
                : "Next: confirm"}
            </button>
          </div>
        </div>
      </Page>
    );
  }

  // stage === "confirm"
  return (
    <Page title="Create vault — confirm">
      <div className="card flex flex-col gap-3">
        <p className="text-sm">
          Step 4 of 4 — verify the vault address with every cosigner BEFORE
          funding. Identical inputs land on the same address; anyone with a
          different address is seeing a different (potentially hostile)
          pubkey set.
        </p>
        <ConfirmPanel
          label={label.trim()}
          threshold={threshold}
          total={total}
          myPubkeyHex={mine?.pubkeyHex ?? ""}
          peers={peers}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="mt-2 flex gap-2">
          <button className="btn-secondary" onClick={() => setStage("peers")}>
            Back
          </button>
          <button className="btn-primary flex-1" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save vault"}
          </button>
        </div>
      </div>
    </Page>
  );
}

// Confirm panel re-derives the vault address from the inputs the user
// just typed — same library call the eventual save uses, so the preview
// can't drift from the persisted record.
function ConfirmPanel(props: {
  label: string;
  threshold: number;
  total: number;
  myPubkeyHex: string;
  peers: PeerEntry[];
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setAddress(null);
    setErr(null);
    try {
      const pubkeys = [props.myPubkeyHex, ...props.peers.map((p) => p.pubkeyHex)].map(
        (h) => hexToBytes(h),
      );
      const d = vaultDescriptorFromPubkeys(
        props.threshold,
        pubkeys,
        pearlParams("mainnet"),
      );
      setAddress(d.address);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [props.threshold, props.myPubkeyHex, props.peers]);

  return (
    <dl className="space-y-2 text-sm">
      <div>
        <dt className="text-ink-500">Label</dt>
        <dd className="font-medium">{props.label}</dd>
      </div>
      <div>
        <dt className="text-ink-500">Policy</dt>
        <dd>
          {props.threshold} of {props.total}
        </dd>
      </div>
      <div>
        <dt className="text-ink-500">Cosigners (you first, then peers in entry order)</dt>
        <dd className="mt-1 flex flex-col gap-1 break-all font-mono text-[10px]">
          <span className="text-pearl-700 dark:text-pearl-300">{props.myPubkeyHex} (me)</span>
          {props.peers.map((p) => (
            <span key={p.pubkeyHex}>
              {p.pubkeyHex} ({p.label})
            </span>
          ))}
        </dd>
      </div>
      <div>
        <dt className="text-ink-500">Vault address (verify with every cosigner)</dt>
        {address ? (
          <dd className="mt-1 break-all rounded-xl border border-pearl-300 bg-pearl-50 p-3 font-mono text-xs dark:border-pearl-700 dark:bg-pearl-900/30">
            {address}
          </dd>
        ) : err ? (
          <dd className="text-sm text-red-600">{err}</dd>
        ) : (
          <dd className="text-xs text-ink-500">Computing…</dd>
        )}
      </div>
    </dl>
  );
}
