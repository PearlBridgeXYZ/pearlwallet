// v0.7 final review round — one regression test group per finding fixed in
// this round (S1 and S3 live next to the tests they extend:
// v07-pending-spends.test.ts and v07-review-r1.test.ts; S8 in
// v07-address-persistence.test.ts).
//
//   S2  Combine can walk as deep as Send (MAX_UTXO_WALK_PAGES_HARD), and
//       later batches are re-checked at the plan's own depth
//   S4  Bridge: wrap composes and shows the PRL network fee before signing;
//       unwrap shows ETH gas ceilings and the signing calls enforce them
//   S5  an accepted broadcast that stays unsettled is listed with
//       Check status / Release
//   S6  Activity merges vinextra evidence across copies of one txid
//   S7  the skip link never changes the URL fragment (HashRouter offline)
//   S9  without Web Locks a tab entering the bfcache stays listed
//   S10 the offline signer compares address pools as prefixes
//   S12 the activity scan skips change addresses the balance refresh skips
//   S13 CSP / allowlists no longer carry dead sentries or cloudflare-eth.com
//   S14 the wipe dialog warns about unknown broadcasts it would forget

import { keccak256 } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ethRpc from "../src/chains/ethereum/rpc";
import * as workerClient from "../src/crypto/worker-client";
import { fetchActivity } from "../src/services/activity";
import { checkBroadcast, releaseBroadcast } from "../src/services/broadcast-status";
import {
  approveWprlForBridge,
  GAS_CEILING_HEADROOM_PCT,
  previewUnwrapGas,
  requestBurn,
} from "../src/services/eth-tx";
import { recheckConsolidationBatch, type ConsolidationBatch } from "../src/services/pearl-consolidate";
import { fetchPrlUtxos, MAX_UTXO_WALK_PAGES_HARD, _clearAddressHistoryForTests } from "../src/services/pearl-rpc";
import { HistoryIncompleteError, loadSpendableUtxos } from "../src/services/pearl-tx";
import {
  ACCEPTED_STALL_MS,
  broadcastRecords,
  clearPendingSpends,
  pendingOutpoints,
  stalledBroadcasts,
  unresolvedBroadcasts,
  WALLET_TABS_STORAGE_KEY,
} from "../src/services/pending-spends";
import { isAllowedEthRpcOverride, isAllowedRpcOverride, useUI } from "../src/state/ui-store";
import Page, { focusMain } from "../src/ui/components/Page";
import PendingBroadcasts, { WipeBroadcastWarning } from "../src/ui/components/PendingBroadcasts";
import { activityPool } from "../src/ui/hooks/useWalletBalances";
import { poolsDisagree } from "../src/ui/pages/OfflineSign";
import { rec, seedRecords, useMemoryStorage } from "./helpers/broadcast-env";

const ROOT = join(__dirname, "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
  useMemoryStorage();
  _clearAddressHistoryForTests();
});
afterEach(() => {
  clearPendingSpends();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (method: string, params: unknown[]) => Response | Promise<Response>;
function stubRpc(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      calls.push(body.method);
      return handler(body.method, body.params);
    }),
  );
  return calls;
}
const ok = (result: unknown) => new Response(JSON.stringify({ result, error: null }));
const rpcErr = (code: number, message: string) => new Response(JSON.stringify({ result: null, error: { code, message } }));
const NO_TX = () => rpcErr(-5, "No information available about transaction");
const NO_ADDR = () => rpcErr(-5, "No information available about address");
const SCRIPT = "5120" + "00".repeat(32);
const hexId = (n: number) => n.toString(16).padStart(64, "0");

// ─── S2 ──────────────────────────────────────────────────────────────────

describe("S2 — Combine walks as deep as Send; later batches re-check at the plan's depth", () => {
  const ADDR = "prl1pdeepwallet";
  /** 6,001 one-output txs paying ADDR (newest first pages of 100). */
  function stubHistory(count: number) {
    return stubRpc((m, p) => {
      if (m !== "searchrawtransactions" || p[0] !== ADDR) return rpcErr(-32601, "nope");
      const skip = p[2] as number;
      const n = Math.max(0, Math.min(100, count - skip));
      if (n === 0) return NO_ADDR();
      return ok(
        Array.from({ length: n }, (_, i) => ({
          txid: hexId(skip + i + 1),
          vin: [],
          vout: [{ value: 1, n: 0, scriptPubKey: { address: ADDR, hex: SCRIPT } }],
        })),
      );
    });
  }

  it("the default walk refuses a 6,001-tx address; the deeper walk lists every coin", async () => {
    stubHistory(6_001);
    await expect(loadSpendableUtxos({ pool: [ADDR] })).rejects.toBeInstanceOf(HistoryIncompleteError);
    const live = await loadSpendableUtxos({ pool: [ADDR], maxPages: MAX_UTXO_WALK_PAGES_HARD });
    expect(live.utxos).toHaveLength(6_001);
    expect(live.historyIncomplete).toBe(0);
  });

  it("recheckConsolidationBatch refuses at the default depth and passes at the plan's deeper depth", async () => {
    stubHistory(6_001);
    const coin = (n: number) => ({ txid: hexId(n), vout: 0, valueGrains: 100_000_000n, scriptHex: SCRIPT, branch: 0 as const, index: 0 });
    const batch = { utxos: [coin(1), coin(6_001)] } as unknown as ConsolidationBatch;
    const book = { external: [ADDR], internal: [] };
    await expect(recheckConsolidationBatch(batch, book)).rejects.toThrow("E_CONSOLIDATION_RECHECK_INCOMPLETE");
    await expect(recheckConsolidationBatch(batch, book, { maxPages: MAX_UTXO_WALK_PAGES_HARD, now: () => 7 })).resolves.toBe(7);
  });

  it("past the hard cap the refusal stands", async () => {
    stubHistory(MAX_UTXO_WALK_PAGES_HARD * 100 + 1);
    await expect(loadSpendableUtxos({ pool: [ADDR], maxPages: MAX_UTXO_WALK_PAGES_HARD })).rejects.toBeInstanceOf(
      HistoryIncompleteError,
    );
  });

  it("the page offers Search deeper and carries the depth into later-batch re-checks", () => {
    const page = src("src/ui/pages/Consolidate.tsx");
    expect(page).toMatch(/maxPages = deep \? MAX_UTXO_WALK_PAGES_HARD : undefined/);
    expect(page).toMatch(/loadSpendableUtxos\(\{[^}]*maxPages[^}]*\}\)/);
    expect(page).toMatch(/\{ maxPages: coins\.maxPages \}/);
    expect(page).toMatch(/Search deeper/);
  });
});

// ─── S4 ──────────────────────────────────────────────────────────────────

describe("S4 — Bridge fees are shown before anything is signed", () => {
  const FROM = "0x0000000000000000000000000000000000000001" as const;
  const GWEI = 1_000_000_000n;
  function ethStub(baseGwei: bigint, units: bigint) {
    const sent: string[] = [];
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({
      getBlock: async () => ({ baseFeePerGas: baseGwei * GWEI }),
      estimateGas: async () => units,
      getTransactionCount: async () => 0,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: `0x${string}` }) => {
        sent.push("tx");
        return keccak256(serializedTransaction); // R7 P2: its own hash
      },
      chain: { id: 1 },
    } as never);
    const sign = vi.spyOn(workerClient.cryptoWorker, "call").mockResolvedValue({ raw: "0x02c0ffee" } as never);
    return { sent, sign };
  }

  it("previewUnwrapGas: approve ceiling when an approval is needed, burn ceiling otherwise", async () => {
    ethStub(10n, 100_000n);
    const maxFee = ((10n * 2n + 2n) * GWEI * GAS_CEILING_HEADROOM_PCT) / 100n;
    const base = { network: "mainnet" as const, from: FROM, amount: 1_000n, pearlAddress: "prl1pme", tier: "normal" as const };
    await expect(previewUnwrapGas({ ...base, needsApprove: true })).resolves.toEqual({
      maxFeePerGas: maxFee,
      approveWei: 120_000n * maxFee,
      burnWei: null,
    });
    await expect(previewUnwrapGas({ ...base, needsApprove: false })).resolves.toEqual({
      maxFeePerGas: maxFee,
      approveWei: null,
      burnWei: 120_000n * maxFee,
    });
  });

  it("a signing call above the reviewed ceiling is refused unsigned; within it, it signs", async () => {
    const { sent, sign } = ethStub(10n, 100_000n);
    const fee = (10n * 2n + 2n) * GWEI;
    const base = { network: "mainnet" as const, from: FROM, tier: "normal" as const, amount: 1_000n };
    // Fee per gas rose above the review.
    await expect(approveWprlForBridge({ ...base, ceiling: { maxFeePerGas: fee - 1n, maxCostWei: 10n ** 30n } })).rejects.toThrow(
      "E_ETH_GAS_ABOVE_REVIEW",
    );
    // Total above the reviewed total.
    await expect(
      requestBurn({ ...base, pearlAddress: "prl1pme", ceiling: { maxFeePerGas: fee, maxCostWei: 120_000n * fee - 1n } }),
    ).rejects.toThrow("E_ETH_GAS_ABOVE_REVIEW");
    expect(sign).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    await expect(
      requestBurn({ ...base, pearlAddress: "prl1pme", ceiling: { maxFeePerGas: fee, maxCostWei: 120_000n * fee } }),
    ).resolves.toMatchObject({ txHash: keccak256("0x02c0ffee") }); // FX1: local hash of the signed bytes
    expect(sent).toEqual(["tx"]);
  });

  it("wrap composes first and signs only the reviewed transaction; unwrap shows the full payout address and gas", () => {
    const page = src("src/ui/pages/Bridge.tsx");
    expect(page).not.toMatch(/sendPearl\(/);
    expect(page).toMatch(/composePearlSend\(/);
    // (R6 N2: the call now also passes the signing session of the click.)
    expect(page).toMatch(/broadcastPearlPrecomposed\(frozen, pearlNetwork, Date\.now\(\), \[\], session\)/);
    expect(page).toMatch(/Pearl network fee/);
    expect(page).not.toMatch(/is not\s+shown here/);
    expect(page).not.toMatch(/pearlAddress\.slice\(/);
    expect(page).toMatch(/<Row k="Payout to" v=\{pearlAddress \?\? "—"\} \/>/);
    // The signing flows live in bridge-flows.ts (behaviour: v07-review-final-r2).
    const flows = src("src/ui/pages/bridge-flows.ts");
    expect(flows).toMatch(/ceiling: \{ maxFeePerGas: gas\.maxFeePerGas, maxCostWei: approveWei \}/);
    expect(flows).toMatch(/ceiling: \{ maxFeePerGas: gas\.maxFeePerGas, maxCostWei: burnWei \}/);
  });
});

// ─── S5 ──────────────────────────────────────────────────────────────────

describe("S5 — an accepted broadcast that never settles can be checked and released", () => {
  const ADDR = "prl1pstalled";
  const C1 = "11".repeat(32);
  const T = "ab".repeat(32);
  function node(listed: boolean, spentElsewhere = false) {
    return stubRpc((m, p) => {
      if (m === "getrawtransaction") return NO_TX();
      if (m === "searchrawtransactions") {
        if (p[0] !== ADDR || (p[2] as number) !== 0 || (!listed && !spentElsewhere)) return NO_ADDR();
        const fund = { txid: C1, vin: [], vout: [{ value: 1, n: 0, scriptPubKey: { address: ADDR, hex: SCRIPT } }] };
        return ok(spentElsewhere ? [fund, { txid: "ee".repeat(32), vin: [{ txid: C1, vout: 0 }], vout: [] }] : [fund]);
      }
      return rpcErr(-32601, "nope");
    });
  }

  it("listed after ACCEPTED_STALL_MS; absent + unspent → explicit release frees the coins", async () => {
    const old = Date.now() - ACCEPTED_STALL_MS - 1;
    seedRecords([rec({ txid: T, inputs: [`${C1}:0`], addresses: [ADDR], state: "accepted", createdAt: old })]);
    expect(stalledBroadcasts().map((r) => r.txid)).toEqual([T]);
    expect(unresolvedBroadcasts()).toEqual([]); // holds no other broadcast
    expect(renderToStaticMarkup(createElement(PendingBroadcasts))).toMatch(/hasn(&#x27;|')t confirmed yet/);
    node(true);
    await expect(checkBroadcast(T)).resolves.toBe("absent-unspent");
    expect(pendingOutpoints().has(`${C1}:0`)).toBe(true); // a check alone releases nothing
    await expect(releaseBroadcast(T)).resolves.toBe("absent-unspent");
    expect(broadcastRecords()).toEqual([]);
  });

  it("a fresh accepted record is neither listed nor releasable", async () => {
    seedRecords([rec({ txid: T, inputs: [`${C1}:0`], addresses: [ADDR], state: "accepted" })]);
    expect(stalledBroadcasts()).toEqual([]);
    expect(renderToStaticMarkup(createElement(PendingBroadcasts))).toBe("");
    const calls = node(true);
    await expect(releaseBroadcast(T)).resolves.toBe("unknown");
    expect(calls).toEqual([]);
    expect(pendingOutpoints().has(`${C1}:0`)).toBe(true);
  });

  it("a stalled record whose input another tx is seen spending is dropped as 'spent'; one merely missing stays", async () => {
    seedRecords([
      rec({ txid: T, inputs: [`${C1}:0`], addresses: [ADDR], state: "accepted", createdAt: Date.now() - ACCEPTED_STALL_MS - 1 }),
    ]);
    node(false); // funding tx gone too (evicted parent): no positive evidence
    await expect(checkBroadcast(T)).resolves.toBe("unknown");
    expect(pendingOutpoints().has(`${C1}:0`)).toBe(true);
    node(false, true);
    await expect(checkBroadcast(T)).resolves.toBe("spent");
    expect(broadcastRecords()).toEqual([]);
  });
});

// ─── S6 ──────────────────────────────────────────────────────────────────

describe("S6 — Activity: a reused balance-walk copy without prevOut can't flip a payment to 'Received'", () => {
  const A = "prl1pspender";
  const B = "prl1pchange";
  const PEER = "prl1ppeer";
  const OUT = "0d".repeat(32);
  const FUNDING = "0f".repeat(32); // outside the window

  it("merges vinextra evidence across copies of one txid", async () => {
    const tx = (withPrevOut: boolean) => ({
      txid: OUT,
      vin: [{ txid: FUNDING, vout: 0, ...(withPrevOut ? { prevOut: { addresses: [A], value: 10 } } : {}) }],
      vout: [
        { value: 1, n: 0, scriptPubKey: { address: PEER, hex: SCRIPT } },
        { value: 8.9, n: 1, scriptPubKey: { address: B, hex: SCRIPT } },
      ],
      time: 1_700_000_000,
    });
    stubRpc((m, p) => {
      if (m !== "searchrawtransactions") return rpcErr(-32601, "nope");
      const vinextra = p.length > 4;
      if (p[0] === A) return ok([tx(vinextra)]);
      if (p[0] === B) return ok([tx(vinextra)]);
      return NO_ADDR();
    });
    vi.spyOn(ethRpc, "ethClient").mockReturnValue({ getBlockNumber: async () => 1n, getLogs: async () => [] } as never);
    // The balance walk of A caches A's complete history (no vinextra).
    await fetchPrlUtxos(A);
    const r = await fetchActivity([A, B], "0x0000000000000000000000000000000000000001", "mainnet", 10);
    const items = r.items.filter((i) => i.chain === "pearl");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ txid: OUT, direction: "out", amount: 100_000_000n });
  });
});

// ─── S7 ──────────────────────────────────────────────────────────────────

describe("S7 — the skip link never changes the URL fragment", () => {
  it("renders a button, not an in-page anchor", () => {
    const html = renderToStaticMarkup(createElement(Page, { chrome: false }, "x"));
    expect(html).not.toMatch(/href="#main-content"/);
    expect(html).toMatch(/<button type="button" class="skip-link">Skip to content<\/button>/);
    expect(html).toMatch(/id="main-content"/);
  });

  it("focusMain focuses the main region and leaves location alone", () => {
    const main = { focus: vi.fn(), scrollIntoView: vi.fn() };
    const location = { hash: "#/offline-sign" };
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "main-content" ? main : null) });
    vi.stubGlobal("location", location);
    focusMain();
    expect(main.focus).toHaveBeenCalled();
    expect(location.hash).toBe("#/offline-sign");
  });
});

// ─── S9 ──────────────────────────────────────────────────────────────────

describe("S9 — without Web Locks a tab entering the back/forward cache stays listed", () => {
  it("pagehide with persisted=true keeps the tab; a real unload unlists it", async () => {
    const storage = useMemoryStorage();
    const handlers: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h) });
    vi.resetModules();
    await import("../src/services/broadcast-lock");
    const listed = () => JSON.parse(storage.getItem(WALLET_TABS_STORAGE_KEY) ?? "[]") as string[];
    expect(listed()).toHaveLength(1);
    handlers.pagehide!({ persisted: true });
    expect(listed()).toHaveLength(1);
    handlers.pagehide!({ persisted: false });
    expect(listed()).toEqual([]);
    handlers.pageshow!({ persisted: true });
    expect(listed()).toHaveLength(1);
    vi.resetModules();
  });
});

// ─── S10 ─────────────────────────────────────────────────────────────────

describe("S10 — offline signer pool check", () => {
  it("a longer watcher pool of the same wallet agrees; a different address at any shared index disagrees", () => {
    const signer = Array.from({ length: 20 }, (_, i) => `a${i}`);
    const watcher = Array.from({ length: 26 }, (_, i) => `a${i}`);
    expect(poolsDisagree(watcher, signer)).toBe(false);
    expect(poolsDisagree(signer, watcher)).toBe(false);
    expect(poolsDisagree(["b0", ...watcher.slice(1)], signer)).toBe(true);
    expect(poolsDisagree(watcher.map((a, i) => (i === 19 ? "x" : a)), signer)).toBe(true);
  });
});

// ─── S12 ─────────────────────────────────────────────────────────────────

describe("S12 — activity scans the addresses the balance refresh walks", () => {
  it("skips change addresses known unused past lastUsed + window; keeps every external one", () => {
    const ext = ["e0", "e1", "e2"];
    const change = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const knownUnused = new Set([...change.slice(3), "e2"]);
    const pool = activityPool(ext, change, { fullAt: 0, lastUsed: [1, 2], knownUnused });
    expect(pool).toEqual([...ext, ...change.slice(0, 8)]); // c0..c2 used/unknown, c3..c7 inside the window of 5
    expect(activityPool(ext, change, undefined)).toEqual([...ext, ...change]); // no full walk yet: everything
  });
});

// ─── S13 ─────────────────────────────────────────────────────────────────

describe("S13 — CSP and RPC allowlists", () => {
  it("no dead sentry names or cloudflare-eth.com in the CSP (both copies) or the override allowlists", () => {
    for (const f of ["index.html", "public/_headers"]) {
      const csp = src(f);
      expect(csp, f).not.toMatch(/pearl-sentry-/);
      expect(csp, f).not.toMatch(/cloudflare-eth\.com/);
      expect(csp, f).toMatch(/connect-src 'self' https:\/\/api\.pearlbridge\.xyz https:\/\/rpc\.pearlbridge\.xyz/);
    }
    expect(isAllowedRpcOverride("https://pearl-sentry-fsn1-1.pearlbridge.xyz/")).toBe(false);
    expect(isAllowedRpcOverride("https://rpc.pearlbridge.xyz/")).toBe(true);
    expect(isAllowedEthRpcOverride("https://cloudflare-eth.com")).toBe(false);
    expect(isAllowedEthRpcOverride("https://eth.drpc.org")).toBe(true);
  });
});

// ─── S14 ─────────────────────────────────────────────────────────────────

describe("S14 — the wipe dialog warns about unknown broadcasts", () => {
  it("shown only while an unknown broadcast exists", () => {
    const warn = () => renderToStaticMarkup(createElement(WipeBroadcastWarning));
    expect(warn()).toBe("");
    seedRecords([rec({ txid: "cd".repeat(32), inputs: [`${"11".repeat(32)}:0`] })]);
    expect(warn()).toMatch(/unknown status\. Wiping\s+forgets it/);
    expect(src("src/ui/pages/Settings.tsx")).toMatch(/<WipeBroadcastWarning \/>/);
  });
});
