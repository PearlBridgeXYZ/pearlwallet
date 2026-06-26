import { describe, it, expect } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { computeTxid, p2mrSighash, type BtxTxInput, type BtxTxOutput } from "../src/chains/btx/tx";
import fixture from "./fixtures/btx-onchain-spend.json";

// ── ON-CHAIN VALIDATION (the fund-safety gate for SEND) ──────────────────────
// A real confirmed BTX spend (tx 3788cbde…, block 141727), fetched from a live
// btxd via `getblock` verbosity 3 (prevouts inline). This proves our send path
// is byte-correct against consensus-accepted data:
//   1. computeTxid reproduces the on-chain txid  -> serialization is exact.
//   2. p2mrSighash, fed this tx's inputs/outputs, produces a digest that the
//      tx's REAL on-chain ML-DSA signature verifies against -> the sighash is
//      byte-exact (a consensus-valid signature only verifies vs the right digest).
// If this fails, do NOT enable send (BTX_SEND_ENABLED) — funds would be lost.

const toSat = (v: number): bigint => BigInt(Math.round(v * 1e8));

const ins: BtxTxInput[] = fixture.ins.map((i) => ({
  txid: i.txid,
  vout: i.vout,
  valueSat: toSat(i.amount),
  scriptPubKey: hexToBytes(i.spk),
  sequence: i.sequence,
}));
const outs: BtxTxOutput[] = fixture.outs.map((o) => ({
  scriptPubKey: hexToBytes(o.spk),
  valueSat: toSat(o.value),
}));

describe("BTX send path — on-chain validation (tx 3788cbde…, block 141727)", () => {
  it("computeTxid reproduces the on-chain txid (serialization is byte-exact)", () => {
    expect(computeTxid(fixture.version, ins, outs, fixture.locktime)).toBe(fixture.txid);
  });

  it("the real on-chain ML-DSA signature verifies against our computed P2MR sighash", () => {
    const idx = fixture.p2mr_input_index;
    const w = fixture.ins[idx].witness!;
    const leafScript = hexToBytes(w.leaf); // 4d2005 <1312B pubkey> bb
    const pubkey = leafScript.slice(3, 3 + 1312); // strip OP_PUSHDATA2 len; before OP_CHECKSIG_MLDSA
    const sig = hexToBytes(w.sig); // 2420-byte ML-DSA-44 signature (SIGHASH_DEFAULT)
    expect(pubkey.length).toBe(1312);
    expect(sig.length).toBe(2420);

    const digest = p2mrSighash(fixture.version, ins, outs, fixture.locktime, idx, leafScript);
    // The on-chain signature verifying against OUR digest proves our sighash is
    // byte-identical to what btxd consensus computed.
    expect(ml_dsa44.verify(sig, digest, pubkey)).toBe(true);
  });
});
