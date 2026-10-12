// R2 FY5 — the unacknowledged ETH status-unknown block survives remounts.
// Before: Send ETH / Send WPRL / Unwrap kept it in component useState, so
// leaving the page (or switching bridge tabs) and coming back re-enabled the
// send button, and an unwrap whose approve / burn came back status-unknown
// after its card unmounted recorded nothing at all. Now the record (network,
// from, hash, what, ts) lives in sessionStorage keyed by network + address.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ETH_UNKNOWN_STORAGE_KEY,
  acknowledgeEthUnknown,
  clearEthUnknown,
  currentEthUnknown,
  ethUnknownFor,
  ethUnknownKey,
  putEthUnknown,
  readEthUnknownRecords,
  recordEthUnknown,
  subscribeEthUnknown,
  type KVStorage,
} from "../src/state/eth-unknown";
import * as ethTx from "../src/services/eth-tx";
import * as bridgeV1 from "../src/services/bridge-v1";
import { bridgeConfig } from "../src/services/bridge";
import { createUnwrapFlow, type UnwrapView } from "../src/ui/pages/bridge-flows";

function kv(): KVStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}
const H1 = `0x${"11".repeat(32)}` as const;
const H2 = `0x${"22".repeat(32)}` as const;
const ME = "0xAbCdEf0000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";

describe("FY5 store logic (pure)", () => {
  it("records per network + address; never shown for another address or network", () => {
    const s = kv();
    putEthUnknown(s, { network: "mainnet", from: ME, hash: H1, what: "ETH transfer", ts: 1 });
    expect(ethUnknownFor(s, "mainnet", ME)).toEqual([{ network: "mainnet", from: ME.toLowerCase(), hash: H1, what: "ETH transfer", ts: 1 }]);
    expect(ethUnknownFor(s, "mainnet", ME.toLowerCase())).toHaveLength(1); // case-insensitive address
    expect(ethUnknownFor(s, "mainnet", OTHER)).toEqual([]);
    expect(ethUnknownFor(s, "sepolia", ME)).toEqual([]);
    expect(ethUnknownFor(s, "mainnet", undefined)).toEqual([]);
    expect(Object.keys(readEthUnknownRecords(s))).toEqual([ethUnknownKey("mainnet", ME)]);
  });

  it("survives a 'remount': a fresh read of the same storage still sees it", () => {
    const s = kv();
    putEthUnknown(s, { network: "mainnet", from: ME, hash: H1, what: "burn", ts: 5 });
    const persisted = s.map.get(ETH_UNKNOWN_STORAGE_KEY)!;
    const s2 = kv();
    s2.setItem(ETH_UNKNOWN_STORAGE_KEY, persisted);
    expect(ethUnknownFor(s2, "mainnet", ME)[0]!.hash).toBe(H1);
  });

  it("idempotent per hash; acknowledging clears only that hash; last one removes the key", () => {
    const s = kv();
    putEthUnknown(s, { network: "mainnet", from: ME, hash: H1, what: "approval", ts: 1 });
    putEthUnknown(s, { network: "mainnet", from: ME, hash: H1, what: "approval", ts: 2 });
    putEthUnknown(s, { network: "mainnet", from: ME, hash: H2, what: "burn", ts: 3 });
    putEthUnknown(s, { network: "mainnet", from: OTHER, hash: H1, what: "ETH transfer", ts: 4 });
    expect(ethUnknownFor(s, "mainnet", ME).map((r) => r.hash)).toEqual([H1, H2]);
    acknowledgeEthUnknown(s, "mainnet", ME, H1);
    expect(ethUnknownFor(s, "mainnet", ME).map((r) => r.hash)).toEqual([H2]);
    expect(ethUnknownFor(s, "mainnet", OTHER)).toHaveLength(1); // other address untouched
    acknowledgeEthUnknown(s, "mainnet", ME, H2);
    expect(ethUnknownFor(s, "mainnet", ME)).toEqual([]);
    acknowledgeEthUnknown(s, "mainnet", OTHER, H1);
    expect(s.map.has(ETH_UNKNOWN_STORAGE_KEY)).toBe(false);
  });

  it("malformed or mis-keyed storage is ignored, never trusted", () => {
    const s = kv();
    s.setItem(ETH_UNKNOWN_STORAGE_KEY, "{not json");
    expect(readEthUnknownRecords(s)).toEqual({});
    s.setItem(
      ETH_UNKNOWN_STORAGE_KEY,
      JSON.stringify({
        [ethUnknownKey("mainnet", OTHER)]: [{ network: "mainnet", from: ME.toLowerCase(), hash: H1, what: "x", ts: 1 }],
        [ethUnknownKey("mainnet", ME)]: [{ network: "mainnet", from: ME.toLowerCase(), hash: "0x12", what: "x", ts: 1 }],
      }),
    );
    expect(readEthUnknownRecords(s)).toEqual({});
  });
});

// localStorage double for the live store (FZ1 moved it from sessionStorage
// to origin-wide localStorage; this suite's assertions are otherwise
// unchanged).
let session: ReturnType<typeof kv>;
beforeEach(() => {
  session = kv();
  (globalThis as { localStorage?: KVStorage }).localStorage = session;
});
afterEach(() => {
  delete (globalThis as { localStorage?: KVStorage }).localStorage;
  vi.restoreAllMocks();
});

describe("FY5 live store", () => {
  it("record / current / clear go through localStorage and notify subscribers", () => {
    const seen = vi.fn();
    const off = subscribeEthUnknown(seen);
    recordEthUnknown({ network: "mainnet", from: ME, hash: H1, what: "WPRL transfer" });
    expect(session.map.has(ETH_UNKNOWN_STORAGE_KEY)).toBe(true);
    expect(currentEthUnknown("mainnet", ME)?.hash).toBe(H1);
    expect(currentEthUnknown("mainnet", OTHER)).toBeNull();
    clearEthUnknown("mainnet", ME, H1);
    expect(currentEthUnknown("mainnet", ME)).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it("an unwrap whose burn comes back status-unknown AFTER its card unmounted is still recorded", async () => {
    const AMOUNT = 100_000_000n;
    const cfg = bridgeConfig("mainnet");
    const quote: bridgeV1.BurnQuote = {
      amount: AMOUNT, feeBps: 0, fee: 0n, net: AMOUNT, withinDailyCap: true, paused: false,
      addressValid: true, bridgeController: cfg.bridgeController, wprl: cfg.wprl,
    };
    vi.spyOn(bridgeV1, "fetchBurnQuote").mockResolvedValue(quote);
    vi.spyOn(ethTx, "readWprlAllowance").mockResolvedValue(AMOUNT);
    vi.spyOn(ethTx, "readWprlBalanceOf").mockResolvedValue(AMOUNT);
    vi.spyOn(ethTx, "requestBurn").mockRejectedValue(new ethTx.EthBroadcastStatusUnknownError(H2, new Error("504")));
    // An unmounted card: its setters go nowhere, and it has no setEthUnknown.
    const view: UnwrapView = {
      setBusy: () => {}, setErr: () => {}, setNotice: () => {}, setGas: () => {},
      setNeedsApprove: () => {}, setQuote: () => {}, onStarted: async () => {},
    };
    await createUnwrapFlow()(
      { network: "mainnet", ethAddress: ME as `0x${string}`, pearlAddress: "prl1pme", amount: AMOUNT, quote,
        gas: { maxFeePerGas: 7n, approveWei: null, burnWei: 700_000n } },
      view,
    );
    const rec = currentEthUnknown("mainnet", ME);
    expect(rec).toMatchObject({ network: "mainnet", from: ME.toLowerCase(), hash: H2, what: "burn" });
    expect(typeof rec!.ts).toBe("number");
    // A remounted card for another address is not blocked.
    expect(currentEthUnknown("mainnet", OTHER)).toBeNull();
  });

  it("the three pages read the block from the shared store, not component state", () => {
    const root = path.join(__dirname, "../src/ui/pages");
    for (const [f, v] of [["SendETH.tsx", "unknown"], ["SendWPRL.tsx", "unknown"], ["Bridge.tsx", "ethUnknown"]] as const) {
      const page = fs.readFileSync(path.join(root, f), "utf8");
      expect(page, f).toMatch(new RegExp(`const \\[${v}, set\\w+\\] = useEthUnknown\\(ethNetwork, eth\\w+\\);`));
      expect(page, f).not.toMatch(/useState<EthUnknownState/);
    }
  });
});
