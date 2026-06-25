import { describe, it, expect } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import {
  encodeP2MRAddress,
  decodeP2MRAddress,
  mldsaLeafScript,
  p2mrLeafHash,
  p2mrBranchHash,
  p2mrMerkleRoot,
  isValidBtxAddress,
  compactSize,
} from "../src/chains/btx/address";

// ── REAL on-chain vectors (fetched from a live BTX node) ─────────────────────
// Spend tx 8e4929274d4809f7b1ee1e289da913c9c1cb5ea98e2e28fe44d269c03615e214
// (block 140865) input 0 spends the 2-leaf P2MR address below. Witness items:
// [sig(2420), leafScript(1316), controlBlock(33)]. These bytes are ground truth.
const SPEND = {
  address: "btx1zj2f5nmhzqlf007snw0h563lrsalm2s6r0damwuzs7272hnlh4yjqvgw2fs",
  program: "929349eee207d2f7fa1373ef4d47e3877fb543437b7bb77050f2bcabcff7a924",
  mldsaPubkey:
    "29ab73a1610e055250d413ea448a3b3295c1cb6ab4be6c0649688ec6514b0a3cafd356ea939c4c395a3c2fa50e296b2bb2a7fa5fd4937b6b0021bebc07823b0f59ca13ba295d454cacf4a0d9521c8488d6d9a9ed19d84c0d729eb3fa2b32d07c3ee5e3c7f9e2aa78eda2ed6205a37151c2701e210d09b0f1d44d5312fc63a324d06c094fff6c7ef4017af895a605fafdfdab2255e5a9b45b90db03bc013e1e16de192a9db5c7ecc9ad2b4af1bc953a55939218bb1e87c7f0fa038ec2acacce9469fe132f16e4589a69c61ec572467979d7ecf6f0cd27176feb008254d8180467fd53b39f84443575b4b6c5a2d1aa81eeb5a32c05d4ecadc1307a9d7997b76d5b41a1536bb8298a98966e561e8c832245e379b5b90ebd3c7152627027fd7420fdff117d14a5b21dfb7aeed571238b8c101af96c03965e4350ad79b6d7420242150dc4bc216c04345c5e0f57d0d0f4a81fdfce3dded25e382e7e5707ed27d98a5778adf0f29229f18ba6b82c2897ce43f42ed3efb7855a91b60b60aa89abbcba0ab6e89b030c1a8e5cfad2c8af2eb002afecb374977721308acecc9ac1a53d436bc77d580a4ebe8f58927da7e81af3d7529998d1e1abd1d43d8168a64d7cbcc0bcb47460b69272e714cf992dcbace9b3ffc6e3bbc8a70926479cf1b77e0b887780e5cb43fb107f45b76c81209124cb107b13486e705fc9ec38a7885c3a4bfd67a53a7bb8421cad56320f0db5c622ddb786a555c1fc82c398895917eb5001abdeac24d7ac4ca7623652d95411fa2cd89727c514488c8c4a9b69440c2d77a53a48ef3a12363ed7d018e7be13fa0630cfd52565dc35cf2781d809c5e504a321a11bcf30a2e12955d5b03cca296b43160efdeaae62eb77e39f43d16e219c50effc4a1fce1064cd237a99ad6d8466d21e860abcd5880fc90a78465ac4cd6d1df34ad86afaaf348ab78bc9f6de4ffd8b9224781d97af96e5dafaf0e36bb323a1e6febf4179adfc4be5a19c92a11c484b394670cddc4de1a33c14a3e5793fa43a7f1456c460b0a4d65f91f36af71b51772a0ea82a9932b3b90f5696e9fa82df341e47cf18a34883ffba4f1c67155228936c94cb8037b23a203b14dfea7f749bf39cd031302af183f95be4e5ed51d3904a4e2cbaee3be7ebba44a33b8c08cb27bd76e4d1b525e7e0675d46fc2c35adde6bf4526a11d1a22fcb6022c77a8e5b2cd743523fc7584ec709dbad4f9c87618bada9b852cd213c07f5242368f162be802b017091ddc9dae10968e50a145614cfa7eaf90cc23ae775defec79ae4ceb76a04b6a034c7ec1a1beb94caab4601cf9ed050e2c2a16f6aa979e744574f18f4673f2860d883acfc744653bf92ec8b4444831554144531aa6b5dbb572557a71ccbb8d475ce3def251b96734dd46e21fc8b735146f18c94723e299b946597424acb30ab8b4638680867f7ebfcf87322cb345dd22d12e0f6fcd831e60a7960f4643e7ac250ae732b789501123fedc5ddc9b09c46905f243f1184191223f25a2f35fecac011c8f9922722572cfec219be6e9410040d7a9c9f737ca93076207b57332ede411f853cc0770cbb93997f9c90d733e73f535c872008ed0ec2327c05aaca5bbd707515849f84157e96b9fe164ac6da90b459580ed409b0ec81ce832bbdeebe5ce5c7b89724dae437a182593cc25c0ddff27775c0b2b68e73a25548085d2c58007b0cdecc5f09dfaaded944484f6fbadd71830fb501c845c78b3e6ae864b931db8438b1a41bfbdf483bdbb49b11a136db2e56d200b91c103febdcac58e2cc4f1a6c43ae91685c7d97155f4259c875094d2102468ff3b27248d30add4895774cdfcb35f7cc",
  mldsaLeafHash: "d6dd1bc46388146d7d9891f90b31884cdb8f4c17bad1b2fd2ae5c7fa26515753",
  slhdsaLeafHash: "d8dfe6a56cae064e44594268b74ada29884630428ab063d5e4da7f0c4384ce79", // sibling from control block
};

// Lock address (treasury) — another live address↔program pair.
const LOCK = {
  address: "btx1zz0xqu4y5keq8cuzrazdsagacfnyv7mclf3azqvktglp200k94sxsuk7kdn",
  program: "13cc0e5494b6407c7043e89b0ea3b84cc8cf6f1f4c7a2032cb47c2a7bec5ac0d",
};

describe("BTX P2MR codec — validated against on-chain data", () => {
  it("bech32m round-trips both live addresses ↔ programs", () => {
    for (const v of [SPEND, LOCK]) {
      expect(encodeP2MRAddress(hexToBytes(v.program))).toBe(v.address);
      const dec = decodeP2MRAddress(v.address);
      expect(dec.version).toBe(2);
      expect(bytesToHex(dec.program)).toBe(v.program);
    }
  });

  it("ML-DSA leaf script is 1316 bytes: 4d2005 <1312B pk> bb", () => {
    const leaf = mldsaLeafScript(hexToBytes(SPEND.mldsaPubkey));
    expect(leaf.length).toBe(1316);
    expect(bytesToHex(leaf.slice(0, 3))).toBe("4d2005");
    expect(leaf[leaf.length - 1]).toBe(0xbb);
  });

  it("leaf hash of the real ML-DSA leaf matches the on-chain leaf hash", () => {
    const leaf = mldsaLeafScript(hexToBytes(SPEND.mldsaPubkey));
    expect(bytesToHex(p2mrLeafHash(leaf))).toBe(SPEND.mldsaLeafHash);
  });

  it("branch/merkle of the two leaf hashes reproduces the on-chain program", () => {
    const a = hexToBytes(SPEND.mldsaLeafHash);
    const b = hexToBytes(SPEND.slhdsaLeafHash);
    expect(bytesToHex(p2mrBranchHash(a, b))).toBe(SPEND.program);
    expect(bytesToHex(p2mrMerkleRoot([a, b]))).toBe(SPEND.program);
  });

  it("FULL receive path: ML-DSA pubkey + SLH-DSA backup leaf hash → on-chain address", () => {
    const mldsaLeaf = p2mrLeafHash(mldsaLeafScript(hexToBytes(SPEND.mldsaPubkey)));
    const program = p2mrMerkleRoot([mldsaLeaf, hexToBytes(SPEND.slhdsaLeafHash)]);
    expect(encodeP2MRAddress(program)).toBe(SPEND.address);
  });

  it("compactSize(1316) = fd2405", () => {
    expect(bytesToHex(compactSize(1316))).toBe("fd2405");
  });

  it("validates good addresses, rejects junk and wrong witness version", () => {
    expect(isValidBtxAddress(SPEND.address)).toBe(true);
    expect(isValidBtxAddress("btx1qnotp2mr")).toBe(false);
    expect(isValidBtxAddress("notanaddress")).toBe(false);
    // a witness-v1 (P2TR-style) btx address would decode but fail the v2 check
    expect(isValidBtxAddress("prl1p5f450a5540efskxv050tgscelscuztut6zfaqssq8vnlnw53wvdsmw4yvs")).toBe(false);
  });
});
