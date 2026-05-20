import { describe, it, expect } from "vitest";
import { pearlParams, PEARL_MAINNET } from "../src/chains/pearl/network";

describe("pearlParams", () => {
  it("returns mainnet defaults when no override given", () => {
    const p = pearlParams("mainnet");
    expect(p).toBe(PEARL_MAINNET);
    expect(p.hrp).toBe("prl");
    expect(p.decimals).toBe(8);
    expect(p.rpcUrl).toBe("https://rpc.pearlwallet.xyz/");
    expect(p.rpcLabel).toBe("rpc.pearlwallet.xyz");
  });

  it("applies an allowlisted RPC override without touching other params", () => {
    // v0.2.0 split: Pearl-side allowlist is rpc.pearlwallet.xyz + pearlbridge.xyz
    // (ETH-side hosts moved to the dedicated ethRpcOverride allowlist).
    const p = pearlParams("mainnet", "https://pearlbridge.xyz/rpc");
    expect(p.rpcUrl).toBe("https://pearlbridge.xyz/rpc");
    expect(p.rpcLabel).toBe("custom");
    expect(p.hrp).toBe("prl");
    expect(p.decimals).toBe(8);
    expect(p.explorerUrl).toBe(PEARL_MAINNET.explorerUrl);
    expect(p.magic).toBe(PEARL_MAINNET.magic);
  });

  it("falls back to canonical RPC when override is not on the allowlist (v0.1.8 H-2)", () => {
    // A stale localStorage value (or tampering by a bookmarklet) could
    // pass an arbitrary URL here. The store's setter rejects it, but
    // pearlParams() re-checks defense-in-depth.
    const p = pearlParams("mainnet", "https://my-sentry.example/rpc");
    expect(p).toBe(PEARL_MAINNET);
  });

  it("ignores whitespace-only overrides", () => {
    expect(pearlParams("mainnet", "   ")).toBe(PEARL_MAINNET);
    expect(pearlParams("mainnet", "")).toBe(PEARL_MAINNET);
  });

  it("trims whitespace on override (allowlisted host)", () => {
    const p = pearlParams("mainnet", "  https://pearlbridge.xyz/rpc  ");
    expect(p.rpcUrl).toBe("https://pearlbridge.xyz/rpc");
  });
});
