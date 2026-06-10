import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { db, type BridgeCrossingRecord } from "../../storage/db";
import { bridgeConfig } from "../../services/bridge";
import {
  approveWprlForBridge,
  readWprlAllowance,
  requestBurn,
} from "../../services/eth-tx";
import { sendPearl } from "../../services/pearl-tx";
import { ethTxExplorerUrl } from "../../chains/ethereum/network";
import {
  MINT_IN_FLIGHT,
  classifyBurn,
  classifyMint,
  fetchBridgeStatus,
  fetchBurnQuote,
  fetchBurnStatus,
  fetchMintQuote,
  fetchMintStatus,
  fetchPearlTxStatus,
  fetchRecentDeposit,
  grainsToPrlString,
  prlToGrains,
  resolveDepositAddress,
  type BridgeStatus,
  type BurnQuote,
  type DepositTofuStore,
  type MintQuote,
} from "../../services/bridge-v1";

// TOFU store for the wrap deposit address (audit H-2/N3), backed by a
// DEDICATED table keyed on the eth address — idempotent put(), never
// pollutes the user-facing address book.
const depositTofu: DepositTofuStore = {
  async get(key) {
    return (await db.bridgeDepositPins.get(key))?.pearlAddress ?? null;
  },
  async set(key, value) {
    await db.bridgeDepositPins.put({ ethAddress: key, pearlAddress: value, pinnedAt: Date.now() });
  },
};

// Native PRL ↔ WPRL bridging (v0.4.0). The public /v1 API supplies quotes
// and lifecycle state; ALL signing happens locally:
//   wrap   = native Pearl send to the relay-derived deposit address
//   unwrap = approve (when allowance short) + requestBurn, signed in-wallet
//
// Trust rules (audited — see AUDIT-v0.4.0-*.md):
//   - UNWRAP is fully API-substitution-proof: burn calldata only ever
//     targets the contract addresses PINNED in network.ts, the quote's
//     plan is cross-checked against them, and the payout Pearl address is
//     the wallet's own. The amount signed is the user's locally-parsed
//     value, asserted equal to the quote (never the API echo).
//   - WRAP destination is the relay-DERIVED deposit address, which the
//     wallet cannot derive independently. Defenses: trust-on-first-use
//     pinning (refuse if it ever changes), the address is shown for visual
//     verification against pearlbridge.xyz, and the sent amount is the
//     user's input. Residual risk = a compromise active on the very first
//     wrap; the real fix (relay-published xpub for local derivation) is
//     tracked as a follow-up.

type Tab = "wrap" | "unwrap" | "activity";

const POLL_MS = 15_000;

function fmtPrl(g: bigint): string {
  return `${grainsToPrlString(g)} PRL`;
}

export default function Bridge() {
  const navigate = useNavigate();
  const addresses = useWallet((s) => s.addresses);
  const pearlNetwork = useWallet((s) => s.pearlNetwork);
  const ethNetwork = useWallet((s) => s.ethNetwork);
  const pool = useWallet((s) =>
    s.addresses?.pearlPool ?? (s.addresses ? [s.addresses.pearl] : []),
  );

  const [tab, setTab] = useState<Tab>("wrap");
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [crossings, setCrossings] = useState<BridgeCrossingRecord[]>([]);

  // ── bridge status (paused banner, fees, windows) ──────────────────────
  useEffect(() => {
    let gone = false;
    fetchBridgeStatus()
      .then((s) => !gone && setStatus(s))
      .catch((e) => !gone && setStatusErr((e as Error).message));
    return () => {
      gone = true;
    };
  }, []);

  // ── crossing records + lifecycle poller ───────────────────────────────
  const reloadCrossings = useCallback(async () => {
    const rows = await db.bridgeCrossings.orderBy("createdAt").reverse().toArray();
    setCrossings(rows);
  }, []);

  useEffect(() => {
    void reloadCrossings();
  }, [reloadCrossings]);

  const ethAddr = addresses?.eth as `0x${string}` | undefined;
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      // Recovery (audit H2): adopt any relay-indexed deposit for our eth
      // address that we have no local record of — covers a wrap whose send
      // broadcast but whose tracking row was lost.
      if (ethAddr) {
        try {
          const recent = await fetchRecentDeposit(ethAddr);
          // Only adopt genuinely in-flight deposits (audit N1): never
          // resurrect a failed/cancelled/under_review/refunded mint as a
          // fresh "confirming" zombie.
          if (
            recent &&
            MINT_IN_FLIGHT.has(recent.state) &&
            !(await db.bridgeCrossings.get(recent.txid))
          ) {
            const now = Date.now();
            await db.bridgeCrossings.put({
              id: recent.txid,
              direction: "wrap",
              amountGrains: recent.amountGrains.toString(),
              netGrains: recent.amountGrains.toString(),
              createdAt: recent.createdAt ?? now,
              phase: "confirming",
              relayState: recent.state,
              confirmations: 0,
              settledRef: null,
              approveTxHash: null,
              updatedAt: now,
            });
          }
        } catch {
          // best-effort; recovery retries next tick
        }
      }
      const open = await db.bridgeCrossings
        .where("phase")
        .anyOf("confirming", "relay", "review")
        .toArray();
      for (const c of open) {
        if (stop) return;
        try {
          if (c.direction === "wrap") {
            await pollWrap(c, status?.pearlMinConfirmations ?? 6);
          } else {
            await pollUnwrap(c);
          }
        } catch {
          // transient API failure — next tick retries; relay state is canonical
        }
      }
      if (!stop) await reloadCrossings();
    };
    const t = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [status, reloadCrossings, ethAddr]);

  const openCount = useMemo(
    () => crossings.filter((c) => c.phase === "confirming" || c.phase === "relay" || c.phase === "review").length,
    [crossings],
  );

  return (
    <Page title="Bridge">
      {status?.paused ? (
        <div className="card mb-4 border border-amber-400 bg-amber-50 text-sm dark:bg-amber-950">
          The bridge is currently <span className="font-semibold">paused</span>. Quotes are
          shown but new crossings are disabled until it resumes.
        </div>
      ) : null}
      {statusErr ? (
        <div className="card mb-4 border border-amber-400 text-sm">
          Could not reach the bridge API ({statusErr}). Balances and sends still work;
          bridging needs the API.
        </div>
      ) : null}

      <div className="mb-4 flex gap-2">
        {(["wrap", "unwrap", "activity"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={t === tab ? "btn-primary flex-1" : "btn-secondary flex-1"}
          >
            {t === "wrap" ? "Wrap PRL → WPRL" : t === "unwrap" ? "Unwrap WPRL → PRL" : `Activity${openCount ? ` (${openCount})` : ""}`}
          </button>
        ))}
      </div>

      {tab === "wrap" && (
        <WrapCard
          status={status}
          ethAddress={addresses?.eth as `0x${string}` | undefined}
          pool={pool}
          pearlNetwork={pearlNetwork}
          onStarted={async (rec) => {
            await db.bridgeCrossings.put(rec);
            await reloadCrossings();
            setTab("activity");
          }}
        />
      )}
      {tab === "unwrap" && (
        <UnwrapCard
          status={status}
          ethAddress={addresses?.eth as `0x${string}` | undefined}
          pearlAddress={addresses?.pearl}
          ethNetwork={ethNetwork}
          onStarted={async (rec) => {
            await db.bridgeCrossings.put(rec);
            await reloadCrossings();
            setTab("activity");
          }}
        />
      )}
      {tab === "activity" && (
        <ActivityCard crossings={crossings} requiredConfs={status?.pearlMinConfirmations ?? 6} ethNetwork={ethNetwork} />
      )}

      <button onClick={() => navigate("/dashboard")} className="btn-secondary mt-4 w-full">
        Back to dashboard
      </button>
    </Page>
  );
}

// ── lifecycle pollers (module-level so tests can drive them) ────────────

export async function pollWrap(c: BridgeCrossingRecord, requiredConfs: number): Promise<void> {
  if (c.phase === "confirming") {
    const tx = await fetchPearlTxStatus(c.id);
    const confirmations = tx.found ? tx.confirmations : 0;
    const phase = confirmations >= requiredConfs ? "relay" : "confirming";
    await db.bridgeCrossings.update(c.id, {
      confirmations,
      phase,
      updatedAt: Date.now(),
    });
    if (phase === "confirming") return;
  }
  const m = await fetchMintStatus(c.id);
  const outcome = classifyMint(m.state, m.refunded);
  const patch: Partial<BridgeCrossingRecord> = {
    relayState: m.anomalyReason
      ? `${m.state}: ${m.anomalyReason}`
      : m.cancelReason
      ? `${m.state}: ${m.cancelReason}`
      : m.state,
    updatedAt: Date.now(),
  };
  if (outcome === "ok") {
    patch.phase = "done";
    patch.settledRef = m.mintTxHash;
  } else if (outcome === "refunded") {
    patch.phase = "refunded";
    patch.settledRef = m.refundPrlTxId;
  } else if (outcome === "fail") {
    patch.phase = "failed";
  } else if (outcome === "review") {
    patch.phase = "review";
  }
  // outcome "pending" leaves phase as-is (confirming→relay handled above)
  await db.bridgeCrossings.update(c.id, patch);
}

export async function pollUnwrap(c: BridgeCrossingRecord): Promise<void> {
  const b = await fetchBurnStatus(c.id as `0x${string}`);
  const outcome = classifyBurn(b.state);
  const patch: Partial<BridgeCrossingRecord> = {
    relayState: b.anomalyReason ? `${b.state}: ${b.anomalyReason}` : b.state,
    updatedAt: Date.now(),
  };
  if (outcome === "ok") {
    patch.phase = "done";
    patch.settledRef = b.pearlTxId;
  } else if (outcome === "fail") {
    patch.phase = "failed";
  } else if (outcome === "review") {
    patch.phase = "review";
  } else if (b.state) {
    patch.phase = "relay";
  }
  await db.bridgeCrossings.update(c.id, patch);
}

// ── Wrap ────────────────────────────────────────────────────────────────

function WrapCard(props: {
  status: BridgeStatus | null;
  ethAddress: `0x${string}` | undefined;
  pool: string[];
  pearlNetwork: ReturnType<typeof useWallet.getState>["pearlNetwork"];
  onStarted: (rec: BridgeCrossingRecord) => Promise<void>;
}) {
  const { status, ethAddress, pool, pearlNetwork, onStarted } = props;
  const [amount, setAmount] = useState("");
  // The user's locally-parsed amount — the ONLY trusted source of how much
  // PRL to send. The API quote is advisory (fees/lane); we never send its
  // echoed amount (audit C1).
  const [grains, setGrains] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<MintQuote | null>(null);
  const [depositAddr, setDepositAddr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const quoteSeq = useRef(0);

  // Debounced quote + deposit address preview.
  useEffect(() => {
    setQuote(null);
    setGrains(null);
    setErr(null);
    if (!amount || !ethAddress) return;
    let g: bigint;
    try {
      g = prlToGrains(amount);
      if (g <= 0n) return;
    } catch {
      setErr("Enter a PRL amount (up to 8 decimals).");
      return;
    }
    setGrains(g);
    const seq = ++quoteSeq.current;
    const t = setTimeout(async () => {
      try {
        const [q, dep] = await Promise.all([
          fetchMintQuote(g),
          resolveDepositAddress(ethAddress, depositTofu),
        ]);
        if (quoteSeq.current !== seq) return;
        // Bind the quote to what we asked for. A quote whose amount drifts
        // from the user's input is a hostile/buggy API — surface it, don't
        // silently price a different amount (audit C1).
        if (q.amount !== g) {
          setErr("Quote amount didn’t match your input — try again.");
          return;
        }
        setQuote(q);
        setDepositAddr(dep.address);
      } catch (e) {
        if (quoteSeq.current === seq) setErr((e as Error).message);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [amount, ethAddress]);

  const wrap = async () => {
    if (!quote || !depositAddr || !ethAddress || grains === null || busy) return;
    setBusy(true);
    setErr(null);
    // Capture the trusted amount in a local so nothing async can swap it.
    const sendGrains = grains;
    try {
      // Confirm-time re-checks (audit C1/H2/M2): re-resolve the deposit
      // address through TOFU (refuses if it ever changed) AND re-read the
      // quote to catch a bridge that paused or now disagrees on amount.
      const [dep, q2] = await Promise.all([
        resolveDepositAddress(ethAddress, depositTofu),
        fetchMintQuote(sendGrains),
      ]);
      if (dep.address !== depositAddr) {
        throw new Error("E_DEPOSIT_ADDRESS_CHANGED — refusing to send; retry the quote.");
      }
      if (q2.amount !== sendGrains) {
        throw new Error("E_QUOTE_AMOUNT_MISMATCH — refusing to send; retry the quote.");
      }
      if (q2.paused) {
        throw new Error("The bridge just paused — try again once it resumes.");
      }
      const res = await sendPearl({
        network: pearlNetwork,
        pool,
        destination: depositAddr,
        amountGrains: sendGrains, // user's amount, never the API echo
        includeTip: false,
      });
      const now = Date.now();
      try {
        await onStarted({
          id: res.txid,
          direction: "wrap",
          amountGrains: sendGrains.toString(),
          netGrains: q2.net.toString(),
          createdAt: now,
          phase: "confirming",
          relayState: null,
          confirmations: 0,
          settledRef: null,
          approveTxHash: null,
          updatedAt: now,
        });
      } catch {
        // Funds ARE committed on-chain; only the local record failed. Make
        // the loud version of the error so the user can save the txid
        // (audit H2/M3) — recovery also re-adopts it via /deposits/recent.
        setErr(
          `Sent, but failed to save tracking. SAVE THIS Pearl txid: ${res.txid}`,
        );
        return;
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Wrap PRL into WPRL</h2>
        <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
          Sends PRL from this wallet to your personal bridge deposit address. WPRL mints
          to <span className="font-mono text-xs">{ethAddress ?? "—"}</span> after{" "}
          {status?.pearlMinConfirmations ?? 6} confirmations.
        </p>
      </div>

      <label className="text-sm">
        Amount (PRL)
        <input
          className="input mt-1 w-full"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      {quote && (
        <div className="rounded-xl border border-ink-200 p-3 text-sm dark:border-ink-700">
          <Row k="Bridge fee" v={`${fmtPrl(quote.fee)} (${quote.feeBps} bps)`} />
          <Row k="You receive" v={`${grainsToPrlString(quote.net)} WPRL`} />
          <Row
            k="Lane"
            v={
              quote.lane === "fast"
                ? "fast — mints right after confirmation"
                : `slow — queued ~${Math.round(quote.slowLaneDelaySeconds / 3600)}h (fast window is full)`
            }
          />
          {!quote.withinDailyCap && (
            <p className="mt-2 text-amber-600">
              Amount exceeds today’s remaining bridge capacity — it will queue.
            </p>
          )}
        </div>
      )}

      {depositAddr && (
        <div className="rounded-xl border border-ink-200 p-3 text-xs dark:border-ink-700">
          <div className="mb-1 text-ink-500">PRL will be sent to your bridge deposit address:</div>
          <div className="break-all font-mono">{depositAddr}</div>
          <div className="mt-1 text-ink-500">
            Verify this matches the address shown for your wallet on pearlbridge.xyz before sending.
          </div>
        </div>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}

      <button
        onClick={() => void wrap()}
        disabled={!quote || !depositAddr || busy || status?.paused === true}
        className="btn-primary disabled:opacity-50"
      >
        {busy ? "Sending…" : quote ? `Wrap ${grainsToPrlString(quote.amount)} PRL` : "Wrap"}
      </button>
    </div>
  );
}

// ── Unwrap ──────────────────────────────────────────────────────────────

function UnwrapCard(props: {
  status: BridgeStatus | null;
  ethAddress: `0x${string}` | undefined;
  pearlAddress: string | undefined;
  ethNetwork: ReturnType<typeof useWallet.getState>["ethNetwork"];
  onStarted: (rec: BridgeCrossingRecord) => Promise<void>;
}) {
  const { status, ethAddress, pearlAddress, ethNetwork, onStarted } = props;
  const [amount, setAmount] = useState("");
  const [grains, setGrains] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<BurnQuote | null>(null);
  const [needsApprove, setNeedsApprove] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "approving" | "burning">("idle");
  const quoteSeq = useRef(0);

  useEffect(() => {
    setQuote(null);
    setGrains(null);
    setNeedsApprove(null);
    setErr(null);
    if (!amount || !ethAddress || !pearlAddress) return;
    let g: bigint;
    try {
      g = prlToGrains(amount);
      if (g <= 0n) return;
    } catch {
      setErr("Enter a WPRL amount (up to 8 decimals).");
      return;
    }
    setGrains(g);
    const seq = ++quoteSeq.current;
    const t = setTimeout(async () => {
      try {
        const [q, allowance] = await Promise.all([
          fetchBurnQuote(g, pearlAddress),
          readWprlAllowance(ethNetwork, ethAddress),
        ]);
        if (quoteSeq.current !== seq) return;
        // Pinned-address cross-check: refuse if the API's transaction plan
        // disagrees with the wallet's compiled-in contract addresses.
        const cfg = bridgeConfig(ethNetwork);
        if (
          q.bridgeController.toLowerCase() !== cfg.bridgeController.toLowerCase() ||
          q.wprl.toLowerCase() !== cfg.wprl.toLowerCase()
        ) {
          throw new Error("E_BRIDGE_ADDRESS_MISMATCH — API plan disagrees with wallet constants; refusing.");
        }
        // Bind amount to the user's input (audit H1).
        if (q.amount !== g) {
          throw new Error("Quote amount didn’t match your input — try again.");
        }
        if (q.addressValid === false) {
          throw new Error("Bridge rejected this wallet’s Pearl address — update the app.");
        }
        setQuote(q);
        setNeedsApprove(allowance < g);
      } catch (e) {
        if (quoteSeq.current === seq) setErr((e as Error).message);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [amount, ethAddress, pearlAddress, ethNetwork]);

  const unwrap = async () => {
    if (!quote || !ethAddress || !pearlAddress || grains === null || busy !== "idle") return;
    setErr(null);
    const burnGrains = grains; // user's amount, never the API echo (audit H1)
    let approveTxHash: `0x${string}` | null = null;
    try {
      // Confirm-time re-quote: bind amount, re-check paused + pinned
      // addresses, and RE-READ allowance just before signing (audit
      // H1/M2/N2 — needsApprove from preview can be stale).
      const [q2, allowance] = await Promise.all([
        fetchBurnQuote(burnGrains, pearlAddress),
        readWprlAllowance(ethNetwork, ethAddress),
      ]);
      const cfg = bridgeConfig(ethNetwork);
      if (
        q2.bridgeController.toLowerCase() !== cfg.bridgeController.toLowerCase() ||
        q2.wprl.toLowerCase() !== cfg.wprl.toLowerCase()
      ) {
        throw new Error("E_BRIDGE_ADDRESS_MISMATCH — refusing to sign.");
      }
      if (q2.amount !== burnGrains) {
        throw new Error("E_QUOTE_AMOUNT_MISMATCH — refusing to sign.");
      }
      if (q2.paused) {
        throw new Error("The bridge just paused — try again once it resumes.");
      }
      if (allowance < burnGrains) {
        setBusy("approving");
        // Exact-amount approval (not infinite): allowance dies with this
        // burn, so a future contract compromise can't drain pre-approved
        // WPRL. Burn re-reads pending nonce so it sequences after approve.
        const a = await approveWprlForBridge({
          network: ethNetwork,
          from: ethAddress,
          amount: burnGrains,
          tier: "normal",
        });
        approveTxHash = a.txHash;
      }
      setBusy("burning");
      const r = await requestBurn({
        network: ethNetwork,
        from: ethAddress,
        amount: burnGrains,
        pearlAddress,
        tier: "normal",
      });
      const now = Date.now();
      try {
        await onStarted({
          id: r.txHash,
          direction: "unwrap",
          amountGrains: burnGrains.toString(),
          netGrains: q2.net.toString(),
          createdAt: now,
          phase: "relay",
          relayState: null,
          confirmations: 0,
          settledRef: null,
          approveTxHash,
          updatedAt: now,
        });
      } catch {
        // Burn is on-chain; only the local record failed (audit H2/M3).
        setErr(`Burn submitted, but failed to save tracking. SAVE THIS burn tx: ${r.txHash}`);
        return;
      }
    } catch (e) {
      // Distinguish post-broadcast failures so the user knows funds moved
      // (audit M3): if the approve already landed and the burn threw, say
      // so explicitly.
      const msg = (e as Error).message;
      if (approveTxHash) {
        setErr(`Approve landed (${approveTxHash}) but burn failed: ${msg}. Re-try Unwrap — no re-approve needed.`);
      } else {
        setErr(msg);
      }
    } finally {
      setBusy("idle");
    }
  };

  return (
    <div className="card flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Unwrap WPRL back to PRL</h2>
        <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
          Burns WPRL from <span className="font-mono text-xs">{ethAddress ?? "—"}</span>;
          the bridge pays native PRL to this wallet’s Pearl address. Needs a little ETH
          for gas{needsApprove ? " (two transactions: approve, then burn)" : ""}.
        </p>
      </div>

      <label className="text-sm">
        Amount (WPRL)
        <input
          className="input mt-1 w-full"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      {quote && (
        <div className="rounded-xl border border-ink-200 p-3 text-sm dark:border-ink-700">
          <Row k="Bridge fee" v={`${fmtPrl(quote.fee)} (${quote.feeBps} bps)`} />
          <Row k="You receive" v={fmtPrl(quote.net)} />
          <Row k="Payout to" v={pearlAddress ? `${pearlAddress.slice(0, 14)}…${pearlAddress.slice(-8)}` : "—"} />
          {needsApprove && <Row k="Step 1" v="approve WPRL (exact amount)" />}
          <Row k={needsApprove ? "Step 2" : "Transaction"} v="requestBurn on PearlBridge" />
          {!quote.withinDailyCap && (
            <p className="mt-2 text-amber-600">
              Amount exceeds today’s remaining burn capacity.
            </p>
          )}
        </div>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}

      <button
        onClick={() => void unwrap()}
        disabled={!quote || busy !== "idle" || status?.paused === true}
        className="btn-primary disabled:opacity-50"
      >
        {busy === "approving"
          ? "Approving…"
          : busy === "burning"
          ? "Burning…"
          : quote
          ? `Unwrap ${grainsToPrlString(quote.amount)} WPRL`
          : "Unwrap"}
      </button>
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────

function ActivityCard(props: {
  crossings: BridgeCrossingRecord[];
  requiredConfs: number;
  ethNetwork: ReturnType<typeof useWallet.getState>["ethNetwork"];
}) {
  const { crossings, requiredConfs, ethNetwork } = props;
  if (!crossings.length) {
    return (
      <div className="card text-sm text-ink-600 dark:text-ink-400">
        No bridge activity yet. Wraps and unwraps you start here keep tracking even if
        you close the app — the bridge finishes them on-chain.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {crossings.map((c) => (
        <div key={c.id} className="card text-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold">
              {c.direction === "wrap" ? "PRL → WPRL" : "WPRL → PRL"}{" "}
              {grainsToPrlString(BigInt(c.amountGrains))}
            </span>
            <PhaseBadge phase={c.phase} />
          </div>
          <div className="mt-2 space-y-1 text-xs text-ink-600 dark:text-ink-400">
            {c.direction === "wrap" && c.phase === "confirming" && (
              <div>
                Confirming on Pearl: {c.confirmations}/{requiredConfs}
              </div>
            )}
            {c.phase === "relay" && (
              <div>Bridge processing{c.relayState ? ` — ${c.relayState}` : "…"}</div>
            )}
            {c.phase === "review" && (
              <div className="text-amber-600">
                Under review by the bridge{c.relayState ? ` — ${c.relayState}` : ""}. This
                resolves automatically (mint) or is refunded to your Pearl address.
              </div>
            )}
            {c.phase === "refunded" && (
              <div className="text-amber-700">
                Refunded on Pearl{c.settledRef ? "" : " — payout pending"}.
              </div>
            )}
            {c.phase === "failed" && (
              <div className="text-red-600">
                {c.relayState ?? "failed"} — funds are recoverable; contact the bridge
                via pearlbridge.xyz support if this persists.
              </div>
            )}
            <div className="break-all">
              {c.direction === "wrap" ? "Pearl tx: " : "Burn tx: "}
              <span className="font-mono">{c.id}</span>
            </div>
            {c.settledRef && (
              <div className="break-all">
                {c.direction === "wrap" ? (
                  <a
                    className="text-pearl-700 underline dark:text-pearl-300"
                    href={ethTxExplorerUrl(ethNetwork, c.settledRef)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WPRL mint tx ↗
                  </a>
                ) : (
                  <>Pearl payout: <span className="font-mono">{c.settledRef}</span></>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: BridgeCrossingRecord["phase"] }) {
  const cls =
    phase === "done"
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      : phase === "failed"
      ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
      : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200";
  const label =
    phase === "confirming"
      ? "confirming"
      : phase === "relay"
      ? "bridging"
      : phase === "review"
      ? "under review"
      : phase;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-ink-500">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}
