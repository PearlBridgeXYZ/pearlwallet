// v0.7 — branch-aware single-sig signing: (branch, index) → key mapping,
// input-binding rejection (E_PEARL_FOREIGN_INPUT), multisig isolation, the
// offline-signing payload's branch field, and an end-to-end compose + sign
// spending one external (branch 0) and one change (branch 1) UTXO, verified
// with @scure/btc-signer + BIP-340 against the prevout scripts.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as bip39 from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import {
  masterFromSeed,
  pearlAccountPath,
  pearlBranchPath,
  pearlMultisigPath,
  publicAccountNode,
} from "../src/crypto/hd";
import { pearlBranchAddressRange } from "../src/crypto/pearl-addresses";
import {
  signPearlTxWithSeed,
  p2trScriptForInternalKey,
  type PearlTxRequest,
  type PearlUtxoSpec,
} from "../src/crypto/pearl-sign";
import { decodeTaprootAddress, pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";
import { vaultDescriptorFromPubkeys } from "../src/chains/pearl/multisig";
import * as workerClient from "../src/crypto/worker-client";
import { sendPearl } from "../src/services/pearl-tx";
import { rawTxId } from "../src/services/pearl-rpc";
import { decodePayload, encodePayload, type PearlUnsignedPayload } from "../src/lib/offline-signing/payload";
import { parseManualUtxos } from "../src/lib/offline-signing/manual-utxo";
import { useUI } from "../src/state/ui-store";
import type { HdBranch } from "../src/crypto/hd";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const params = pearlParams("mainnet");
let seed: Uint8Array;
let master: HDKey;
let acct: HDKey;

beforeAll(async () => {
  seed = await bip39.mnemonicToSeed(MNEMONIC);
  master = masterFromSeed(seed);
  acct = publicAccountNode(master, pearlAccountPath());
});
beforeEach(() => {
  vi.restoreAllMocks();
  useUI.getState().setPearlRpcOverride("");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
function scriptOf(branch: HdBranch, index: number): string {
  return hex(p2trScriptForInternalKey(master.derive(pearlBranchPath(branch, index)).publicKey!.slice(1)));
}
function scriptForAddress(addr: string): string {
  return "5120" + hex(decodeTaprootAddress(addr, params));
}
const OTHER_DEST = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/86'/808276'/0'/0/0");
  return pearlAddressFromInternalKey(k.publicKey!.slice(1), params);
})();

function utxo(branch: HdBranch, index: number, value: bigint, n = 1, script = scriptOf(branch, index)): PearlUtxoSpec {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, valueGrains: value.toString(), scriptHex: script, branch, index };
}

/** Verifies every input's key-path BIP-340 signature against its prevout. */
function verifySignatures(raw: string, prevouts: Map<string, { script: Uint8Array; amount: bigint }>): number {
  const tx = btc.Transaction.fromRaw(unhex(raw));
  const scripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const p = prevouts.get(`${hex(inp.txid!)}:${inp.index}`);
    if (!p) throw new Error(`unknown prevout for input ${i}`);
    scripts.push(p.script);
    amounts.push(p.amount);
  }
  let ok = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).finalScriptWitness!;
    expect(w).toHaveLength(1);
    expect(w[0]!.length).toBe(64); // SIGHASH_DEFAULT
    const msg = tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts);
    const outputKey = scripts[i]!.slice(2);
    if (schnorr.verify(w[0]!, msg, outputKey)) ok++;
  }
  return ok;
}

function prevoutMap(us: PearlUtxoSpec[]) {
  return new Map(us.map((u) => [`${u.txid}:${u.vout}`, { script: unhex(u.scriptHex), amount: BigInt(u.valueGrains) }]));
}

describe("signPearlTxWithSeed — signer mapping", () => {
  it("signs with exactly the (branch, index) key of each input", () => {
    const ins = [utxo(0, 7, 50_000n, 1), utxo(1, 3, 70_000n, 2), utxo(1, 250, 30_000n, 3)];
    const req: PearlTxRequest = { utxos: ins, outputs: [{ address: OTHER_DEST, amountGrains: "140000" }], network: "mainnet" };
    const { raw } = signPearlTxWithSeed(seed, req);
    expect(verifySignatures(raw, prevoutMap(ins))).toBe(3);
    // The verifier discriminates: a different prevout amount (committed in
    // the BIP-341 sighash) invalidates every signature.
    const wrong = prevoutMap(ins);
    const k = `${ins[1]!.txid}:0`;
    wrong.set(k, { ...wrong.get(k)!, amount: 70_001n });
    expect(verifySignatures(raw, wrong)).toBe(0);
  });

  it("index 0 on branch 1 is not index 0 on branch 0", () => {
    expect(scriptOf(1, 0)).not.toBe(scriptOf(0, 0));
    expect(scriptOf(1, 0)).toBe(scriptForAddress(pearlBranchAddressRange(acct, "mainnet", 1, 0, 1)[0]!));
  });
});

describe("signPearlTxWithSeed — input binding (E_PEARL_FOREIGN_INPUT)", () => {
  const out = [{ address: OTHER_DEST, amountGrains: "1000" }];
  const sign = (u: PearlUtxoSpec[]) => () => signPearlTxWithSeed(seed, { utxos: u, outputs: out, network: "mainnet" });

  it("wrong branch for the script → reject", () => {
    expect(sign([utxo(0, 3, 5000n, 1, scriptOf(1, 3))])).toThrow("E_PEARL_FOREIGN_INPUT");
  });
  it("wrong index for the script → reject", () => {
    expect(sign([utxo(1, 4, 5000n, 1, scriptOf(1, 3))])).toThrow("E_PEARL_FOREIGN_INPUT");
  });
  it("foreign script (another wallet) → reject", () => {
    expect(sign([utxo(0, 0, 5000n, 1, scriptForAddress(OTHER_DEST))])).toThrow("E_PEARL_FOREIGN_INPUT");
  });
  it("one foreign input among good ones → whole request rejected", () => {
    expect(sign([utxo(0, 0, 5000n, 1), utxo(0, 1, 5000n, 2, scriptOf(0, 2))])).toThrow("E_PEARL_FOREIGN_INPUT");
  });
  it("a multisig vault output (even one we cosign) → reject", () => {
    const xs = [0, 1, 2].map((i) => master.derive(pearlMultisigPath(0, i)).publicKey!.slice(1));
    const vault = vaultDescriptorFromPubkeys(2, xs, params);
    expect(sign([utxo(0, 0, 5000n, 1, hex(vault.outputScript))])).toThrow("E_PEARL_FOREIGN_INPUT");
  });
  it("shape: bad branch, bad index, legacy poolIndex-only spec, duplicate input", () => {
    const good = utxo(0, 0, 5000n);
    expect(sign([{ ...good, branch: 2 as HdBranch }])).toThrow("E_PEARL_UTXO_SHAPE");
    expect(sign([{ ...good, index: -1 }])).toThrow("E_PEARL_UTXO_SHAPE");
    expect(sign([{ ...good, index: 2 ** 31 }])).toThrow("E_PEARL_UTXO_SHAPE");
    const legacy = { txid: good.txid, vout: 0, valueGrains: "5000", scriptHex: good.scriptHex, poolIndex: 0 };
    expect(sign([legacy as unknown as PearlUtxoSpec])).toThrow("E_PEARL_UTXO_SHAPE");
    expect(sign([good, { ...good }])).toThrow("E_PEARL_DUPLICATE_INPUT");
    expect(sign([{ ...good, valueGrains: "0" }])).toThrow("E_PEARL_UTXO_VALUE");
  });
  it("the signer cannot reach the multisig subtree", () => {
    // Account and purpose are fixed: only m/86'/808276'/0'/{0,1}/i.
    expect(pearlBranchPath(1, 0).startsWith("m/86'/808276'/0'/")).toBe(true);
    expect(pearlMultisigPath(0, 0)).toBe("m/86'/808276'/100'/0'/0");
  });
});

describe("end-to-end compose + sign: one branch-0 and one branch-1 UTXO", () => {
  it("discovers, composes, signs; signatures verify against both prevouts", async () => {
    const ext = pearlBranchAddressRange(acct, "mainnet", 0, 0, 20);
    const int = pearlBranchAddressRange(acct, "mainnet", 1, 0, 20);
    const A = ext[2]!; // receive branch
    const B = int[5]!; // change branch
    const fundA = { txid: "aa".repeat(32), vin: [], vout: [{ value: 3, n: 1, scriptPubKey: { address: A, hex: scriptForAddress(A) } }] };
    const fundB = { txid: "bb".repeat(32), vin: [], vout: [{ value: 4, n: 0, scriptPubKey: { address: B, hex: scriptForAddress(B) } }] };
    const history: Record<string, unknown[]> = { [A]: [fundA], [B]: [fundB] };
    let broadcastRaw = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
        if (body.method === "sendrawtransaction") {
          broadcastRaw = body.params[0] as string;
          return new Response(JSON.stringify({ result: rawTxId(broadcastRaw), error: null }));
        }
        const addr = body.params[0] as string;
        const skip = body.params[2] as number;
        const page = (history[addr] ?? []).slice(skip, skip + 100);
        if (page.length === 0) {
          return new Response(JSON.stringify({ result: null, error: { code: -5, message: "No information available about address" } }));
        }
        return new Response(JSON.stringify({ result: page, error: null }));
      }),
    );
    // The crypto worker, in-process: same pure signer the worker runs.
    const workerCalls: string[] = [];
    vi.spyOn(workerClient.cryptoWorker, "call").mockImplementation((async (cmd: string, args: { req: PearlTxRequest }) => {
      workerCalls.push(cmd);
      if (cmd !== "signPearlTx") throw new Error(`unexpected ${cmd}`);
      return signPearlTxWithSeed(seed, args.req);
    }) as never);
    const discovered: Array<{ external: string[]; internal: string[] }> = [];

    const res = await sendPearl({
      network: "mainnet",
      pool: ext,
      changePool: int,
      deriveMore: async (b, start, count) => pearlBranchAddressRange(acct, "mainnet", b, start, count),
      onDiscovered: (s) => discovered.push(s),
      destination: OTHER_DEST,
      amountGrains: 600_000_000n,
      includeTip: false,
    });

    expect(workerCalls).toEqual(["signPearlTx"]);
    const picked = res.composed.utxos.map((u) => [u.branch, u.index]).sort();
    expect(picked).toEqual([[0, 2], [1, 5]]);
    // Change stays on external index 0.
    expect(res.composed.outputs.map((o) => o.address)).toEqual([OTHER_DEST, ext[0]]);
    // Discovery extended both branches past the used indexes and reported it.
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.external).toHaveLength(23);
    expect(discovered[0]!.internal).toHaveLength(26);
    expect(discovered[0]!.internal.slice(0, 20)).toEqual(int);

    expect(res.txid).toBe(rawTxId(broadcastRaw));
    const prevouts = new Map([
      [`${"aa".repeat(32)}:1`, { script: unhex(scriptForAddress(A)), amount: 300_000_000n }],
      [`${"bb".repeat(32)}:0`, { script: unhex(scriptForAddress(B)), amount: 400_000_000n }],
    ]);
    expect(verifySignatures(broadcastRaw, prevouts)).toBe(2);

    // Outputs as composed.
    const tx = btc.Transaction.fromRaw(unhex(broadcastRaw));
    expect(tx.outputsLength).toBe(2);
    expect(hex(tx.getOutput(0).script!)).toBe(scriptForAddress(OTHER_DEST));
    expect(tx.getOutput(0).amount).toBe(600_000_000n);
    expect(hex(tx.getOutput(1).script!)).toBe(scriptForAddress(ext[0]!));
    expect(tx.getOutput(1).amount).toBe(res.composed.changeGrains);
    expect(300_000_000n + 400_000_000n - 600_000_000n - res.composed.changeGrains).toBe(res.composed.feeGrains);
  });
});

describe("offline signing — branch field", () => {
  const base: PearlUnsignedPayload = {
    v: 1,
    k: "pearl-unsigned",
    network: "mainnet",
    utxos: [
      { txid: "a".repeat(64), vout: 0, valueGrains: "100", scriptHex: "5120" + "00".repeat(32), poolIndex: 3 },
      { txid: "b".repeat(64), vout: 1, valueGrains: "200", scriptHex: "5120" + "00".repeat(32), poolIndex: 5, branch: 1 },
    ],
    outputs: [{ address: "prl1pdest", amountGrains: "250" }],
  };

  it("round-trips branch 1 and omits branch 0", () => {
    const back = decodePayload(encodePayload(base)) as PearlUnsignedPayload;
    expect(back.utxos[0]!.branch).toBeUndefined();
    expect(back.utxos[1]!.branch).toBe(1);
  });

  it("rejects an invalid branch", () => {
    const bad = { ...base, utxos: [{ ...base.utxos[0]!, branch: 2 as unknown as 1 }] };
    expect(() => decodePayload(encodePayload(bad))).toThrow(/branch/);
  });

  it("manual UTXO list accepts i, 0/i and 1/i", () => {
    const t = "a".repeat(64);
    const r = parseManualUtxos(`${t}:0:5:7\n${t}:1:5:0/8\n${t}:2:5:1/9`);
    expect(r.errors).toEqual([]);
    expect(r.utxos.map((u) => [u.branch ?? 0, u.poolIndex])).toEqual([[0, 7], [0, 8], [1, 9]]);
    expect(parseManualUtxos(`${t}:0:5:2/1`).errors[0]!.message).toMatch(/poolIndex/);
    expect(parseManualUtxos(`${t}:0:5:1000`).errors[0]!.message).toMatch(/poolIndex/);
  });
});
