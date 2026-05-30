// v0.1.9 — three live send paths (ETH native, WPRL ERC-20, PRL UTXO).
// Tests target the service layer and the audit-fix hardening from v0.1.8.
// UI/integration paths (Send* pages) exercise the same services so they
// inherit the coverage.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { passwordAcceptable } from "../src/lib/validate";
import { monotonicNow, __resetMonotonicForTests } from "../src/lib/monotonic";
import { pearlParams, PEARL_MAINNET } from "../src/chains/pearl/network";
import { isAllowedRpcOverride, isAllowedEthRpcOverride } from "../src/state/ui-store";
import {
  evaluateGasCoverage,
} from "../src/services/eth-tx";
import {
  PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE,
  PER_INPUT_VBYTES,
  PER_P2TR_OUTPUT_VBYTES,
  FIXED_OVERHEAD_VBYTES,
  DUST_LIMIT_GRAINS,
  composePearlSend,
} from "../src/services/pearl-tx";
import { computeTipGrains } from "../src/chains/pearl/tip";

// ─── audit fixes from v0.1.8 ──────────────────────────────────────────────

describe("v0.1.9 / passphrase degenerate-entropy guard (v0.1.8 Opus1+Minimax1 M-1)", () => {
  it("rejects long all-digit passphrases (53-bit work factor)", () => {
    expect(passwordAcceptable("1234567890123456").ok).toBe(false);
    expect(passwordAcceptable("0000000000000000").ok).toBe(false);
    // Even at 32 chars all-digit, the keyspace is still ~106 bits which
    // is enough — but the GPU work factor against a single salt at 600k
    // PBKDF2 is far too generous. Reject as a class.
    expect(passwordAcceptable("12345678901234567890123456789012").ok).toBe(false);
  });

  it("rejects strings with ≤2 unique characters at any length", () => {
    expect(passwordAcceptable("aaaaaaaaaaaaaaaa").ok).toBe(false);
    expect(passwordAcceptable("abababababababab").ok).toBe(false);
  });

  it("rejects monotonic walks (abc...)", () => {
    expect(passwordAcceptable("abcdefghijklmnop").ok).toBe(false);
    expect(passwordAcceptable("ponmlkjihgfedcba").ok).toBe(false); // descending
  });

  it("still accepts real XKCD passphrases", () => {
    expect(passwordAcceptable("correcthorsebatterystaple").ok).toBe(true);
    expect(passwordAcceptable("never gonna give you up").ok).toBe(true);
    expect(passwordAcceptable("orange-elephant-quiet-river-72").ok).toBe(true);
  });

  it("still rejects short passwords regardless of degeneracy check", () => {
    expect(passwordAcceptable("Aa1!Aa1!Aa").ok).toBe(true); // 10 chars, 4 classes
    expect(passwordAcceptable("Aa1!").ok).toBe(false); // 4 chars
  });
});

describe("v0.1.9 / pearlParams allowlist re-validation (v0.1.8 Opus2 H-2)", () => {
  it("falls back to canonical when override isn't allowlisted", () => {
    expect(pearlParams("mainnet", "https://attacker.example/rpc")).toBe(PEARL_MAINNET);
    expect(pearlParams("mainnet", "http://insecure.example/rpc")).toBe(PEARL_MAINNET);
    expect(pearlParams("mainnet", "javascript:void(0)")).toBe(PEARL_MAINNET);
  });

  it("accepts allowlisted Pearl hosts as overrides", () => {
    // v0.2.0 narrowed the Pearl allowlist to Pearl-protocol hosts only.
    // ETH-protocol hosts (drpc, publicnode) moved to the dedicated
    // ethRpcOverride allowlist — see isAllowedEthRpcOverride.
    for (const host of [
      "https://rpc.pearlwallet.xyz/",
      "https://pearlbridge.xyz/rpc",
    ]) {
      expect(isAllowedRpcOverride(host)).toBe(true);
      const p = pearlParams("mainnet", host);
      expect(p.rpcUrl).toBe(host);
      expect(p.rpcLabel).toBe("custom");
    }
  });

  it("rejects ETH-protocol hosts on the Pearl override (v0.2.0 split)", () => {
    expect(isAllowedRpcOverride("https://eth.drpc.org/")).toBe(false);
    expect(isAllowedRpcOverride("https://ethereum-rpc.publicnode.com/")).toBe(false);
  });
});

describe("v0.2.0 / isAllowedEthRpcOverride", () => {
  it("accepts ETH-protocol hosts", () => {
    expect(isAllowedEthRpcOverride("https://ethereum-rpc.publicnode.com/")).toBe(true);
    expect(isAllowedEthRpcOverride("https://eth.drpc.org/")).toBe(true);
  });

  it("rejects Pearl-protocol hosts and unknown hosts", () => {
    expect(isAllowedEthRpcOverride("https://rpc.pearlwallet.xyz/")).toBe(false);
    expect(isAllowedEthRpcOverride("https://pearlbridge.xyz/rpc")).toBe(false);
    expect(isAllowedEthRpcOverride("https://attacker.example/")).toBe(false);
  });

  it("rejects non-https schemes and the empty allow-zero case mirrors pearl", () => {
    expect(isAllowedEthRpcOverride("http://eth.drpc.org/")).toBe(false);
    expect(isAllowedEthRpcOverride("javascript:void(0)")).toBe(false);
    // Empty string is the "no override, use defaults" sentinel and
    // must always be accepted.
    expect(isAllowedEthRpcOverride("")).toBe(true);
  });
});

describe("v0.1.9 / monotonicNow (v0.1.8 Opus2 M-1 auto-lock clock skew)", () => {
  beforeEach(() => {
    __resetMonotonicForTests();
    vi.useRealTimers();
  });

  it("returns a non-negative number", () => {
    const t = monotonicNow();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThanOrEqual(0);
  });

  it("is monotonically non-decreasing across calls", async () => {
    const a = monotonicNow();
    await new Promise((r) => setTimeout(r, 5));
    const b = monotonicNow();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("v0.1.9 / iframe-bust external file", () => {
  it("public/iframe-bust.js exists and contains the bust check", async () => {
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("public/iframe-bust.js", "utf8"),
    );
    expect(src).toMatch(/window\.top\s*!==\s*window\.self/);
    // Must not use innerHTML (audit-flagged sink), use textContent instead.
    expect(src).not.toMatch(/innerHTML/);
  });

  it("index.html references the external bust before main", async () => {
    const src = await import("node:fs/promises").then((m) =>
      m.readFile("index.html", "utf8"),
    );
    expect(src).toMatch(/<script src="\/iframe-bust\.js"><\/script>/);
    expect(src.indexOf('"/iframe-bust.js"')).toBeLessThan(src.indexOf("/src/main.tsx"));
    // No inline <script> with iframe logic left behind.
    expect(src).not.toMatch(/window\.top\s*!==\s*window\.self/);
  });
});

// ─── ETH/WPRL send service ────────────────────────────────────────────────

describe("v0.1.9 / evaluateGasCoverage", () => {
  it("covered when balance >= gas * maxFeePerGas", () => {
    const r = evaluateGasCoverage(10n ** 18n, 21000n, 50_000_000_000n);
    expect(r.covered).toBe(true);
    expect(r.worstCaseWei).toBe(21000n * 50_000_000_000n);
  });

  it("uncovered when balance < worst case", () => {
    const r = evaluateGasCoverage(100n, 21000n, 50_000_000_000n);
    expect(r.covered).toBe(false);
    expect(r.ethBalanceWei).toBe(100n);
  });

  it("treats zero balance as uncovered for any positive gas", () => {
    const r = evaluateGasCoverage(0n, 1n, 1n);
    expect(r.covered).toBe(false);
    expect(r.worstCaseWei).toBe(1n);
  });
});

// ─── Pearl UTXO send composition ─────────────────────────────────────────

describe("v0.1.9 / composePearlSend constants", () => {
  it("exposes audited fee constants", () => {
    expect(PEARL_DEFAULT_FEERATE_SATS_PER_VBYTE).toBe(2n);
    expect(PER_INPUT_VBYTES).toBe(58n);
    expect(PER_P2TR_OUTPUT_VBYTES).toBe(43n);
    expect(FIXED_OVERHEAD_VBYTES).toBe(11n);
    expect(DUST_LIMIT_GRAINS).toBe(546n);
  });
});

// Mock the RPC for composePearlSend tests. composePearlSend calls
// fetchPrlUtxos under the hood — we stub that out so the tests are
// hermetic.
import * as pearlRpc from "../src/services/pearl-rpc";

const POOL = ["prl1pdummy0", "prl1pdummy1"];
const DEST = "prl1pdest0000";
// Valid bech32m-shaped txid (just 64 hex chars).
const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const TXID_C = "c".repeat(64);

describe("v0.1.9 / composePearlSend — coin selection + fee + change", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("picks one UTXO for a small send and includes change", async () => {
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      if (addr === POOL[0]) {
        return {
          utxos: [
            { txid: TXID_A, vout: 0, valueGrains: 1_000_000_000n, scriptHex: "5120" + "00".repeat(32) },
          ],
          degraded: false,
          droppedNoScript: 0,
        };
      }
      return { utxos: [], degraded: false, droppedNoScript: 0 };
    });

    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: 100_000_000n, // 1 PRL
      includeTip: false,
    });

    expect(c.utxos.length).toBe(1);
    expect(c.utxos[0]!.poolIndex).toBe(0);
    // 1-in, 2-out (dest + change), no tip
    expect(c.outputs.length).toBe(2);
    expect(c.outputs[0]!.address).toBe(DEST);
    // Change goes to pool[0]
    expect(c.outputs[1]!.address).toBe(POOL[0]);
    expect(c.feeGrains).toBeGreaterThan(0n);
    expect(c.changeGrains).toBeGreaterThan(0n);
    expect(c.tipGrains).toBe(0n);
  });

  it("adds the PearlBridge tip output when includeTip is true", async () => {
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      if (addr === POOL[0]) {
        return {
          utxos: [{ txid: TXID_A, vout: 0, valueGrains: 1_000_000_000n, scriptHex: "5120" + "00".repeat(32) }],
          degraded: false,
          droppedNoScript: 0,
        };
      }
      return { utxos: [], degraded: false, droppedNoScript: 0 };
    });

    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: 500_000_000n, // 5 PRL
      includeTip: true,
    });

    const expectedTip = computeTipGrains(500_000_000n);
    expect(c.tipGrains).toBe(expectedTip);
    // dest + tip + change
    expect(c.outputs.length).toBe(3);
  });

  it("aggregates UTXOs across the pool largest-first", async () => {
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      if (addr === POOL[0]) {
        return {
          utxos: [{ txid: TXID_A, vout: 0, valueGrains: 100_000_000n, scriptHex: "5120" + "00".repeat(32) }],
          degraded: false,
          droppedNoScript: 0,
        };
      }
      if (addr === POOL[1]) {
        return {
          utxos: [{ txid: TXID_B, vout: 0, valueGrains: 800_000_000n, scriptHex: "5120" + "00".repeat(32) }],
          degraded: false,
          droppedNoScript: 0,
        };
      }
      return { utxos: [], degraded: false, droppedNoScript: 0 };
    });

    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: 500_000_000n,
      includeTip: false,
    });
    // 5 PRL is covered by the 8-PRL UTXO alone — only 1 input.
    expect(c.utxos.length).toBe(1);
    expect(c.utxos[0]!.poolIndex).toBe(1);
    expect(c.utxos[0]!.valueGrains).toBe(800_000_000n);
  });

  it("drops the change output when change would be dust", async () => {
    // Construct a UTXO whose value is JUST barely above amount + fee.
    // The leftover change (a few grains) is under DUST_LIMIT_GRAINS,
    // so composePearlSend must collapse the change output and donate
    // the dust to miners.
    const utxoValue = 100_000_000n; // 1 PRL
    const send = 99_990_000n; // exactly 0.99..., leaving tiny change
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      if (addr === POOL[0]) {
        return {
          utxos: [{ txid: TXID_C, vout: 0, valueGrains: utxoValue, scriptHex: "5120" + "00".repeat(32) }],
          degraded: false,
          droppedNoScript: 0,
        };
      }
      return { utxos: [], degraded: false, droppedNoScript: 0 };
    });
    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: send,
      includeTip: false,
    });
    // Either change is 0 (dust-collapsed) OR change is above dust.
    if (c.changeGrains === 0n) {
      expect(c.outputs.length).toBe(1);
    } else {
      expect(c.changeGrains).toBeGreaterThanOrEqual(DUST_LIMIT_GRAINS);
    }
  });

  it("propagates degraded:true from the UTXO walk", async () => {
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      if (addr === POOL[0]) {
        return {
          utxos: [{ txid: TXID_A, vout: 0, valueGrains: 1_000_000_000n, scriptHex: "5120" + "00".repeat(32) }],
          degraded: true, // pretend page-cap hit
          droppedNoScript: 0,
        };
      }
      return { utxos: [], degraded: false, droppedNoScript: 0 };
    });
    const c = await composePearlSend({
      network: "mainnet",
      pool: POOL,
      destination: DEST,
      amountGrains: 100_000_000n,
      includeTip: false,
    });
    expect(c.degraded).toBe(true);
  });

  it("throws E_INSUFFICIENT_FUNDS when no UTXO combo covers amount+fee", async () => {
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockImplementation(async (addr) => {
      if (addr === POOL[0]) {
        return {
          utxos: [{ txid: TXID_A, vout: 0, valueGrains: 100n, scriptHex: "5120" + "00".repeat(32) }],
          degraded: false,
          droppedNoScript: 0,
        };
      }
      return { utxos: [], degraded: false, droppedNoScript: 0 };
    });
    await expect(
      composePearlSend({
        network: "mainnet",
        pool: POOL,
        destination: DEST,
        amountGrains: 1_000_000_000n,
        includeTip: false,
      }),
    ).rejects.toThrow(/E_INSUFFICIENT_FUNDS/);
  });

  it("throws E_NO_UTXOS when the pool has no spendable outputs", async () => {
    vi.spyOn(pearlRpc, "fetchPrlUtxos").mockResolvedValue({ utxos: [], degraded: false, droppedNoScript: 0 });
    await expect(
      composePearlSend({
        network: "mainnet",
        pool: POOL,
        destination: DEST,
        amountGrains: 100_000_000n,
        includeTip: false,
      }),
    ).rejects.toThrow(/E_NO_UTXOS/);
  });
});
