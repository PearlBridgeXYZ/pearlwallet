// Final review, round 2 — one group per finding fixed here. S1 and S10
// (broadcast status) live in v07-pending-spends.test.ts / v07-review-final
// .test.ts; S7 (CSP) in v018.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as ethTx from "../src/services/eth-tx";
import * as bridgeV1 from "../src/services/bridge-v1";
import * as pearlRpc from "../src/services/pearl-rpc";
import * as workerClient from "../src/crypto/worker-client";
import { bridgeConfig } from "../src/services/bridge";
import { broadcastPearlPrecomposed, PEARL_PREVIEW_FRESHNESS_MS, type ComposedPearlTx } from "../src/services/pearl-tx";
import { withBroadcastLock } from "../src/services/pending-spends";
import {
  BURN_REVIEW_NOTICE,
  createUnwrapFlow,
  prepareWrapReview,
  wrapReviewSignable,
  type UnwrapBusy,
  type UnwrapView,
} from "../src/ui/pages/bridge-flows";
import { offlineAmountGrains } from "../src/ui/pages/OfflineSign";
import { CLIPBOARD_CLEAR_MS, copyWithAutoClear } from "../src/lib/clipboard";
import { useFakeLocks, useMemoryStorage } from "./helpers/broadcast-env";

const src = (f: string) => readFileSync(f, "utf8");
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DEPOSIT = "prl1pdeposit";
function composed(amount: bigint, to = DEPOSIT): ComposedPearlTx {
  return {
    utxos: [{ txid: "aa".repeat(32), vout: 0, valueGrains: amount + 10_000n, scriptHex: "5120" + "00".repeat(32), branch: 0, index: 0 }],
    outputs: [{ address: to, amountGrains: amount }],
    amountGrains: amount,
    feeGrains: 10_000n,
    tipGrains: 0n,
    changeGrains: 0n,
    degraded: false,
    historyIncomplete: 0,
    spendableGrains: amount + 10_000n,
    spendableUtxoCount: 1,
  };
}
const mintQuote = (amount: bigint): bridgeV1.MintQuote => ({
  amount,
  feeBps: 50,
  fee: amount / 200n,
  net: amount - amount / 200n,
  lane: "fast",
  slowLaneDelaySeconds: 0,
  withinDailyCap: true,
  confirmationsRequired: 6,
  paused: false,
});

// ─── S2 ──────────────────────────────────────────────────────────────────

describe("S2 — a wrap review can't mix two amounts", () => {
  it("an amount change while the review is composed discards it", async () => {
    const PRL = 100n * 100_000_000n;
    let seq = 1;
    const compose = deferred<ComposedPearlTx>();
    const pending = prepareWrapReview({
      quote: mintQuote(PRL),
      deposit: DEPOSIT,
      stale: () => seq !== 1,
      recheck: async () => mintQuote(PRL),
      compose: () => compose.promise,
    });
    await flush();
    seq = 2; // the user typed "1" while the 100 PRL send was being composed
    compose.resolve(composed(PRL));
    await expect(pending).resolves.toBeNull();
  });

  it("the review is one object: its quote, deposit and transaction agree, or Sign stays off", async () => {
    const PRL = 100n * 100_000_000n;
    const r = await prepareWrapReview({
      quote: mintQuote(PRL),
      deposit: DEPOSIT,
      stale: () => false,
      recheck: async () => mintQuote(PRL),
      compose: async (d, a) => composed(a, d),
    });
    expect(wrapReviewSignable(r)).toBe(true);
    expect(r!.quote.amount).toBe(r!.frozen.composed.amountGrains);
    expect(wrapReviewSignable({ ...r!, quote: mintQuote(100_000_000n) })).toBe(false); // the 1-PRL quote
    expect(wrapReviewSignable({ ...r!, deposit: "prl1pother" })).toBe(false);
    expect(wrapReviewSignable(null)).toBe(false);
    // A composition that pays elsewhere is refused outright.
    await expect(
      prepareWrapReview({
        quote: mintQuote(PRL),
        deposit: DEPOSIT,
        stale: () => false,
        recheck: async () => mintQuote(PRL),
        compose: async (_d, a) => composed(a, "prl1pother"),
      }),
    ).rejects.toThrow("E_COMPOSE_MISMATCH");
  });

  it("Bridge.tsx renders and signs from the review object, locks the amount while reviewing, and bumps quoteSeq on every edit", () => {
    const page = src("src/ui/pages/Bridge.tsx");
    expect(page).toMatch(/useEffect\(\(\) => \{\n\s+const seq = \+\+quoteSeq\.current;/);
    expect(page).toMatch(/disabled=\{busy \|\| review !== null\}/);
    expect(page).toMatch(/const shown = review\?\.quote \?\? quote;/);
    expect(page).toMatch(/disabled=\{!trustAcknowledged \|\| !wrapReviewSignable\(review\) \|\| busy/);
    expect(page).toMatch(/const \{ frozen, deposit \} = review;/);
  });
});

// ─── S3 / S4 ─────────────────────────────────────────────────────────────

const ME = "0x1111111111111111111111111111111111111111" as const;
const AMOUNT = 100n * 100_000_000n;
const cfg = bridgeConfig("mainnet");
const burnQuote: bridgeV1.BurnQuote = {
  amount: AMOUNT,
  feeBps: 0,
  fee: 0n,
  net: AMOUNT,
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
    gas: null as ethTx.UnwrapGasPreview | null,
    started: 0,
    setBusy: (b: UnwrapBusy) => void busy.push(b),
    setErr: (m: string | null) => void (v.err = m),
    setNotice: (m: string | null) => void (v.notice = m),
    setGas: (g: ethTx.UnwrapGasPreview) => void (v.gas = g),
    setNeedsApprove: () => {},
    setQuote: () => {},
    onPrepared: async () => {}, onStarted: async () => void v.started++,
  };
  return v satisfies UnwrapView & Record<string, unknown>;
}
function chain(opts: { allowance: bigint; quoteDelay?: Promise<unknown> }) {
  let allowance = opts.allowance;
  vi.spyOn(bridgeV1, "fetchBurnQuote").mockImplementation(async () => {
    await opts.quoteDelay;
    return burnQuote;
  });
  vi.spyOn(ethTx, "readWprlAllowance").mockImplementation(async () => allowance);
  vi.spyOn(ethTx, "readWprlBalanceOf").mockResolvedValue(AMOUNT);
  const approve = vi.spyOn(ethTx, "approveWprlForBridge").mockImplementation(async () => {
    allowance = AMOUNT;
    return { txHash: "0xa11", composed: {} } as never;
  });
  vi.spyOn(ethTx, "waitForEthSuccess").mockResolvedValue(true);
  const preview = vi.spyOn(ethTx, "previewUnwrapGas").mockResolvedValue({ maxFeePerGas: 7n, approveWei: null, burnWei: 700_000n });
  const burn = vi.spyOn(ethTx, "requestBurn").mockResolvedValue({ txHash: "0xb0", composed: {} } as never);
  return { approve, preview, burn };
}

describe("S3 — a double click on Unwrap starts one burn", () => {
  it("a second call during the delayed pre-checks does nothing", async () => {
    const gate = deferred<void>();
    const { burn } = chain({ allowance: AMOUNT, quoteDelay: gate.promise });
    const unwrap = createUnwrapFlow();
    const v = view();
    const input = { network: "mainnet" as const, ethAddress: ME, pearlAddress: "prl1pme", amount: AMOUNT, quote: burnQuote, gas: { maxFeePerGas: 7n, approveWei: null, burnWei: 700_000n } };
    const first = unwrap(input, v);
    expect(v.busy).toEqual(["checking"]); // set before the first await: the button is already off
    const second = unwrap(input, v);
    gate.resolve();
    await Promise.all([first, second]);
    expect(burn).toHaveBeenCalledTimes(1);
    expect(v.started).toBe(1);
    expect(v.busy.at(-1)).toBe("idle");
    // Released afterwards: a later click runs again.
    await unwrap(input, v);
    expect(burn).toHaveBeenCalledTimes(2);
  });

  it("Bridge.tsx uses the flow and disables the button while it runs", () => {
    const page = src("src/ui/pages/Bridge.tsx");
    expect(page).toMatch(/const unwrapFlow = useMemo\(\(\) => createUnwrapFlow\(\), \[\]\);/);
    expect(page).toMatch(/disabled=\{!quote \|\| !gas \|\| busy !== "idle"/);
  });
});

describe("S4 — approve-first unwrap: the burn is signed only against a total gas ceiling the user saw", () => {
  it("first click approves and shows the burn's gas; the second click signs it against that number", async () => {
    const { approve, preview, burn } = chain({ allowance: 0n });
    const unwrap = createUnwrapFlow();
    const v = view();
    const reviewed = { maxFeePerGas: 9n, approveWei: 450_000n, burnWei: null };
    await unwrap({ network: "mainnet", ethAddress: ME, pearlAddress: "prl1pme", amount: AMOUNT, quote: burnQuote, gas: reviewed }, v);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ ceiling: { maxFeePerGas: 9n, maxCostWei: 450_000n } }));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ needsApprove: false }));
    expect(burn).not.toHaveBeenCalled();
    expect(v.notice).toBe(BURN_REVIEW_NOTICE);
    expect(v.gas).toEqual({ maxFeePerGas: 7n, approveWei: null, burnWei: 700_000n });
    expect(v.err).toBeNull();

    // Second click, with the gas now on screen.
    await unwrap({ network: "mainnet", ethAddress: ME, pearlAddress: "prl1pme", amount: AMOUNT, quote: burnQuote, gas: v.gas! }, v);
    expect(approve).toHaveBeenCalledTimes(1); // allowance now set: no second approve
    expect(burn).toHaveBeenCalledTimes(1);
    expect(burn).toHaveBeenCalledWith(expect.objectContaining({ ceiling: { maxFeePerGas: 7n, maxCostWei: 700_000n } }));
  });

  it("the ceiling's total is a number in the type: no signing call can omit it", () => {
    const eth = src("src/services/eth-tx.ts");
    expect(eth).toMatch(/maxCostWei: bigint;/);
    expect(eth).toMatch(/ceiling: EthGasCeiling;/);
    expect(eth).not.toMatch(/maxCostWei !== null/);
  });
});

// ─── S5 ──────────────────────────────────────────────────────────────────

describe("S5 — the README (linked as 'View source') matches the app's own claims", () => {
  const readme = src("README.md");
  it("drops stale or false claims", () => {
    for (const stale of [
      /v0\.1\.18/,
      /286 tests/,
      /27 (public )?audit reports/,
      /no network fetches/i,
      /data URI/i,
      /operator cannot see/i,
      /own Pearl node/i,
      /No minified blobs/i,
      /Reproducible build/i,
      /bundle hashes/i,
      /licensed under MIT/i,
    ]) {
      expect(readme, String(stale)).not.toMatch(stale);
    }
  });
  it("states what the RPC services see and that the reviews are AI-assisted", () => {
    expect(readme).toMatch(/can see your IP address and the wallet addresses you query/);
    expect(readme).toMatch(/AI-assisted, multi-model reviews/);
    expect(readme).toMatch(/No paid third-party audit/);
    expect(readme).toMatch(/\*\*BTX:\*\*/);
  });
});

// ─── S6 ──────────────────────────────────────────────────────────────────

describe("S6 — the preview's age is checked again under the lock, just before signing", () => {
  it("a preview that expires while waiting for another tab's broadcast is not signed", async () => {
    useMemoryStorage();
    useFakeLocks();
    const sign = vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "rawhex" } as never);
    vi.spyOn(pearlRpc, "rawTxId").mockReturnValue("ab".repeat(32));
    const submit = vi.spyOn(pearlRpc, "broadcastPearlTx").mockResolvedValue("ab".repeat(32));
    const other = deferred<void>();
    const holder = withBroadcastLock(() => other.promise); // another tab mid-broadcast
    await flush();
    const composedAt = Date.now() - PEARL_PREVIEW_FRESHNESS_MS + 30; // fresh on the click
    const send = broadcastPearlPrecomposed({ composed: composed(1_000_000n, "prl1pdest"), composedAt }, "mainnet");
    await new Promise((r) => setTimeout(r, 60)); // the wait outlives the preview
    other.resolve();
    await holder;
    await expect(send).rejects.toThrow("E_PREVIEW_STALE");
    expect(sign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

// ─── S8 ──────────────────────────────────────────────────────────────────

describe("S8 — the offline composer parses amounts like every other field", () => {
  it("a minus sign or a 9th decimal is invalid, not dropped or truncated", () => {
    expect(offlineAmountGrains("-0.5")).toBeNull();
    expect(offlineAmountGrains("-1")).toBeNull();
    expect(offlineAmountGrains("1.123456789")).toBeNull();
    expect(offlineAmountGrains("abc")).toBeNull();
    expect(offlineAmountGrains("")).toBeNull();
    expect(offlineAmountGrains("1.5")).toBe(150_000_000n);
    expect(offlineAmountGrains(" 0.00000001 ")).toBe(1n);
  });
});

// ─── S9 ──────────────────────────────────────────────────────────────────

describe("S9 — the 60-second clipboard clear survives leaving the screen", () => {
  function clipboard(initial = "") {
    const c = { text: initial, writeText: vi.fn(async (t: string) => void (c.text = t)), readText: vi.fn(async () => c.text) };
    vi.stubGlobal("navigator", { clipboard: c });
    return c;
  }

  it("clears the copied address after 60 s; leaves a clipboard holding something else; a later copy governs", async () => {
    vi.useFakeTimers();
    const c = clipboard();
    await copyWithAutoClear("prl1paddr");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS - 1);
    expect(c.text).toBe("prl1paddr");
    await vi.advanceTimersByTimeAsync(1);
    expect(c.text).toBe("");

    await copyWithAutoClear("prl1paddr");
    c.text = "something else";
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(c.text).toBe("something else");

    await copyWithAutoClear("prl1pfirst");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS / 2);
    await copyWithAutoClear("prl1psecond");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS / 2);
    expect(c.text).toBe("prl1psecond"); // the first window no longer applies
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS / 2);
    expect(c.text).toBe("");
  });

  it("the copy buttons use it and no unmount cleanup cancels it", () => {
    for (const f of ["src/ui/components/CopyAddress.tsx", "src/ui/pages/Receive.tsx"]) {
      const s = src(f);
      expect(s, f).toMatch(/copyWithAutoClear\(/);
      expect(s, f).not.toMatch(/clipboardClearTimerRef/);
    }
  });
});
