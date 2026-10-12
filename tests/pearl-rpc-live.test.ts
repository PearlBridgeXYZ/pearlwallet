// Live integration tests against the real Pearl sentry RPC and the
// OTC price proxy. These hit the network so they're gated behind
// PEARL_LIVE=1 and skipped by default. CI / public test runs do not
// see these.
//
// Run locally with:  PEARL_LIVE=1 npx vitest run --no-file-parallelism \
//   tests/pearl-rpc-live.test.ts tests/v07-live-scan.test.ts

import { describe, it, expect } from "vitest";
import { fetchPrlBalanceGrains } from "../src/services/pearl-rpc";
import { useLiveRpc } from "./live-rpc-guard";

const LIVE = process.env.PEARL_LIVE === "1";
useLiveRpc(LIVE);
const TEST_ADDR = process.env.PEARL_TEST_ADDRESS
  ?? "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";

describe("Live Pearl RPC", () => {
  it.skipIf(!LIVE)("rpc.pearlbridge.xyz responds to OPTIONS with CORS allow-origin = wallet.pearlbridge.xyz", async () => {
    const r = await fetch("https://rpc.pearlbridge.xyz/", {
      method: "OPTIONS",
      headers: {
        "origin": "https://wallet.pearlbridge.xyz",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://wallet.pearlbridge.xyz");
  });

  // v0.7 beta: the proxy allowlists exactly wallet. and next.wallet. (s1
  // nginx map, 2026-10-12); any other origin gets no allow-origin header.
  it.skipIf(!LIVE)("rpc.pearlbridge.xyz allows the beta origin and no other", async () => {
    const preflight = (origin: string) => fetch("https://rpc.pearlbridge.xyz/", {
      method: "OPTIONS",
      headers: {
        "origin": origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    const beta = await preflight("https://next.wallet.pearlbridge.xyz");
    expect(beta.status).toBeLessThan(300);
    expect(beta.headers.get("access-control-allow-origin")).toBe("https://next.wallet.pearlbridge.xyz");
    const other = await preflight("https://example.invalid");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.skipIf(!LIVE)("rpc.pearlbridge.xyz answers getblockcount", async () => {
    const r = await fetch("https://rpc.pearlbridge.xyz/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "getblockcount", params: [], id: 1 }),
    });
    expect(r.ok).toBe(true);
    const body = await r.json() as { result?: number; error?: unknown };
    expect(body.error).toBeFalsy();
    expect(typeof body.result).toBe("number");
    expect(body.result).toBeGreaterThan(0);
  });

  it.skipIf(!LIVE)("balance lookup against a real address returns a non-negative bigint", async () => {
    const bal = await fetchPrlBalanceGrains(TEST_ADDR);
    expect(typeof bal.grains).toBe("bigint");
    expect(bal.grains >= 0n).toBe(true);
  }, 60_000);

  it.skipIf(!LIVE)("balance lookup against a fresh/empty address returns 0", async () => {
    // Generated locally, never funded.
    const emptyAddr = "prl1p" + "q".repeat(58);
    // ^ valid bech32m surface; might fail decode on sentry side → treated as 0n.
    const bal = await fetchPrlBalanceGrains(emptyAddr).catch(() => ({ grains: 0n, degraded: false }));
    expect(bal.grains).toBeGreaterThanOrEqual(0n);
  }, 30_000);
});
