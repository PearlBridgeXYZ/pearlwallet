// R7 P3 (Sonnet R4 S-01) — the Pearl signer signs only payments to Pearl
// taproot (P2TR) addresses of the request's network.
//
// Before: signPearlTxWithSeed checked only that each output address was a
// string and handed it to btc-signer's addOutputAddress, so a caller that
// skipped validPearl got a signature paying prl1q… (p2wpkh / p2wsh) or
// base58 P2PKH / P2SH scripts. Now every output address must decode with
// decodeTaprootAddress(·, pearlParams(network)) (else E_PEARL_OUTPUT_ADDRESS,
// nothing derived or signed) and its script is built from the decoded
// 32-byte program.
import { beforeAll, describe, expect, it } from "vitest";
import * as bip39 from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { bech32, bech32m } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { masterFromSeed, pearlBranchPath, type HdBranch } from "../src/crypto/hd";
import { p2trScriptForInternalKey, signPearlTxWithSeed, type PearlTxRequest, type PearlUtxoSpec } from "../src/crypto/pearl-sign";
import { decodeTaprootAddress, pearlAddressFromInternalKey } from "../src/chains/pearl/address";
import { pearlParams } from "../src/chains/pearl/network";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const params = pearlParams("mainnet");
let seed: Uint8Array;
let master: HDKey;
beforeAll(async () => {
  seed = await bip39.mnemonicToSeed(MNEMONIC);
  master = masterFromSeed(seed);
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const scriptOf = (branch: HdBranch, index: number) =>
  hex(p2trScriptForInternalKey(master.derive(pearlBranchPath(branch, index)).publicKey!.slice(1)));
const DEST = (() => {
  const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/86'/808276'/0'/0/0");
  return pearlAddressFromInternalKey(k.publicKey!.slice(1), params);
})();
const utxo = (): PearlUtxoSpec => ({ txid: "11".repeat(32), vout: 0, valueGrains: "200000", scriptHex: scriptOf(0, 0), branch: 0, index: 0 });
const req = (address: string): PearlTxRequest => ({
  utxos: [utxo()],
  outputs: [{ address, amountGrains: "100000" }],
  network: "mainnet",
  maxFeeGrains: "100000",
});

const REFUSED: Array<[string, string]> = [
  ["p2wpkh with the Pearl prefix (prl1q…, 20-byte v0)", bech32.encode("prl", [0, ...bech32.toWords(new Uint8Array(20).fill(9))])],
  ["p2wsh with the Pearl prefix (prl1q…, 32-byte v0)", bech32.encode("prl", [0, ...bech32.toWords(new Uint8Array(32).fill(9))])],
  ["Bitcoin base58 P2PKH", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"],
  ["Bitcoin base58 P2SH", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ["Bitcoin bech32 p2wpkh (bc1q…)", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
  ["a taproot program under another prefix (bc1p…)", bech32m.encode("bc", [1, ...bech32m.toWords(decodeTaprootAddress(DEST, pearlParams("mainnet")))])],
  ["a Pearl P2TR address with a bad checksum", DEST.slice(0, -1) + (DEST.endsWith("q") ? "p" : "q")],
  ["an empty string", ""],
];

describe("R7 P3 — signPearlTxWithSeed refuses non-P2TR / non-Pearl outputs", () => {
  for (const [what, address] of REFUSED) {
    it(`refuses ${what} with E_PEARL_OUTPUT_ADDRESS`, () => {
      expect(() => signPearlTxWithSeed(seed, req(address))).toThrow("E_PEARL_OUTPUT_ADDRESS");
    });
  }

  it("one bad output among good ones refuses the whole request", () => {
    const r = req(DEST);
    r.outputs = [{ address: DEST, amountGrains: "50000" }, { address: REFUSED[0]![1], amountGrains: "50000" }];
    expect(() => signPearlTxWithSeed(seed, r)).toThrow("E_PEARL_OUTPUT_ADDRESS");
  });

  it("a Pearl P2TR address signs; the output script is OP_1 <decoded program> and the signature verifies", () => {
    const { raw } = signPearlTxWithSeed(seed, req(DEST));
    const tx = btc.Transaction.fromRaw(unhex(raw));
    expect(tx.outputsLength).toBe(1);
    expect(hex(tx.getOutput(0).script!)).toBe("5120" + hex(decodeTaprootAddress(DEST, params)));
    expect(tx.getOutput(0).amount).toBe(100_000n);
    const prev = unhex(scriptOf(0, 0));
    const msg = tx.preimageWitnessV1(0, [prev], btc.SigHash.DEFAULT, [200_000n]);
    const w = tx.getInput(0).finalScriptWitness!;
    expect(schnorr.verify(w[0]!, msg, prev.slice(2))).toBe(true);
  });

  it("the same P2TR address in upper case is the same output", () => {
    const out = (raw: string) => hex(btc.Transaction.fromRaw(unhex(raw)).getOutput(0).script!);
    expect(out(signPearlTxWithSeed(seed, req(DEST.toUpperCase())).raw)).toBe(out(signPearlTxWithSeed(seed, req(DEST)).raw));
  });
});
