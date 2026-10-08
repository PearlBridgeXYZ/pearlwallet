// v0.7 — keystore address persistence across the discovery change.
//
// The persisted shape gains one OPTIONAL, non-indexed field
// (publicData.pearlChangePool); no Dexie version or STORAGE_KEY bump.
// Records written before v0.7 (20 external addresses, no change pool) must
// unlock unchanged and be upgraded in place; discovered extensions persist
// and are re-derived (never shrunk) on the next unlock.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import type { HDKey } from "@scure/bip32";
import { masterFromSeed, pearlAccountPath, publicAccountNode } from "../src/crypto/hd";
import { pearlAddressSetFromAccount, pearlBranchAddressRange, validateDeriveRange } from "../src/crypto/pearl-addresses";
import type { KeystoreRecord } from "../src/storage/db";

// In-memory keystore table.
const mem: { rec: KeystoreRecord | undefined; saves: number } = { rec: undefined, saves: 0 };
vi.mock("../src/storage/db", () => ({
  db: { keystore: { put: async (r: KeystoreRecord) => { mem.rec = structuredClone(r); } } },
  loadKeystore: async () => (mem.rec ? structuredClone(mem.rec) : undefined),
  saveKeystore: async (r: KeystoreRecord) => {
    mem.saves++;
    mem.rec = structuredClone(r);
  },
  wipeKeystore: async () => {
    mem.rec = undefined;
  },
}));

import { useWallet, storedBranchCounts, isPrefixExtension } from "../src/state/wallet-store";
import * as workerClient from "../src/crypto/worker-client";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
let acct: HDKey;
let ext60: string[];
let int60: string[];
const BLOB = {
  version: 1 as const,
  kdf: "PBKDF2-SHA256" as const,
  kdfIterations: 1,
  kdfSalt: "00",
  cipher: "AES-256-GCM" as const,
  iv: "00",
  aad: "00",
  ciphertext: "00",
};
const ETH = "0x0000000000000000000000000000000000000001";

/** Emulates the worker's unlock / derivePearlAddresses with the same pure
 *  derivation module the worker uses. */
const unlockCounts: unknown[] = [];
function mockWorker() {
  vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "unlock") {
      unlockCounts.push(args.counts);
      const s = pearlAddressSetFromAccount(acct, "mainnet", args.counts as never);
      return { addresses: { pearl: s.pearlPool[0], pearlPool: s.pearlPool, pearlChange: s.pearlChange, eth: ETH } };
    }
    if (cmd === "derivePearlAddresses") {
      validateDeriveRange(args.branch, args.start, args.count);
      return { addresses: pearlBranchAddressRange(acct, "mainnet", args.branch as 0 | 1, args.start as number, args.count as number) };
    }
    if (cmd === "lock") return { ok: true };
    throw new Error(`unexpected ${cmd}`);
  }) as never);
}

function legacyRecord(extCount: number, intCount?: number): KeystoreRecord {
  return {
    id: "primary",
    version: 1,
    blob: BLOB,
    publicData: {
      pearlAddress: ext60[0]!,
      pearlAddressPool: ext60.slice(0, extCount),
      ...(intCount !== undefined ? { pearlChangePool: int60.slice(0, intCount) } : {}),
      ethAddress: ETH,
      pearlNetwork: "mainnet",
      ethNetwork: "mainnet",
      createdAt: 1,
    },
  };
}

beforeAll(async () => {
  acct = publicAccountNode(masterFromSeed(await bip39.mnemonicToSeed(MNEMONIC)), pearlAccountPath());
  ext60 = pearlBranchAddressRange(acct, "mainnet", 0, 0, 60);
  int60 = pearlBranchAddressRange(acct, "mainnet", 1, 0, 60);
});

beforeEach(() => {
  vi.restoreAllMocks();
  mem.rec = undefined;
  mem.saves = 0;
  unlockCounts.length = 0;
  useWallet.setState({ status: "locked", addresses: null, blob: BLOB, pearlNetwork: "mainnet" });
  mockWorker();
});

describe("unlock — backward compatible keystore records", () => {
  it("pre-v0.7 record (20 external, no change pool): unlocks, external unchanged, change pool added", async () => {
    mem.rec = legacyRecord(20);
    const before = structuredClone(mem.rec);
    const { addresses } = await useWallet.getState().unlock("pw");
    expect(unlockCounts[0]).toEqual({ external: 20, internal: 0 });
    expect(addresses.pearlPool).toEqual(before.publicData.pearlAddressPool);
    expect(addresses.pearl).toBe(before.publicData.pearlAddress);
    expect(addresses.pearlChange).toEqual(int60.slice(0, 20));
    // Upgraded in place: same blob, same external list, + change pool.
    expect(mem.rec!.blob).toEqual(before.blob);
    expect(mem.rec!.publicData.pearlAddressPool).toEqual(before.publicData.pearlAddressPool);
    expect(mem.rec!.publicData.pearlChangePool).toEqual(int60.slice(0, 20));
    expect(mem.rec!.publicData.createdAt).toBe(1);
    expect(mem.saves).toBe(1);
  });

  it("pre-multi-address record (no pool at all) still unlocks to 20 + 20", async () => {
    const r = legacyRecord(20);
    delete r.publicData.pearlAddressPool;
    mem.rec = r;
    const { addresses } = await useWallet.getState().unlock("pw");
    expect(addresses.pearlPool).toEqual(ext60.slice(0, 20));
    expect(mem.rec!.publicData.pearlAddressPool).toEqual(ext60.slice(0, 20));
    expect(mem.rec!.publicData.pearlChangePool).toEqual(int60.slice(0, 20));
  });

  it("v0.7 record with discovered extents re-derives exactly those counts (no shrink, no rewrite)", async () => {
    mem.rec = legacyRecord(46, 24);
    const { addresses } = await useWallet.getState().unlock("pw");
    expect(unlockCounts[0]).toEqual({ external: 46, internal: 24 });
    expect(addresses.pearlPool).toEqual(ext60.slice(0, 46));
    expect(addresses.pearlChange).toEqual(int60.slice(0, 24));
    expect(mem.saves).toBe(0);
  });

  it("storedBranchCounts clamps to the per-branch cap", () => {
    const r = legacyRecord(20, 3);
    expect(storedBranchCounts(r)).toEqual({ external: 20, internal: 3 });
    r.publicData.pearlAddressPool = new Array(5000).fill("x");
    expect(storedBranchCounts(r).external).toBe(1000);
  });
});

describe("extendPearlAddresses — persisting discovery", () => {
  it("persists a prefix-extension of both branches", async () => {
    mem.rec = legacyRecord(20, 20);
    await useWallet.getState().unlock("pw");
    const next = { external: ext60.slice(0, 46), internal: int60.slice(0, 24) };
    expect(await useWallet.getState().extendPearlAddresses(next)).toBe(true);
    expect(useWallet.getState().addresses!.pearlPool).toEqual(next.external);
    expect(useWallet.getState().addresses!.pearlChange).toEqual(next.internal);
    expect(mem.rec!.publicData.pearlAddressPool).toEqual(next.external);
    expect(mem.rec!.publicData.pearlChangePool).toEqual(next.internal);
    expect(mem.rec!.blob).toEqual(BLOB);
    // And the next unlock re-derives the extended set.
    await useWallet.getState().lock();
    await useWallet.getState().unlock("pw");
    expect(unlockCounts.at(-1)).toEqual({ external: 46, internal: 24 });
    expect(useWallet.getState().addresses!.pearlPool).toEqual(next.external);
  });

  it("rejects a non-prefix list (e.g. a scan that raced a wallet switch)", async () => {
    mem.rec = legacyRecord(20, 20);
    await useWallet.getState().unlock("pw");
    const foreign = { external: ["prl1pforeign", ...ext60.slice(1, 30)], internal: int60.slice(0, 20) };
    expect(await useWallet.getState().extendPearlAddresses(foreign)).toBe(false);
    expect(mem.rec!.publicData.pearlAddressPool).toEqual(ext60.slice(0, 20));
  });

  it("no-op when nothing grew; refused while locked", async () => {
    mem.rec = legacyRecord(20, 20);
    await useWallet.getState().unlock("pw");
    const saves = mem.saves;
    expect(await useWallet.getState().extendPearlAddresses({ external: ext60.slice(0, 20), internal: int60.slice(0, 20) })).toBe(false);
    expect(mem.saves).toBe(saves);
    await useWallet.getState().lock();
    expect(await useWallet.getState().extendPearlAddresses({ external: ext60.slice(0, 40), internal: int60.slice(0, 20) })).toBe(false);
  });

  it("derivePearlAddresses goes through the worker with the store's network", async () => {
    mem.rec = legacyRecord(20, 20);
    await useWallet.getState().unlock("pw");
    expect(await useWallet.getState().derivePearlAddresses(1, 20, 4)).toEqual(int60.slice(20, 24));
    await expect(useWallet.getState().derivePearlAddresses(1, 990, 20)).rejects.toThrow("E_DERIVE_BAD_RANGE");
  });

  it("isPrefixExtension", () => {
    expect(isPrefixExtension(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isPrefixExtension(["a", "b"], ["a", "b"])).toBe(true);
    expect(isPrefixExtension(["a", "b"], ["a"])).toBe(false);
    expect(isPrefixExtension(["a", "b"], ["a", "x", "c"])).toBe(false);
  });
});
