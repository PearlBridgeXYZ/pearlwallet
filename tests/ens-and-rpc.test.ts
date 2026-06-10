// v0.4.1 — native Ethereum address support: EIP-55 checksum, ENS
// resolution, and the diversified RPC chain / preset allowlist.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEthAddress, validEth } from "../src/lib/validate";
import {
  ETH_RPC_DEFAULTS,
  ETH_RPC_PRESETS,
} from "../src/chains/ethereum/network";
import { isAllowedEthRpcOverride } from "../src/state/ui-store";

describe("normalizeEthAddress — EIP-55 checksum", () => {
  const lower = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const checksummed = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  it("checksums an all-lowercase address (no checksum to verify)", () => {
    expect(normalizeEthAddress(lower)).toBe(checksummed);
  });

  it("accepts and returns a correctly-checksummed address", () => {
    expect(normalizeEthAddress(checksummed)).toBe(checksummed);
  });

  it("REJECTS a mixed-case address with a bad checksum (typo signal)", () => {
    // flip one char's case in the checksummed form
    const bad = "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    expect(normalizeEthAddress(bad)).toBeNull();
    // viem's isAddress is strict-by-default in v2, so validEth also rejects
    // it — normalizeEthAddress additionally returns the canonical form for
    // valid input.
    expect(validEth(bad)).toBe(false);
  });

  it("rejects non-addresses", () => {
    for (const bad of ["", "0x123", "not-an-address", "0xZZZ", lower + "00"]) {
      expect(normalizeEthAddress(bad)).toBeNull();
    }
  });
});

describe("RPC chain + presets", () => {
  it("default mainnet chain is diversified across ≥3 independent providers", () => {
    const hosts = ETH_RPC_DEFAULTS.mainnet.map((u) => new URL(u).host);
    expect(hosts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(hosts).size).toBe(hosts.length); // no duplicates
    expect(hosts[0]).toBe("ethereum-rpc.publicnode.com"); // PublicNode primary
  });

  it("every preset URL is on the override allowlist (so a chosen preset never CSP-breaks)", () => {
    for (const p of ETH_RPC_PRESETS) {
      expect(isAllowedEthRpcOverride(p.url)).toBe(true);
    }
  });

  it("MEW and PublicNode are both offered (G ask 2026-06-10)", () => {
    const labels = ETH_RPC_PRESETS.map((p) => p.label.toLowerCase());
    expect(labels.some((l) => l.includes("mew"))).toBe(true);
    expect(labels.some((l) => l.includes("publicnode"))).toBe(true);
  });

  it("allowlist still rejects an arbitrary host and non-https", () => {
    expect(isAllowedEthRpcOverride("https://evil.example.com")).toBe(false);
    expect(isAllowedEthRpcOverride("http://ethereum-rpc.publicnode.com")).toBe(false);
    expect(isAllowedEthRpcOverride("")).toBe(true); // empty = use defaults
  });
});

describe("ENS resolution", () => {
  // Mock the eth client so we don't hit the network. resolveEnsName must be
  // mainnet-only, cache, and never throw.
  const getEnsAddress = vi.fn();
  const getEnsName = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    getEnsAddress.mockReset();
    getEnsName.mockReset();
  });

  afterEach(() => {
    vi.doUnmock("../src/chains/ethereum/rpc");
  });

  async function loadEns() {
    vi.doMock("../src/chains/ethereum/rpc", () => ({
      ethClient: () => ({ getEnsAddress, getEnsName }),
    }));
    const mod = await import("../src/services/ens");
    mod.__clearEnsCachesForTest();
    return mod;
  }

  it("looksLikeEnsName distinguishes names from addresses", async () => {
    const { looksLikeEnsName } = await loadEns();
    expect(looksLikeEnsName("vitalik.eth")).toBe(true);
    expect(looksLikeEnsName("foo.bar.eth")).toBe(true);
    expect(looksLikeEnsName("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(false);
    expect(looksLikeEnsName("plainstring")).toBe(false);
  });

  it("resolves a name on mainnet and caches the result", async () => {
    const { resolveEnsName } = await loadEns();
    getEnsAddress.mockResolvedValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    const a1 = await resolveEnsName("vitalik.eth", "mainnet");
    expect(a1).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    const a2 = await resolveEnsName("vitalik.eth", "mainnet");
    expect(a2).toBe(a1);
    expect(getEnsAddress).toHaveBeenCalledTimes(1); // cached
  });

  it("returns null on non-mainnet without calling the RPC", async () => {
    const { resolveEnsName } = await loadEns();
    expect(await resolveEnsName("vitalik.eth", "sepolia")).toBeNull();
    expect(getEnsAddress).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when the RPC fails", async () => {
    const { resolveEnsName } = await loadEns();
    getEnsAddress.mockRejectedValue(new Error("rpc down"));
    expect(await resolveEnsName("broken.eth", "mainnet")).toBeNull();
  });

  it("resolveEthDestination handles names, checksummed addresses, and bad checksums", async () => {
    const { resolveEthDestination } = await loadEns();
    getEnsAddress.mockResolvedValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");

    const byName = await resolveEthDestination("vitalik.eth", "mainnet");
    expect(byName).toEqual({
      ok: true,
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      ensName: "vitalik.eth",
    });

    const byAddr = await resolveEthDestination(
      "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      "mainnet",
    );
    expect(byAddr.ok && byAddr.address).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(byAddr.ok && byAddr.ensName).toBeNull();

    const badChecksum = await resolveEthDestination(
      "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "mainnet",
    );
    expect(badChecksum.ok).toBe(false);

    const badName = await resolveEthDestination("nope.eth", "sepolia");
    expect(badName.ok).toBe(false);
  });
});
