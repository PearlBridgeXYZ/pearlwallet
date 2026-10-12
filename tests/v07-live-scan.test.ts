// Live, read-only sanity check of the v0.7 transport against the public
// Pearl RPC. Skipped by default; run with:
//
//   PEARL_LIVE=1 npx vitest run tests/v07-live-scan.test.ts
//
// Scans a 21-address pool (20 never-used addresses + one busy address with
// multi-page history) with the PRODUCTION limiter/backoff while an
// activity scan of the same pool runs concurrently — the exact pattern
// that used to trip the origin rate limit — and asserts that no address is
// dropped. Only searchrawtransactions (read-only) is called.

import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { encodeTaprootAddress } from "../src/chains/pearl/address";
import { PEARL_MAINNET } from "../src/chains/pearl/network";
import { scanPrlPool } from "../src/services/balances";
import { fetchActivity } from "../src/services/activity";
import { _setPearlRpcTuningForTests, _resetPearlRpcHealthForTests } from "../src/services/pearl-rpc";
import { useLiveRpc } from "./live-rpc-guard";

const LIVE = process.env.PEARL_LIVE === "1";
useLiveRpc(LIVE);
const BUSY_ADDR = process.env.PEARL_TEST_ADDRESS
  ?? "prl1ptzrunj28tua9uklxa3ses9nsl7g22s2qx2fdu9gf7wgvup58s94q9ldnxh";

describe("Live v0.7 pool scan + concurrent activity scan", () => {
  it.skipIf(!LIVE)("scans 20 empty addresses + a busy address with zero dropped addresses", async () => {
    _setPearlRpcTuningForTests(undefined); // production pacing/backoff
    _resetPearlRpcHealthForTests();

    // Send the same Origin the browser would, and count HTTP statuses.
    const realFetch = globalThis.fetch;
    const statuses = new Map<number, number>();
    let requests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      const headers = new Headers(init?.headers);
      headers.set("origin", "https://wallet.pearlbridge.xyz");
      const res = await realFetch(input, { ...init, headers });
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      return res;
    }) as typeof fetch;

    try {
      const empty = Array.from({ length: 20 }, (_, i) =>
        encodeTaprootAddress(sha256(new TextEncoder().encode(`v07-live-empty-${i}`)), PEARL_MAINNET),
      );
      const pool = [...empty, BUSY_ADDR];

      const t0 = performance.now();
      let balMs = 0;
      let actMs = 0;
      let progressEvents = 0;
      const [scan, activity] = await Promise.all([
        scanPrlPool(pool, { onProgress: () => progressEvents++ }).then((r) => {
          balMs = performance.now() - t0;
          return r;
        }),
        fetchActivity(pool, undefined, "mainnet", 25).then((r) => {
          actMs = performance.now() - t0;
          return r;
        }),
      ]);

      const report = {
        balanceScanMs: Math.round(balMs),
        activityScanMs: Math.round(actMs),
        totalRequests: requests,
        httpStatuses: Object.fromEntries(statuses),
        balanceSource: scan.source,
        balanceFailures: scan.failures,
        progressEvents,
        busyAddrUtxos: scan.perAddress[20]?.status === "ok" ? scan.perAddress[20].utxos.length : "error",
        activitySource: activity.pearlSource,
        activityItems: activity.items.length,
        activityNewestFirst: activity.items.every((it, i, a) => i === 0 || a[i - 1]!.timeSec >= it.timeSec),
      };
      // Evidence for the run log.
      console.log("V07_LIVE_REPORT " + JSON.stringify(report));

      expect(scan.failures).toBe(0);
      expect(scan.source).toBe("live");
      expect(progressEvents).toBe(pool.length);
      expect(activity.pearlSource).toBe("live");
      expect(report.activityNewestFirst).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 180_000);
});
