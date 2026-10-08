// v0.7 — address discovery: BIP-86 derivation on both branches (external 0,
// internal/change 1) and BIP-44 gap-limit discovery through the shared
// Pearl RPC client.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import {
  bip86Path,
  bip86AccountPath,
  branchPubkeys,
  publicAccountNode,
  pearlAccountPath,
  pearlBranchPath,
  pearlReceivePath,
  masterFromSeed,
  DISCOVERY_GAP_LIMIT,
  MAX_ADDRESSES_PER_BRANCH,
  MAX_DERIVE_BATCH,
  PEARL_COIN_TYPE,
} from "../src/crypto/hd";
import {
  clampBranchCount,
  pearlAddressSetFromAccount,
  pearlBranchAddressRange,
  validateDeriveRange,
} from "../src/crypto/pearl-addresses";
import { pearlAddressFromCompressedPubkey, encodeTaprootAddress, bip86Tweak } from "../src/chains/pearl/address";
import { pearlParams, type PearlNetworkParams } from "../src/chains/pearl/network";
import { fetchPrlUtxos } from "../src/services/pearl-rpc";
import { scanPrlWallet, MAX_EXTEND_PER_SCAN, type DeriveMoreAddresses } from "../src/services/discovery";
import type { PrlPoolScanProgress } from "../src/services/balances";
import { useUI } from "../src/state/ui-store";
import type { HdBranch } from "../src/crypto/hd";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
let master: HDKey;

beforeAll(async () => {
  master = masterFromSeed(await bip39.mnemonicToSeed(MNEMONIC));
});

// ─── Derivation vectors ──────────────────────────────────────────────────

// BIP-86 official test vectors (bip-0086.mediawiki, mnemonic "abandon ×11
// about"), coin type 0. The same parametrised path + tweak + bech32m code
// Pearl uses must reproduce them.
const BIP86_VECTORS: Array<{ branch: HdBranch; index: number; internalKey?: string; outputKey?: string; address: string }> = [
  {
    branch: 0,
    index: 0,
    internalKey: "cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115",
    outputKey: "a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
    address: "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
  },
  { branch: 0, index: 1, address: "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh" },
  { branch: 1, index: 0, address: "bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7" },
];
const BTC_PARAMS = { hrp: "bc" } as unknown as PearlNetworkParams;

// Oyster mainnet external addresses (tests/derivation.test.ts) — the new
// branch-aware helpers must reproduce them on branch 0.
const OYSTER_EXTERNAL = [
  "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
  "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm",
  "prl1pfrfqcvcmghjc3mpsazm9p9ktttyuewzlfmn40dzkwh0muejgkr3sfx9jwd",
];
// Pinned snapshot of the internal (change) branch m/86'/808276'/0'/1/0..2,
// cross-checked against @scure/btc-signer's p2tr encoder when captured.
const PEARL_INTERNAL_SNAPSHOT = [
  "prl1puwagcza86exfh3cx6ur08wq7njc32e66ep0zje7le6c7cak8lqeq655gqa",
  "prl1padwhxxehrnsjfw6dvfygwk7m8z486q75el0j097znrvss24434rsgfnu5u",
  "prl1pafzs04tn3qkgf4dcl7y5mh4arzvc3ks4nwewaffkdakps5vz73jswj4flx",
];

describe("BIP-86 derivation (parametrised by coin type)", () => {
  it("paths", () => {
    expect(bip86Path(0, 0, 0)).toBe("m/86'/0'/0'/0/0");
    expect(bip86Path(0, 1, 0)).toBe("m/86'/0'/0'/1/0");
    expect(pearlBranchPath(1, 7)).toBe(`m/86'/${PEARL_COIN_TYPE}'/0'/1/7`);
    expect(pearlReceivePath(3)).toBe(pearlBranchPath(0, 3));
    expect(pearlAccountPath()).toBe("m/86'/808276'/0'");
    expect(() => bip86Path(0, 2 as HdBranch, 0)).toThrow();
    expect(() => pearlBranchPath(0, -1)).toThrow();
    expect(() => pearlBranchPath(0, 0x80000000)).toThrow();
  });

  it("official BIP-86 vectors (coin type 0): /0/0 keys, /0/0, /0/1, /1/0 addresses", () => {
    for (const v of BIP86_VECTORS) {
      const child = master.derive(bip86Path(0, v.branch, v.index));
      const xOnly = child.publicKey!.slice(1);
      if (v.internalKey) expect(Buffer.from(xOnly).toString("hex")).toBe(v.internalKey);
      if (v.outputKey) expect(Buffer.from(bip86Tweak(xOnly)).toString("hex")).toBe(v.outputKey);
      expect(encodeTaprootAddress(bip86Tweak(xOnly), BTC_PARAMS)).toBe(v.address);
    }
  });

  it("official vectors via the public-account-node path (no private derivation per address)", () => {
    const acct = publicAccountNode(master, bip86AccountPath(0));
    expect(acct.privateKey).toBeNull();
    for (const v of BIP86_VECTORS) {
      const [pk] = branchPubkeys(acct, v.branch, v.index, 1);
      expect(pearlAddressFromCompressedPubkey(pk!, BTC_PARAMS)).toBe(v.address);
    }
  });

  it("coin type 808276 branch 0 reproduces oyster mainnet", () => {
    const acct = publicAccountNode(master, pearlAccountPath());
    expect(pearlBranchAddressRange(acct, "mainnet", 0, 0, 3)).toEqual(OYSTER_EXTERNAL);
  });

  it("coin type 808276 branch 1 is distinct and stable (snapshot)", () => {
    const acct = publicAccountNode(master, pearlAccountPath());
    const internal = pearlBranchAddressRange(acct, "mainnet", 1, 0, 3);
    expect(internal).toEqual(PEARL_INTERNAL_SNAPSHOT);
    const external = pearlBranchAddressRange(acct, "mainnet", 0, 0, 20);
    for (const a of internal) expect(external).not.toContain(a);
    // Independent encoder agrees.
    const net = { bech32: "prl", pubKeyHash: 0, scriptHash: 5, wif: 0x80 };
    internal.forEach((a, i) => {
      const k = master.derive(pearlBranchPath(1, i));
      expect(btc.p2tr(k.publicKey!.slice(1), undefined, net).address).toBe(a);
    });
  });

  it("public derivation == private derivation for ranges past index 20", () => {
    const acct = publicAccountNode(master, pearlAccountPath());
    const params = pearlParams("mainnet");
    const range = pearlBranchAddressRange(acct, "mainnet", 1, 40, 3);
    range.forEach((a, k) => {
      expect(pearlAddressFromCompressedPubkey(master.derive(pearlBranchPath(1, 40 + k)).publicKey!, params)).toBe(a);
    });
  });

  it("initial address set: 20 + 20, counts clamped to [20, cap]", () => {
    const acct = publicAccountNode(master, pearlAccountPath());
    const s = pearlAddressSetFromAccount(acct, "mainnet");
    expect(s.pearlPool).toHaveLength(20);
    expect(s.pearlChange).toHaveLength(20);
    expect(s.pearlPool.slice(0, 3)).toEqual(OYSTER_EXTERNAL);
    expect(s.pearlChange.slice(0, 3)).toEqual(PEARL_INTERNAL_SNAPSHOT);
    const t = pearlAddressSetFromAccount(acct, "mainnet", { external: 26, internal: 0 });
    expect(t.pearlPool).toHaveLength(26);
    expect(t.pearlChange).toHaveLength(20);
    expect(clampBranchCount(undefined)).toBe(20);
    expect(clampBranchCount(5)).toBe(20);
    expect(clampBranchCount(1e9)).toBe(MAX_ADDRESSES_PER_BRANCH);
    expect(clampBranchCount(1.5)).toBe(20);
  });

  it("derive-range validation bounds worker requests", () => {
    expect(() => validateDeriveRange(0, 20, 20)).not.toThrow();
    expect(() => validateDeriveRange(2, 0, 1)).toThrow("E_DERIVE_BAD_BRANCH");
    expect(() => validateDeriveRange(0, -1, 1)).toThrow("E_DERIVE_BAD_RANGE");
    expect(() => validateDeriveRange(0, 0, 0)).toThrow("E_DERIVE_BAD_RANGE");
    expect(() => validateDeriveRange(0, 0, MAX_DERIVE_BATCH + 1)).toThrow("E_DERIVE_BAD_RANGE");
    expect(() => validateDeriveRange(1, MAX_ADDRESSES_PER_BRANCH - 1, 2)).toThrow("E_DERIVE_BAD_RANGE");
  });
});

// ─── RPC mock: btcd-like searchrawtransactions ──────────────────────────

const SCRIPT = "5120" + "11".repeat(32);
interface MockTx {
  txid: string;
  vin: Array<{ txid?: string; vout?: number }>;
  vout: Array<{ value: number; n: number; scriptPubKey: { address: string; hex: string } }>;
}
let txSeq = 0;
function txid(): string {
  txSeq++;
  return txSeq.toString(16).padStart(64, "0");
}
function fund(addr: string, value: number): MockTx {
  return { txid: txid(), vin: [], vout: [{ value, n: 0, scriptPubKey: { address: addr, hex: SCRIPT } }] };
}
function spend(prev: MockTx, to = "prl1pelsewhere"): MockTx {
  return { txid: txid(), vin: [{ txid: prev.txid, vout: 0 }], vout: [{ value: 0.1, n: 0, scriptPubKey: { address: to, hex: SCRIPT } }] };
}

const searched: string[] = [];
/** searchrawtransactions over `history`; like btcd, a page with no
 *  results is the -5 "No information available about address" error. */
function stubChain(history: Record<string, MockTx[]>, fail: Set<string> = new Set()) {
  searched.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      if (body.method !== "searchrawtransactions") {
        return new Response(JSON.stringify({ result: null, error: { code: -32601, message: "nope" } }));
      }
      const addr = body.params[0] as string;
      const skip = body.params[2] as number;
      const count = body.params[3] as number;
      searched.push(addr);
      if (fail.has(addr)) return new Response("", { status: 503 });
      const page = (history[addr] ?? []).slice(skip, skip + count);
      if (page.length === 0) {
        return new Response(
          JSON.stringify({ result: null, error: { code: -5, message: "No information available about address" } }),
        );
      }
      return new Response(JSON.stringify({ result: page, error: null }));
    }),
  );
}

const name = (b: HdBranch, i: number) => `${b === 0 ? "ext" : "int"}-${i}`;
const list = (b: HdBranch, n: number) => Array.from({ length: n }, (_, i) => name(b, i));
function deriver() {
  const calls: Array<[HdBranch, number, number]> = [];
  const fn: DeriveMoreAddresses = async (b, start, count) => {
    calls.push([b, start, count]);
    return Array.from({ length: count }, (_, k) => name(b, start + k));
  };
  return { fn, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchPrlUtxos — used flag", () => {
  it("-5 on the first page → unused; any history (even fully spent) → used", async () => {
    const f = fund("a", 1);
    stubChain({ a: [f, spend(f)] });
    const unused = await fetchPrlUtxos("b");
    expect(unused).toMatchObject({ utxos: [], used: false, degraded: false });
    const spent = await fetchPrlUtxos("a");
    expect(spent.used).toBe(true);
    expect(spent.utxos).toEqual([]);
  });

  it("history ending exactly on a page boundary keeps earlier pages (-5 on page 2)", async () => {
    const txs = Array.from({ length: 100 }, () => fund("full", 0.01));
    stubChain({ full: txs });
    const r = await fetchPrlUtxos("full");
    expect(r.used).toBe(true);
    expect(r.utxos).toHaveLength(100);
    expect(r.utxos.reduce((s, u) => s + u.valueGrains, 0n)).toBe(100_000_000n);
  });
});

// ─── Gap-limit discovery ─────────────────────────────────────────────────

describe("scanPrlWallet — gap-limit discovery on both branches", () => {
  it("extends branch 0 across a used address at 25 and finds branch 1 index 3", async () => {
    const f10 = fund(name(0, 10), 1);
    stubChain({
      [name(0, 10)]: [f10, spend(f10)], // used, now empty
      [name(0, 25)]: [fund(name(0, 25), 2)],
      [name(1, 3)]: [fund(name(1, 3), 4)],
    });
    const d = deriver();
    const progress: PrlPoolScanProgress[] = [];
    const scan = await scanPrlWallet(
      { external: list(0, 20), internal: list(1, 20) },
      { deriveMore: d.fn, onProgress: (p) => progress.push(p) },
    );

    expect(scan.discovery).toEqual({ complete: true, lastUsed: [25, 3], reasons: [] });
    // 20 unused past the last used index on each branch.
    expect(scan.discovered.external).toEqual(list(0, 46));
    expect(scan.discovered.internal).toEqual(list(1, 24));
    expect(d.calls).toEqual([
      [0, 20, 11],
      [1, 20, 4],
      [0, 31, 15],
    ]);
    // Every derived address walked exactly once.
    expect(scan.pool).toHaveLength(70);
    expect(new Set(searched).size).toBe(70);
    expect(scan.source).toBe("live");
    expect(scan.grains).toBe(600_000_000n);
    const spend0 = scan.spendable!.utxos.map((u) => [u.branch, u.index, u.valueGrains]);
    expect(spend0).toEqual(expect.arrayContaining([[0, 25, 200_000_000n], [1, 3, 400_000_000n]]));
    expect(spend0).toHaveLength(2);
    // refs line up with pool.
    scan.refs.forEach((r, i) => expect(scan.pool[i]).toBe(name(r.branch, r.index)));
    // Progress: done reaches the grown total; total grows as discovery extends.
    expect(progress.at(-1)!.done).toBe(70);
    expect(progress.at(-1)!.total).toBe(70);
    expect(progress[0]!.total).toBe(40);
    for (const p of progress) expect(p.ref.address).toBe(scan.pool[p.index]);
  });

  it("standard BIP-44 stop: 20 unused from the start ends a branch (index 25 alone is not found)", async () => {
    stubChain({ [name(0, 25)]: [fund(name(0, 25), 2)] });
    const d = deriver();
    const scan = await scanPrlWallet({ external: list(0, 20), internal: list(1, 20) }, { deriveMore: d.fn });
    expect(d.calls).toEqual([]);
    expect(scan.discovery.complete).toBe(true);
    expect(scan.grains).toBe(0n);
  });

  it("previously discovered (persisted) addresses are always walked, never shrunk", async () => {
    stubChain({ [name(0, 40)]: [fund(name(0, 40), 1)] });
    const d = deriver();
    const scan = await scanPrlWallet({ external: list(0, 41), internal: list(1, 20) }, { deriveMore: d.fn });
    expect(scan.grains).toBe(100_000_000n);
    expect(scan.discovered.external).toHaveLength(61);
    expect(d.calls).toEqual([[0, 41, 20]]);
  });

  it("an unreadable address never drives extension; scan is partial with no spendable set", async () => {
    stubChain({ [name(0, 19)]: [fund(name(0, 19), 1)] }, new Set([name(0, 19)]));
    const d = deriver();
    const scan = await scanPrlWallet({ external: list(0, 20), internal: list(1, 20) }, { deriveMore: d.fn });
    expect(d.calls).toEqual([]);
    expect(scan.discovery.complete).toBe(false);
    expect(scan.discovery.reasons).toContain("rpc-failures");
    expect(scan.source).toBe("partial");
    expect(scan.spendable).toBeNull();
  });

  it("hard cap per branch: stops at maxPerBranch and reports partial", async () => {
    stubChain({ [name(0, 5)]: [fund(name(0, 5), 1)], [name(0, 20)]: [fund(name(0, 20), 1)] });
    const d = deriver();
    const scan = await scanPrlWallet(
      { external: list(0, 20), internal: list(1, 20) },
      { deriveMore: d.fn, maxPerBranch: 30 },
    );
    expect(scan.discovered.external).toHaveLength(30);
    expect(scan.discovery.reasons).toContain("cap");
    expect(scan.source).toBe("partial");
    expect(scan.spendable).toBeNull();
    expect(scan.grains).toBe(200_000_000n);
  });

  it("default cap is 1000 per branch and derivation is batched", async () => {
    // Every external address used → walk runs to the cap (with the
    // per-scan extension bound lifted; see the next test for the default).
    const usedAll: Record<string, MockTx[]> = {};
    for (let i = 0; i < 1000; i++) usedAll[name(0, i)] = [fund(name(0, i), 0.00001)];
    stubChain(usedAll);
    const d = deriver();
    const scan = await scanPrlWallet(
      { external: list(0, 20), internal: list(1, 20) },
      { deriveMore: d.fn, maxExtendPerScan: MAX_ADDRESSES_PER_BRANCH },
    );
    expect(scan.discovered.external).toHaveLength(MAX_ADDRESSES_PER_BRANCH);
    expect(scan.discovery.reasons).toContain("cap");
    for (const [, , count] of d.calls) expect(count).toBeLessThanOrEqual(MAX_DERIVE_BATCH);
    expect(DISCOVERY_GAP_LIMIT).toBe(20);
  });

  it("one scan extends a branch by at most MAX_EXTEND_PER_SCAN; later scans continue (review S17)", async () => {
    // A misbehaving RPC that reports every address as used.
    const usedAll: Record<string, MockTx[]> = {};
    for (let i = 0; i < 1000; i++) usedAll[name(0, i)] = [fund(name(0, i), 0.00001)];
    stubChain(usedAll);
    const d = deriver();
    const first = await scanPrlWallet({ external: list(0, 20), internal: list(1, 20) }, { deriveMore: d.fn });
    expect(MAX_EXTEND_PER_SCAN).toBe(200);
    expect(first.discovered.external).toHaveLength(20 + MAX_EXTEND_PER_SCAN);
    expect(first.discovery.reasons).toEqual(["extension-limit"]);
    expect(first.discovery.complete).toBe(false);
    expect(first.source).toBe("partial");
    expect(first.spendable).toBeNull();
    // The persisted list is the starting point of the next scan.
    const second = await scanPrlWallet(first.discovered, { deriveMore: d.fn });
    expect(second.discovered.external).toHaveLength(20 + 2 * MAX_EXTEND_PER_SCAN);
  });

  it("without a deriver the known set is scanned and discovery reports incomplete", async () => {
    stubChain({ [name(1, 15)]: [fund(name(1, 15), 1)] });
    const scan = await scanPrlWallet({ external: list(0, 20), internal: list(1, 20) });
    expect(scan.grains).toBe(100_000_000n);
    expect(scan.discovery.reasons).toEqual(["no-deriver"]);
    expect(scan.source).toBe("partial");
  });

  it("a failing deriver is reported, not retried forever", async () => {
    stubChain({ [name(1, 15)]: [fund(name(1, 15), 1)] });
    const deriveMore = vi.fn(async () => {
      throw new Error("E_LOCKED");
    });
    const scan = await scanPrlWallet({ external: list(0, 20), internal: list(1, 20) }, { deriveMore });
    expect(deriveMore).toHaveBeenCalledTimes(1);
    expect(scan.discovery.reasons).toEqual(["derive-failed"]);
    expect(scan.grains).toBe(100_000_000n);
  });

  it("rejects a deriver that returns the wrong number of addresses", async () => {
    stubChain({ [name(0, 15)]: [fund(name(0, 15), 1)] });
    const scan = await scanPrlWallet(
      { external: list(0, 20), internal: list(1, 20) },
      { deriveMore: async () => ["only-one"] },
    );
    expect(scan.discovery.reasons).toEqual(["derive-failed"]);
    expect(scan.discovered.external).toEqual(list(0, 20));
  });
});
