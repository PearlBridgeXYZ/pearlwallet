// Final review, round 4 — one group per finding fixed here. S1 (password
// change bound to the wallet it started from) lives in
// v07-keystore-atomic.test.ts, S2 (partial balance wording) in
// v07-balances-progressive.test.ts, S3 (price median) in
// v07-prl-price-function.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import * as pearlRpc from "../src/services/pearl-rpc";
import { _clearAddressHistoryForTests, _setPearlRpcTuningForTests } from "../src/services/pearl-rpc";
import { fetchActivity } from "../src/services/activity";
import { clearBalanceMemory, onBalanceMemoryClear } from "../src/state/balance-memory";
import { composePearlSend, TooManyInputsError, type PoolUtxo } from "../src/services/pearl-tx";

const src = (f: string) => readFileSync(f, "utf8");
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const rpcOk = (result: unknown) => new Response(JSON.stringify({ result, error: null, id: 1 }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("S4 — the recovery-phrase export keeps an absolute warning", () => {
  it("says never to enter the phrase on any website, and names the only exception", () => {
    const s = src("src/ui/pages/Settings.tsx");
    expect(s).toMatch(/Never enter your recovery phrase on any website\./);
    expect(s).toMatch(/link or a message/);
    expect(s).toMatch(/typed or bookmarked, or in its downloaded offline file/);
    expect(s).not.toMatch(/Only enter it when importing into a wallet you trust/);
  });
});

describe("S6 — the activity scan stops on cancellation and when the session ends", () => {
  beforeEach(() => {
    _clearAddressHistoryForTests();
    _setPearlRpcTuningForTests({ ratePerSec: Infinity, burst: 1000, maxRetries: 0, scanConcurrency: 1 });
  });
  afterEach(() => _setPearlRpcTuningForTests());

  function stubRpc() {
    const first = deferred<Response>();
    const started = deferred();
    const addresses: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { params: unknown[] };
        addresses.push(String(body.params[0]));
        if (addresses.length === 1) {
          started.resolve();
          return first.promise;
        }
        return rpcOk([]);
      }),
    );
    return { first, started, addresses };
  }

  it("the app's clear/cancel pattern stops further address requests (reviewer reproduction, inverted)", async () => {
    const { first, started, addresses } = stubRpc();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // main.tsx: on a session clear, cancel and drop every query.
    const unregister = onBalanceMemoryClear(() => {
      void qc.cancelQueries();
      qc.clear();
    });
    const scan = qc
      .fetchQuery({
        queryKey: ["activity"],
        queryFn: ({ signal }) => fetchActivity(["first", "second", "third"], undefined, "mainnet", 25, { signal }),
      })
      .then(
        () => "resolved",
        () => "rejected",
      );
    await started.promise;
    clearBalanceMemory();
    first.resolve(rpcOk([]));
    expect(await scan).toBe("rejected");
    await new Promise((r) => setTimeout(r, 20));
    expect(addresses).toEqual(["first"]);
    unregister();
  });

  it("without a signal, an ended session alone stops the scan and no result is returned", async () => {
    const { first, started, addresses } = stubRpc();
    const p = fetchActivity(["first", "second", "third"], undefined).catch((e: unknown) => e);
    await started.promise;
    clearBalanceMemory();
    first.resolve(rpcOk([]));
    const out = await p;
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/E_SESSION_CLEARED/);
    expect(addresses).toEqual(["first"]);
  });

  it("the activity list passes react-query's signal", () => {
    expect(src("src/ui/components/ActivityList.tsx")).toMatch(/queryFn: \(\{ signal \}\) =>[\s\S]*?\{ signal \},\n\s+\),/);
  });
});

describe("S8 — too many inputs over a complete cached scan is surfaced, not re-walked", () => {
  const POOL = ["prl1pdummy0"];
  const PRL = 100_000_000n;
  const cache: PoolUtxo[] = Array.from({ length: 600 }, (_, i) => ({
    txid: (i + 1).toString(16).padStart(64, "0"),
    vout: 0,
    valueGrains: PRL,
    scriptHex: "5120" + "00".repeat(32),
    branch: 0,
    index: 0,
  }));

  it("throws TooManyInputsError without a live walk", async () => {
    const walk = vi.spyOn(pearlRpc, "fetchPrlUtxos");
    const err = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: "prl1pdest0000",
      amountGrains: 550n * PRL,
      includeTip: false,
      feerateSatPerVbyte: 1n,
      cachedUtxos: cache,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyInputsError);
    expect(walk).not.toHaveBeenCalled();
  });

  it("a degraded cache still falls through to a live walk", async () => {
    const walk = vi.spyOn(pearlRpc, "fetchPrlUtxos").mockResolvedValue({
      utxos: [],
      degraded: false,
      droppedNoScript: 0,
      used: false,
    } as never);
    await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: "prl1pdest0000",
      amountGrains: 550n * PRL,
      includeTip: false,
      feerateSatPerVbyte: 1n,
      cachedUtxos: cache,
      cachedFrom: { degraded: true, historyIncomplete: 0 },
    }).catch(() => undefined);
    expect(walk).toHaveBeenCalled();
  });
});

describe("S12 — comments and landing copy match the code", () => {
  it("the limiter comment states the measured ~1 req/s origin limit", () => {
    const s = src("src/services/rpc-limiter.ts");
    expect(s).not.toMatch(/4 requests\/second/);
    expect(s).toMatch(/about 1 request\/second sustained/);
  });

  it("the tip comment matches its default", () => {
    const s = src("src/state/ui-store.ts");
    expect(s).not.toMatch(/opt-in by default/);
    expect(s).toMatch(/tipEnabled: true,/);
  });

  it("the Ethereum preset comment no longer claims Cloudflare stays in the CSP", () => {
    expect(src("src/chains/ethereum/network.ts")).not.toMatch(/stays on the\n\/\/ override allowlist and in the CSP/);
    expect(src("index.html")).not.toMatch(/cloudflare-eth/);
    expect(src("public/_headers")).not.toMatch(/cloudflare-eth/);
  });

  it("the landing page says bridge network fees and gas are shown before signing", () => {
    const s = src("src/ui/pages/landing/WalletGuide.tsx");
    expect(s).not.toMatch(/added when the transaction is built/);
    expect(s.match(/Pearl network fee or Ethereum gas before you sign/g)).toHaveLength(2);
  });
});
