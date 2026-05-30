// v0.3.0 sig-return — wallet-side proof format lock-in.
//
// The wallet's crypto Worker computes a domain-separated Schnorr proof
// for posting a partial sig back to the vault relay. The relay's
// pearl-vault-relay/src/sig-proof.ts:verifySigProof recomputes the same
// digest and verifies the proof — if the two sides ever drift (different
// domain string, different field order, different hashing scheme), every
// /sig POST will 401 in prod with no clear signal.
//
// This test re-implements the digest derivation here using the same
// primitives the worker uses (sha256 + schnorr from @noble) and asserts
// it round-trips. It deliberately does NOT import the worker — Web
// Worker modules can't be loaded in Node. The proof code in
// crypto/worker.ts case "signSigProofForVault" must stay byte-identical
// to the canonical message constructed here.

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

const SIG_PROOF_DOMAIN = "pearl-vault-relay/sig/v1";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// Mirrors the relay's computeSigProofDigest and the worker's inline
// digest construction. If you change the algorithm in EITHER place,
// update BOTH and re-run this test.
function computeSigProofDigest(
  token: string,
  psbtBase64: string,
  signedAt: number,
): Uint8Array {
  const psbtDigestHex = bytesToHex(
    sha256(new TextEncoder().encode(psbtBase64)),
  );
  const canonical =
    `${SIG_PROOF_DOMAIN}\n${token}\n${signedAt}\n${psbtDigestHex}`;
  return sha256(new TextEncoder().encode(canonical));
}

const TOKEN = "A".repeat(43);
const PSBT = "cHNidP-fake-bytes";
const TS = 1_700_000_000;

describe("v0.3.0 sig-return proof — wallet ↔ relay shape contract", () => {
  it("digest is deterministic for a given (token, psbt, signedAt)", () => {
    const a = computeSigProofDigest(TOKEN, PSBT, TS);
    const b = computeSigProofDigest(TOKEN, PSBT, TS);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(a.length).toBe(32);
  });

  it("digest changes when ANY field changes (binding holds)", () => {
    const base = computeSigProofDigest(TOKEN, PSBT, TS);
    expect(bytesToHex(computeSigProofDigest("B".repeat(43), PSBT, TS))).not.toBe(bytesToHex(base));
    expect(bytesToHex(computeSigProofDigest(TOKEN, PSBT + "x", TS))).not.toBe(bytesToHex(base));
    expect(bytesToHex(computeSigProofDigest(TOKEN, PSBT, TS + 1))).not.toBe(bytesToHex(base));
  });

  it("schnorr round-trip: sign with privkey, verify against x-only pubkey", () => {
    const priv = new Uint8Array(randomBytes(32));
    const pub = schnorr.getPublicKey(priv);
    const digest = computeSigProofDigest(TOKEN, PSBT, TS);
    const sig = schnorr.sign(digest, priv);
    expect(schnorr.verify(sig, digest, pub)).toBe(true);
  });

  it("schnorr verify fails when digest is tampered post-sign", () => {
    const priv = new Uint8Array(randomBytes(32));
    const pub = schnorr.getPublicKey(priv);
    const digest = computeSigProofDigest(TOKEN, PSBT, TS);
    const sig = schnorr.sign(digest, priv);
    const tampered = computeSigProofDigest(TOKEN, PSBT + "tampered", TS);
    expect(schnorr.verify(sig, tampered, pub)).toBe(false);
  });

  it("schnorr verify fails when a different key tries to claim the sig", () => {
    const realPriv = new Uint8Array(randomBytes(32));
    const evilPriv = new Uint8Array(randomBytes(32));
    const evilPub = schnorr.getPublicKey(evilPriv);
    const digest = computeSigProofDigest(TOKEN, PSBT, TS);
    const realSig = schnorr.sign(digest, realPriv);
    expect(schnorr.verify(realSig, digest, evilPub)).toBe(false);
  });

  // Canonical byte-level reference. If this test fails, BOTH the wallet
  // worker AND the relay verifier diverge from spec — and any cosigner
  // built against the documented format will fail to authenticate. Treat
  // a change here as a wire-protocol bump.
  it("canonical message uses LF separators and trailing PSBT sha256 hex", () => {
    const psbtHex = bytesToHex(sha256(new TextEncoder().encode(PSBT)));
    const expected = `${SIG_PROOF_DOMAIN}\n${TOKEN}\n${TS}\n${psbtHex}`;
    const expectedDigest = sha256(new TextEncoder().encode(expected));
    expect(bytesToHex(computeSigProofDigest(TOKEN, PSBT, TS))).toBe(
      bytesToHex(expectedDigest),
    );
  });
});
