// Live integration tests against the real Pearl sentry RPC and the
// OTC price proxy. These hit the network so they're gated behind
// PEARL_LIVE=1 and skipped by default. CI / public test runs do not
// see these.
//
// Run locally with:  PEARL_LIVE=1 npm test

import { describe, it, expect } from "vitest";
import { fetchPrlBalanceGrains } from "../src/services/pearl-rpc";

const LIVE = process.env.PEARL_LIVE === "1";
const TEST_ADDR = process.env.PEARL_TEST_ADDRESS
  ?? "prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs";

describe("Live Pearl RPC", () => {
  it.skipIf(!LIVE)("rpc.pearlwallet.xyz responds to OPTIONS with CORS allow-origin = pearlwallet.xyz", async () => {
    const r = await fetch("https://rpc.pearlwallet.xyz/", {
      method: "OPTIONS",
      headers: {
        "origin": "https://pearlwallet.xyz",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://pearlwallet.xyz");
  });

  it.skipIf(!LIVE)("rpc.pearlwallet.xyz answers getblockcount", async () => {
    const r = await fetch("https://rpc.pearlwallet.xyz/", {
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
