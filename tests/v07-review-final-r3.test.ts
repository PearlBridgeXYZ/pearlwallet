// Final review, round 3 — one group per finding fixed here. S1 (keystore
// writes) lives in v07-keystore-atomic.test.ts, S8 (crypto worker errors)
// in v07-worker-client.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as rpc from "../src/services/pearl-rpc";
import * as ethTx from "../src/services/eth-tx";
import * as bridgeV1 from "../src/services/bridge-v1";
import * as workerClient from "../src/crypto/worker-client";
import { bridgeConfig } from "../src/services/bridge";
import { broadcastConsolidationBatch, composeConsolidation } from "../src/services/pearl-consolidate";
import { broadcastRecorded, PEARL_PREVIEW_FRESHNESS_MS, SIGN_TIMEOUT_MS } from "../src/services/pearl-tx";
import { broadcastRecordIssue, broadcastRecords, withBroadcastLock } from "../src/services/pending-spends";
import { checkBroadcast } from "../src/services/broadcast-status";
import {
  createUnwrapFlow,
  prepareWrapReview,
  QUOTE_CHANGED_MESSAGE,
  quoteChanged,
  UNWRAP_IN_FLIGHT_NOTICE,
  type UnwrapBusy,
  type UnwrapView,
} from "../src/ui/pages/bridge-flows";
import { rec, seedRecords, useFakeLocks, useMemoryStorage } from "./helpers/broadcast-env";

const src = (f: string) => readFileSync(f, "utf8");
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useMemoryStorage();
  useFakeLocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── S2 ──────────────────────────────────────────────────────────────────

describe("S2 — consolidation re-checks the preview's age at signing", () => {
  const batch = () =>
    composeConsolidation({
      utxos: [0, 1].map((i) => ({
        txid: String(i + 1).repeat(64),
        vout: 0,
        valueGrains: 10_000_000n,
        scriptHex: "5120" + "00".repeat(32),
        branch: 0 as const,
        index: 0,
      })),
      destination: { address: "prl1pown", branch: 0, index: 0 },
    }).batches[0]!;

  it("a preview that expires while waiting for the broadcast lock is refused, nothing signed or sent", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const b = batch();
    const gate = deferred();
    const held = withBroadcastLock(() => gate.promise); // another broadcast holds the lock
    const sign = vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "synthetic" } as never);
    vi.spyOn(rpc, "rawTxId").mockReturnValue("ab".repeat(32));
    const submit = vi.spyOn(rpc, "broadcastPearlTx").mockResolvedValue("ab".repeat(32));
    const verifiedAt = now - PEARL_PREVIEW_FRESHNESS_MS + 1; // fresh on the click
    const pending = broadcastConsolidationBatch({ batch: b, verifiedAt }, "mainnet");
    now += 2000; // stale by the time the lock is granted
    gate.resolve();
    await held;
    await expect(pending).rejects.toThrow("E_PREVIEW_STALE");
    expect(sign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(broadcastRecords()).toHaveLength(0);
  });

  it("a preview still fresh at signing goes out", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sign = vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "synthetic" } as never);
    vi.spyOn(rpc, "rawTxId").mockReturnValue("ab".repeat(32));
    const submit = vi.spyOn(rpc, "broadcastPearlTx").mockResolvedValue("ab".repeat(32));
    await broadcastConsolidationBatch({ batch: batch(), verifiedAt: now - 1000 }, "mainnet");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

// ─── S3 / S4 / S5 (unwrap) ───────────────────────────────────────────────

const ME = "0x1111111111111111111111111111111111111111" as const;
const AMOUNT = 100n * 100_000_000n;
const cfg = bridgeConfig("mainnet");
const burnQuote: bridgeV1.BurnQuote = {
  amount: AMOUNT,
  feeBps: 10,
  fee: AMOUNT / 1000n,
  net: AMOUNT - AMOUNT / 1000n,
  withinDailyCap: true,
  paused: false,
  addressValid: true,
  bridgeController: cfg.bridgeController,
  wprl: cfg.wprl,
};
function view() {
  const busy: UnwrapBusy[] = [];
  const v = {
    busy,
    err: null as string | null,
    notice: null as string | null,
    quote: null as bridgeV1.BurnQuote | null,
    started: 0,
    setBusy: (b: UnwrapBusy) => void busy.push(b),
    setErr: (m: string | null) => void (v.err = m),
    setNotice: (m: string | null) => void (v.notice = m),
    setGas: () => {},
    setNeedsApprove: () => {},
    setQuote: (q: bridgeV1.BurnQuote) => void (v.quote = q),
    onPrepared: async () => {}, onStarted: async () => void v.started++,
  };
  return v satisfies UnwrapView & Record<string, unknown>;
}
function chain(opts: { allowance: bigint; fresh?: bridgeV1.BurnQuote; quoteDelay?: Promise<unknown>; wait?: () => Promise<boolean> }) {
  vi.spyOn(bridgeV1, "fetchBurnQuote").mockImplementation(async () => {
    await opts.quoteDelay;
    return opts.fresh ?? burnQuote;
  });
  vi.spyOn(ethTx, "readWprlAllowance").mockResolvedValue(opts.allowance);
  vi.spyOn(ethTx, "readWprlBalanceOf").mockResolvedValue(AMOUNT);
  const approve = vi.spyOn(ethTx, "approveWprlForBridge").mockResolvedValue({ txHash: "0xa11", composed: {} } as never);
  vi.spyOn(ethTx, "waitForEthSuccess").mockImplementation(opts.wait ?? (async () => true));
  vi.spyOn(ethTx, "previewUnwrapGas").mockResolvedValue({ maxFeePerGas: 7n, approveWei: null, burnWei: 700_000n });
  const burn = vi.spyOn(ethTx, "requestBurn").mockResolvedValue({ txHash: "0xb0", composed: {} } as never);
  return { approve, burn };
}
const input = (gas: ethTx.UnwrapGasPreview = { maxFeePerGas: 7n, approveWei: null, burnWei: 700_000n }) => ({
  network: "mainnet" as const,
  ethAddress: ME,
  pearlAddress: "prl1pme",
  amount: AMOUNT,
  quote: burnQuote,
  gas,
});

describe("S3 — one unwrap per page load, not per card", () => {
  it("a remounted card (a new flow) can't start a second burn while the first runs", async () => {
    const gate = deferred();
    const { burn } = chain({ allowance: AMOUNT, quoteDelay: gate.promise });
    const first = createUnwrapFlow()(input(), view());
    // The user switched tabs and back: a new card, a new flow, a new click.
    const v2 = view();
    await createUnwrapFlow()(input(), v2);
    expect(v2.notice).toBe(UNWRAP_IN_FLIGHT_NOTICE);
    expect(v2.busy).toEqual([]); // the refused card never claimed anything
    gate.resolve();
    await first;
    expect(burn).toHaveBeenCalledTimes(1);
    // Released afterwards: the remounted card's next click runs.
    await createUnwrapFlow()(input(), view());
    expect(burn).toHaveBeenCalledTimes(2);
  });
});

describe("S4 — the sign-time re-quote must match what was reviewed", () => {
  it("quoteChanged sees fee, rate, amount received, lane and daily-cap drift", () => {
    const base = { fee: 10n, feeBps: 10, net: 990n, withinDailyCap: true, lane: "fast" as const };
    expect(quoteChanged(base, { ...base })).toBe(false);
    expect(quoteChanged(base, { ...base, fee: 11n })).toBe(true);
    expect(quoteChanged(base, { ...base, feeBps: 11 })).toBe(true);
    expect(quoteChanged(base, { ...base, net: 989n })).toBe(true);
    expect(quoteChanged(base, { ...base, withinDailyCap: false })).toBe(true);
    expect(quoteChanged(base, { ...base, lane: "slow" })).toBe(true);
  });

  it("unwrap: a higher fee at signing refuses before any approve or burn, and shows the new quote", async () => {
    const fresh = { ...burnQuote, fee: burnQuote.fee * 5n, net: AMOUNT - burnQuote.fee * 5n, feeBps: 50 };
    const { approve, burn } = chain({ allowance: 0n, fresh });
    const v = view();
    await createUnwrapFlow()(input({ maxFeePerGas: 9n, approveWei: 450_000n, burnWei: null }), v);
    expect(approve).not.toHaveBeenCalled();
    expect(burn).not.toHaveBeenCalled();
    expect(v.quote).toEqual(fresh);
    expect(v.err).toBe(QUOTE_CHANGED_MESSAGE);
  });

  it("wrap: the review shows the quote re-read before composing", async () => {
    const PRL = 100n * 100_000_000n;
    const live = { amount: PRL, feeBps: 10, fee: PRL / 1000n, net: PRL - PRL / 1000n, lane: "fast" as const, slowLaneDelaySeconds: 0, withinDailyCap: true, confirmationsRequired: 6, paused: false };
    const reread = { ...live, lane: "slow" as const, slowLaneDelaySeconds: 7200 };
    const r = await prepareWrapReview({
      quote: live,
      deposit: "prl1pdeposit",
      stale: () => false,
      recheck: async () => reread,
      compose: async (d, a) => ({
        utxos: [],
        outputs: [{ address: d, amountGrains: a }],
        amountGrains: a,
        feeGrains: 1n,
        tipGrains: 0n,
        changeGrains: 0n,
        degraded: false,
        historyIncomplete: 0,
        spendableGrains: a + 1n,
        spendableUtxoCount: 1,
      }),
    });
    expect(r!.quote).toEqual(reread);
  });

  it("Bridge.tsx: wrap compares the sign-time quote with the review before broadcasting; unwrap passes the reviewed quote", () => {
    const page = src("src/ui/pages/Bridge.tsx");
    const check = page.indexOf("if (quoteChanged(review.quote, q2)) {");
    expect(check).toBeGreaterThan(0);
    // (R6 N2: the call now also passes the signing session of the click.)
    const call = page.indexOf("await broadcastPearlPrecomposed(frozen, pearlNetwork, Date.now(), [], session)");
    expect(call).toBeGreaterThan(0);
    expect(check).toBeLessThan(call);
    expect(page).toMatch(/amount: grains, quote, gas \}/);
    expect(page).toMatch(/setNeedsApprove, setQuote, onStarted, onPrepared \}/);
  });
});

describe("S5 — 'Approve confirmed' only after the approve's successful receipt", () => {
  it("a timed-out wait says the approve is unconfirmed and not to retry yet", async () => {
    const { burn } = chain({
      allowance: 0n,
      wait: async () => {
        throw new Error("timed out after 180s");
      },
    });
    const v = view();
    await createUnwrapFlow()(input({ maxFeePerGas: 9n, approveWei: 450_000n, burnWei: null }), v);
    expect(burn).not.toHaveBeenCalled();
    expect(v.err).not.toMatch(/Approve confirmed|skip the approve/);
    expect(v.err).toMatch(/0xa11 was sent but its confirmation wasn't seen/);
    expect(v.err).toMatch(/wait for it to confirm before trying again/);
  });

  it("a reverted approve says reverted, not confirmed", async () => {
    chain({ allowance: 0n, wait: async () => false });
    const v = view();
    await createUnwrapFlow()(input({ maxFeePerGas: 9n, approveWei: 450_000n, burnWei: 400_000n }), v);
    expect(v.err).toBe("Approve tx 0xa11 reverted — nothing burned. Try again.");
  });

  it("a confirmed approve followed by a failed burn still says it will skip the approve", async () => {
    const { burn } = chain({ allowance: 0n });
    burn.mockRejectedValueOnce(new Error("E_ETH_GAS_ABOVE_REVIEW"));
    const v = view();
    await createUnwrapFlow()(input({ maxFeePerGas: 9n, approveWei: 450_000n, burnWei: 400_000n }), v);
    expect(v.err).toMatch(/^Approve confirmed \(0xa11\).*it will skip the approve\.$/);
  });
});

// ─── S6 ──────────────────────────────────────────────────────────────────

describe("S6 — a status check whose result can't be saved says so", () => {
  it("found but not persisted → 'unsaved', the record unchanged and the banner shows the issue", async () => {
    const storage = useMemoryStorage();
    const id = "ab".repeat(32);
    seedRecords([rec({ txid: id, inputs: ["cd".repeat(32) + ":0"] })]);
    vi.spyOn(rpc, "probePearlTx").mockResolvedValue("found");
    storage.failWrites = true;
    expect(await checkBroadcast(id)).toBe("unsaved");
    expect(broadcastRecords()[0]?.state).toBe("unknown");
    expect(broadcastRecordIssue()).toBe("update-failed");
  });

  it("found and persisted → 'found', no issue", async () => {
    const id = "ab".repeat(32);
    seedRecords([rec({ txid: id, inputs: ["cd".repeat(32) + ":0"] })]);
    vi.spyOn(rpc, "probePearlTx").mockResolvedValue("found");
    expect(await checkBroadcast(id)).toBe("found");
    expect(broadcastRecords()[0]?.state).toBe("accepted");
    expect(broadcastRecordIssue()).toBeNull();
  });

  it("the banner row shows no 'resolved' note for an unsaved result", () => {
    const ui = src("src/ui/components/PendingBroadcasts.tsx");
    expect(ui).toMatch(/if \(r === "unsaved"\) \{/);
    // resolvedNote only speaks for found / spent.
    expect(ui).toMatch(/function resolvedNote[\s\S]+?if \(r === "found"\)[\s\S]+?if \(r === "spent"\)[\s\S]+?return null;\n\}/);
  });
});

// ─── S8 (lock side) ──────────────────────────────────────────────────────

describe("S8 — a signer that never returns can't pin the broadcast lock", () => {
  it("broadcastRecorded gives up after SIGN_TIMEOUT_MS: nothing recorded or sent, lock free", async () => {
    vi.useFakeTimers();
    const submit = vi.spyOn(rpc, "broadcastPearlTx").mockResolvedValue("ab".repeat(32));
    const pending = broadcastRecorded(
      { kind: "payment", inputs: [{ txid: "cd".repeat(32), vout: 0 }], addresses: [], destination: null, amountGrains: null },
      () => new Promise<string>(() => {}), // a hung worker
    );
    const settled = expect(pending).rejects.toThrow("E_SIGN_TIMEOUT");
    await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS + 1);
    await settled;
    vi.useRealTimers();
    expect(submit).not.toHaveBeenCalled();
    expect(broadcastRecords()).toHaveLength(0);
    await expect(withBroadcastLock(async () => "free")).resolves.toBe("free");
  });
});

describe('v0.7.1 prepared burn state',()=>{
 it('persists intent without navigating, then records a definite submission failure',async()=>{
  const {burn}=chain({allowance:AMOUNT});
  const v=view(), prepared:unknown[]=[], started:unknown[]=[];
  const callbacks:UnwrapView={...v,onPrepared:async r=>{prepared.push(r);expect(started).toEqual([]);},onStarted:async r=>{started.push(r);}};
  burn.mockImplementation(async p=>{await p.beforeBroadcast!('0x'+'ab'.repeat(32) as `0x${string}`);throw new Error('journal unavailable');});
  await createUnwrapFlow()(input(),callbacks);
  expect(prepared).toHaveLength(1);expect(prepared[0]).toMatchObject({phase:'prepared'});
  expect(started).toHaveLength(1);expect(started[0]).toMatchObject({phase:'failed',relayState:'Burn not submitted or rejected: journal unavailable'});
 });
 it('retains uncertain intent without falsely labeling it bridge review',async()=>{
  const {burn}=chain({allowance:AMOUNT});const v=view(),prepared:unknown[]=[],started:unknown[]=[];
  const hash='0x'+'ab'.repeat(32) as `0x${string}`;
  burn.mockImplementation(async p=>{await p.beforeBroadcast!(hash);throw new ethTx.EthBroadcastStatusUnknownError(hash,new Error('504'));});
  await createUnwrapFlow()(input(),{...v,onPrepared:async r=>{prepared.push(r);},onStarted:async r=>{started.push(r);}});
  expect(prepared[0]).toMatchObject({phase:'prepared'});expect(started).toEqual([]);expect(v.err).toContain(hash);
 });
});
