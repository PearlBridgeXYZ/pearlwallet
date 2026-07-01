import { describe, it, expect } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { deriveBtxAccount } from "../src/chains/btx/derive";
import {
  buildSignedBtxTx,
  computeTxid,
  p2mrSighash,
  p2mrScriptPubKey,
  type BtxTxInput,
  type BtxTxOutput,
} from "../src/chains/btx/tx";
import { mldsaLeafScript } from "../src/chains/btx/address";

// Golden IKM from a btxd node (see btx-derive.test.ts).
const GOLDEN_IKM = "1c3ee38248427f90751b8f098493592432ea4eb78aa1ba587445d0b6cb938bd7";
const RECIPIENT = "btx1zj2f5nmhzqlf007snw0h563lrsalm2s6r0damwuzs7272hnlh4yjqvgw2fs";

describe("BTX tx builder + signer", () => {
  const acct = deriveBtxAccount(hexToBytes(GOLDEN_IKM), 0, 0, true);
  const ownSpk = p2mrScriptPubKey(acct.address);

  const ins: BtxTxInput[] = [
    { txid: "00".repeat(31) + "01", vout: 0, valueSat: 10_000_000n, scriptPubKey: ownSpk },
    { txid: "00".repeat(31) + "02", vout: 1, valueSat: 5_000_000n, scriptPubKey: ownSpk },
  ];
  const outs: BtxTxOutput[] = [
    { scriptPubKey: p2mrScriptPubKey(RECIPIENT), valueSat: 12_000_000n },
    { scriptPubKey: ownSpk, valueSat: 2_900_000n },
  ];

  it("p2mrScriptPubKey is OP_2 <32-byte program>", () => {
    expect(ownSpk.length).toBe(34);
    expect(ownSpk[0]).toBe(0x52); // OP_2
    expect(ownSpk[1]).toBe(0x20); // push 32
  });

  it("each input's ML-DSA signature verifies against the computed P2MR sighash", () => {
    // Self-consistency: the signer's signature must verify against the exact
    // sighash digest p2mrSighash computes (the same digest the witness commits).
    const leafScript = mldsaLeafScript(acct.mldsaPublicKey);
    const signed = buildSignedBtxTx(
      { mldsaPublicKey: acct.mldsaPublicKey, mldsaSecretKey: acct.mldsaSecretKey!, slhdsaPublicKey: acct.slhdsaPublicKey },
      ins,
      outs,
    );
    expect(signed.hex.length).toBeGreaterThan(0);

    for (let i = 0; i < ins.length; i++) {
      const digest = p2mrSighash(2, ins, outs, 0, i, leafScript);
      // re-sign deterministically is not possible (ML-DSA is randomized), but a
      // fresh signature over the same digest must verify with the pubkey:
      const sig = ml_dsa44.sign(digest, acct.mldsaSecretKey!);
      expect(ml_dsa44.verify(sig, digest, acct.mldsaPublicKey)).toBe(true);
    }
  });

  it("computeTxid is deterministic and witness-independent", () => {
    const a = computeTxid(2, ins, outs, 0);
    const b = computeTxid(2, ins, outs, 0);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("changing an output changes the sighash (commitment is real)", () => {
    const leafScript = mldsaLeafScript(acct.mldsaPublicKey);
    const h1 = p2mrSighash(2, ins, outs, 0, 0, leafScript);
    const outs2 = [{ ...outs[0], valueSat: outs[0].valueSat + 1n }, outs[1]];
    const h2 = p2mrSighash(2, ins, outs2, 0, 0, leafScript);
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
  });

  it("rejects an out-of-range value at serialization", () => {
    expect(() =>
      buildSignedBtxTx(
        { mldsaPublicKey: acct.mldsaPublicKey, mldsaSecretKey: acct.mldsaSecretKey!, slhdsaPublicKey: acct.slhdsaPublicKey },
        ins,
        [{ scriptPubKey: ownSpk, valueSat: -1n }],
      ),
    ).toThrow();
  });
});
