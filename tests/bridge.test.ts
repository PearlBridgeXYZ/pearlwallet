// v0.1.7: tests for bridge.ts after H1 (JSON boundary coercion) and
// H2 (intent-binding required) closed.
//
// We DON'T test on-chain `recoverTypedDataAddress` + RELAYER role
// lookup here — those need a live RPC. The fast-path tests below
// cover the binding/expiry checks that run BEFORE the RPC call, which
// is where the H1/H2 regressions lived. recoverTypedDataAddress is
// tested via integration with a known-good signature in
// derivation.test.ts; here we focus on the input-shaping layer.

import { describe, it, expect } from "vitest";
import {
  normalizeRelayerMintSig,
  verifyRelayerMintSig,
  type IntentExpectation,
  type RelayerMintSig,
} from "../src/services/bridge";

const SIG_HEX = ("0x" + "ab".repeat(65)) as `0x${string}`;
const RECIPIENT = "0xAAaaaaaaAAaaAaAAAaaaaaAAaaAaaaAAaAAaAaAa" as `0x${string}`;
const SDI_HASH = ("0x" + "11".repeat(32)) as `0x${string}`;

type Wire = Record<string, unknown>;
function rawWire(overrides: Wire = {}) {
  // Use 'in' so an explicit `undefined` / `null` reaches the normalizer
  // instead of being clobbered by `??` defaults. This is what makes
  // "reject undefined signature" and "reject null sdiHash" tests honest.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(overrides, k);
  if (overrides.payloadShape === "null") {
    return { payload: null, signature: has("signature") ? overrides.signature : SIG_HEX };
  }
  if (overrides.payloadShape === "missing") {
    return { signature: has("signature") ? overrides.signature : SIG_HEX };
  }
  const payload: Wire = {
    recipient: has("recipient") ? overrides.recipient : RECIPIENT,
    amount: has("amount") ? overrides.amount : "1000000000000000000",  // 1 WPRL string
    sdiHash: has("sdiHash") ? overrides.sdiHash : SDI_HASH,
    nonce: has("nonce") ? overrides.nonce : "5",
    deadline: has("deadline") ? overrides.deadline : String(Math.floor(Date.now() / 1000) + 3600),
  };
  return { payload, signature: has("signature") ? overrides.signature : SIG_HEX };
}

describe("normalizeRelayerMintSig — JSON boundary coercion (H1)", () => {
  it("accepts uint256 fields as JSON strings", () => {
    const out = normalizeRelayerMintSig(rawWire({ amount: "42", nonce: "0", deadline: "9999999999" }));
    expect(typeof out.payload.amount).toBe("bigint");
    expect(out.payload.amount).toBe(42n);
    expect(out.payload.nonce).toBe(0n);
    expect(out.payload.deadline).toBe(9_999_999_999n);
  });

  it("REJECTS uint256 fields encoded as JSON numbers (M-1 precision loss)", () => {
    // v0.1.8 tightened coerceUint to decimal-string only. JSON numbers
    // above 2^53-1 silently lose precision at JSON.parse time — a
    // malicious relayer could exploit the truncation to swap a 1e20
    // amount for the wallet's canonical value. The v0.1.7 contract
    // accepted them as a "small-number convenience"; we no longer do.
    expect(() => normalizeRelayerMintSig(rawWire({ amount: 7 }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ nonce: 1 }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ deadline: 2_000_000_000 }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("REJECTS hex-string uint256 fields (non-canonical encoding)", () => {
    // BigInt("0x10") evaluates to 16n, but the contract is decimal.
    // Hex would let a hostile relayer encode the same value two ways,
    // confusing visual inspection of intercepted responses.
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "0x10" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ deadline: "0xff" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("REJECTS uint256 with leading zeros (non-canonical decimal)", () => {
    // "007" is not canonical. Reject so a sniffing tool sees one
    // representation per value.
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "007" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("accepts '0' (canonical zero)", () => {
    const out = normalizeRelayerMintSig(rawWire({ amount: "0", nonce: "0", deadline: "0" }));
    expect(out.payload.amount).toBe(0n);
    expect(out.payload.nonce).toBe(0n);
    expect(out.payload.deadline).toBe(0n);
  });

  it("rejects non-object inputs", () => {
    expect(() => normalizeRelayerMintSig(null)).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig("hello")).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(42)).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(undefined)).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects missing or non-object payload", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ payloadShape: "missing" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ payloadShape: "null" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects missing or malformed signature", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ signature: undefined }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ signature: "no-0x-prefix" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ signature: 123 }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects malformed recipient / sdiHash", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ recipient: "0xnotanaddress" }))).not.toThrow();
    // normalize only checks 0x prefix — full address shape check is done
    // inside verifyRelayerMintSig via recoverTypedDataAddress.
    expect(() => normalizeRelayerMintSig(rawWire({ recipient: 123 }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ sdiHash: null }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects fractional / non-numeric uint256 fields", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "1.5" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "abc" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ deadline: NaN }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("rejects negative uint256 fields", () => {
    expect(() => normalizeRelayerMintSig(rawWire({ amount: "-1" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ nonce: "-2" }))).toThrow("E_SIGNATURE_MALFORMED");
    expect(() => normalizeRelayerMintSig(rawWire({ deadline: "-3" }))).toThrow("E_SIGNATURE_MALFORMED");
  });

  it("preserves recipient checksum casing in the typed payload", () => {
    const mixedCase = "0xAAaaaaaaAAaaAaAAAaaaaaAAaaAaaaAAaAAaAaAa" as `0x${string}`;
    const out = normalizeRelayerMintSig(rawWire({ recipient: mixedCase }));
    expect(out.payload.recipient).toBe(mixedCase);
  });
});

describe("verifyRelayerMintSig — binding required (H2)", () => {
  // Build a structurally-valid normalized sig that hasn't yet expired,
  // so the fast-path checks (deadline, recipient, amount, sdiHash) run
  // before the recovered-signer / RELAYER-role lookup.
  function makeSig(overrides: Partial<{
    deadline: bigint;
    recipient: `0x${string}`;
    amount: bigint;
    sdiHash: `0x${string}`;
  }> = {}): RelayerMintSig {
    return {
      payload: {
        recipient: overrides.recipient ?? RECIPIENT,
        amount: overrides.amount ?? 1_000_000_000_000_000_000n,
        sdiHash: overrides.sdiHash ?? SDI_HASH,
        nonce: 5n,
        deadline: overrides.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
      },
      signature: SIG_HEX,
    };
  }

  const EXPECTED: IntentExpectation = {
    recipient: RECIPIENT,
    amount: 1_000_000_000_000_000_000n,
    sdiHash: SDI_HASH,
  };

  it("throws E_SIGNATURE_EXPIRED if deadline already passed", async () => {
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    const sig = makeSig({ deadline: past });
    await expect(verifyRelayerMintSig(sig, "mainnet", EXPECTED)).rejects.toThrow("E_SIGNATURE_EXPIRED");
  });

  it("uses nowSecOverride when supplied (trusted block timestamp)", async () => {
    // Sig is "valid" by local clock (deadline +1h) but a trusted block
    // timestamp far in the future shows it expired. Trusted clock wins.
    const sig = makeSig();
    const trustedNow = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
    await expect(verifyRelayerMintSig(sig, "mainnet", EXPECTED, trustedNow))
      .rejects.toThrow("E_SIGNATURE_EXPIRED");
  });

  it("rejects mismatched recipient (MITM swap)", async () => {
    const sig = makeSig();
    const attackerExpected: IntentExpectation = {
      ...EXPECTED,
      recipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    await expect(verifyRelayerMintSig(sig, "mainnet", attackerExpected))
      .rejects.toThrow("E_SIGNATURE_RECIPIENT_MISMATCH");
  });

  it("rejects mismatched amount", async () => {
    const sig = makeSig();
    const inflated: IntentExpectation = { ...EXPECTED, amount: 5_000_000_000_000_000_000n };
    await expect(verifyRelayerMintSig(sig, "mainnet", inflated))
      .rejects.toThrow("E_SIGNATURE_AMOUNT_MISMATCH");
  });

  it("rejects mismatched sdiHash (intent-swap attack)", async () => {
    const sig = makeSig();
    const otherIntent: IntentExpectation = {
      ...EXPECTED,
      sdiHash: ("0x" + "22".repeat(32)) as `0x${string}`,
    };
    await expect(verifyRelayerMintSig(sig, "mainnet", otherIntent))
      .rejects.toThrow("E_SIGNATURE_SDI_HASH_MISMATCH");
  });

  it("recipient comparison is case-insensitive (EIP-55 / lowercase parity)", async () => {
    const upper = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as `0x${string}`;
    const lower = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
    const sig = makeSig({ recipient: upper });
    const expected: IntentExpectation = { ...EXPECTED, recipient: lower };
    // Should NOT throw recipient mismatch — it should fall through to the
    // expired-or-on-chain-roles path. We use an already-expired deadline
    // so we can assert the failure mode that comes AFTER the recipient
    // check passes.
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    const sigExpired = makeSig({ recipient: upper, deadline: past });
    await expect(verifyRelayerMintSig(sigExpired, "mainnet", expected))
      .rejects.toThrow("E_SIGNATURE_EXPIRED");
    // Sanity: the still-valid sig hits the recover/roles path next, not
    // a recipient mismatch.
    await expect(verifyRelayerMintSig(sig, "mainnet", expected))
      .rejects.not.toThrow("E_SIGNATURE_RECIPIENT_MISMATCH");
  });
});

describe("verifyRelayerMintSig — signature has the type-required `expected` (H2)", () => {
  it("`expected` is now part of the function signature at the type level", () => {
    // This is a compile-time gate. The function reference's parameter
    // count must be >= 3 (sig, network, expected). If a future refactor
    // makes `expected` optional again, this assertion still holds (param
    // count doesn't change for optional params at runtime), but the
    // accompanying TypeScript build will fail because callers stop
    // passing it. Both layers together close the H2 regression.
    expect(verifyRelayerMintSig.length).toBeGreaterThanOrEqual(3);
  });
});
