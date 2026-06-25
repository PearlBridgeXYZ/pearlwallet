import { describe, it, expect } from "vitest";
import {
  btxParams,
  BTX_MAINNET,
  BTX_RPC_POOL,
  BTX_CONF_TIERS,
  BTX_CONF_MAX,
  btxConfirmationsRequired,
} from "../src/chains/btx/network";
import {
  isAllowedBtxRpcOverride,
  isAllowedRpcOverride,
  isAllowedEthRpcOverride,
} from "../src/state/ui-store";

// BTX is added to the wallet as an ADDITIVE, opt-in chain. These tests pin the
// consensus-derived params (any drift = wrong/lost-fund addresses) and, just as
// importantly, prove BTX did not regress the existing Pearl/ETH surfaces.

describe("BTX network params (consensus-pinned)", () => {
  it("matches the BTX PQ spec (doc/btx-pqc-spec.md) + relay config", () => {
    expect(BTX_MAINNET.hrp).toBe("btx");
    expect(BTX_MAINNET.witnessVersion).toBe(2); // P2MR = witness v2 (Pearl P2TR = v1)
    expect(BTX_MAINNET.programBytes).toBe(32); // 32-byte Merkle root
    expect(BTX_MAINNET.decimals).toBe(8);
    expect(BTX_MAINNET.derivationPurpose).toBe(87); // m/87h P2MR descriptors
  });

  it("confirmation tiers match the relay (relay/src/btx/config.ts: 12/24/60)", () => {
    expect(BTX_CONF_TIERS.map((t) => [t.maxBtx, t.confs])).toEqual([
      [250, 12],
      [2500, 24],
    ]);
    expect(BTX_CONF_MAX).toBe(60);
    expect(btxConfirmationsRequired(1)).toBe(12);
    expect(btxConfirmationsRequired(250)).toBe(12);
    expect(btxConfirmationsRequired(251)).toBe(24);
    expect(btxConfirmationsRequired(2500)).toBe(24);
    expect(btxConfirmationsRequired(2501)).toBe(60);
    expect(btxConfirmationsRequired(1_000_000)).toBe(60);
  });
});

describe("BTX RPC override allowlist", () => {
  it("accepts the canonical BTX edge hosts and empty (use default)", () => {
    expect(isAllowedBtxRpcOverride("")).toBe(true);
    expect(isAllowedBtxRpcOverride("https://btx-rpc.pearlbridge.xyz/")).toBe(true);
    expect(isAllowedBtxRpcOverride("https://btx-rpc2.pearlbridge.xyz/")).toBe(true);
    expect(isAllowedBtxRpcOverride("https://btx-rpc3.pearlbridge.xyz/")).toBe(true);
  });

  it("rejects non-https and unknown hosts", () => {
    expect(isAllowedBtxRpcOverride("http://btx-rpc.pearlbridge.xyz/")).toBe(false);
    expect(isAllowedBtxRpcOverride("https://evil.example.com")).toBe(false);
  });

  it("btxParams applies an allowlisted override without touching codec params", () => {
    const p = btxParams("mainnet", "https://btx-rpc2.pearlbridge.xyz/");
    expect(p.rpcUrl).toBe("https://btx-rpc2.pearlbridge.xyz/");
    expect(p.rpcLabel).toBe("custom");
    expect(p.hrp).toBe("btx");
    expect(p.witnessVersion).toBe(2);
    expect(p.decimals).toBe(8);
  });

  it("btxParams falls back to canonical when override is not allowlisted (defense-in-depth)", () => {
    expect(btxParams("mainnet", "https://my-node.example/rpc")).toBe(BTX_MAINNET);
    expect(btxParams("mainnet", "   ")).toBe(BTX_MAINNET);
  });

  it("the RPC pool exactly matches the override allowlist (one invariant, two lists)", () => {
    for (const url of BTX_RPC_POOL) expect(isAllowedBtxRpcOverride(url)).toBe(true);
  });
});

describe("NO REGRESSION: BTX/Pearl/ETH allowlists are mutually disjoint", () => {
  const btx = "https://btx-rpc.pearlbridge.xyz/";
  const pearl = "https://rpc.pearlbridge.xyz/";
  const eth = "https://ethereum-rpc.publicnode.com";

  it("a BTX host is NOT accepted by the Pearl or ETH allowlists", () => {
    expect(isAllowedRpcOverride(btx)).toBe(false);
    expect(isAllowedEthRpcOverride(btx)).toBe(false);
  });

  it("Pearl + ETH hosts are still accepted by their own allowlists (unchanged)", () => {
    expect(isAllowedRpcOverride(pearl)).toBe(true);
    expect(isAllowedEthRpcOverride(eth)).toBe(true);
  });

  it("a Pearl/ETH host is NOT accepted by the BTX allowlist", () => {
    expect(isAllowedBtxRpcOverride(pearl)).toBe(false);
    expect(isAllowedBtxRpcOverride(eth)).toBe(false);
  });
});
