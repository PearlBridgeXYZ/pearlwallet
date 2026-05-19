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

  it("applies a custom RPC override without touching other params", () => {
    const p = pearlParams("mainnet", "https://my-sentry.example/rpc");
    expect(p.rpcUrl).toBe("https://my-sentry.example/rpc");
    expect(p.rpcLabel).toBe("custom");
    expect(p.hrp).toBe("prl");
    expect(p.decimals).toBe(8);
    expect(p.explorerUrl).toBe(PEARL_MAINNET.explorerUrl);
    expect(p.magic).toBe(PEARL_MAINNET.magic);
  });

  it("ignores whitespace-only overrides", () => {
    expect(pearlParams("mainnet", "   ")).toBe(PEARL_MAINNET);
    expect(pearlParams("mainnet", "")).toBe(PEARL_MAINNET);
  });

  it("trims whitespace on override", () => {
    const p = pearlParams("mainnet", "  https://x.example/  ");
    // Override is used as-is after trim (we don't URL-normalise here).
    expect(p.rpcUrl).toBe("https://x.example/");
  });
});
