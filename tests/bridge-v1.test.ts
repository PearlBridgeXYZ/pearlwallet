// v0.4.0 native bridging — /v1 API client + amount math + lifecycle
// classification. The client is the trust boundary between the wallet and
// the bridge API: malformed/hostile responses must throw, never propagate
// into amount math or signing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINT_IN_FLIGHT,
  classifyBurn,
  classifyMint,
  fetchBurnQuote,
  fetchDepositAddress,
  fetchMintQuote,
  fetchMintStatus,
  grainsToPrlString,
  prlToGrains,
  resolveDepositAddress,
  type DepositTofuStore,
} from "../src/services/bridge-v1";

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("amount math (8-decimal grains)", () => {
  it("round-trips user input through grains exactly", () => {
    expect(prlToGrains("1")).toBe(100_000_000n);
    expect(prlToGrains("0.00000001")).toBe(1n);
    expect(prlToGrains("123.456")).toBe(12_345_600_000n);
    expect(grainsToPrlString(12_345_600_000n)).toBe("123.456");
    expect(grainsToPrlString(1n)).toBe("0.00000001");
    expect(grainsToPrlString(100_000_000n)).toBe("1");
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["", "-1", "1.123456789", "1e8", "abc", "1,5"]) {
      expect(() => prlToGrains(bad)).toThrow();
    }
  });

  it("never loses precision past MAX_SAFE_INTEGER", () => {
    const big = "90071992.54740993"; // > 2^53 grains
    expect(grainsToPrlString(prlToGrains(big))).toBe(big);
  });
});

describe("fetchMintQuote", () => {
  it("parses a fast-lane quote", async () => {
    fetchMock.mockResolvedValue(
      okJson({
        amountGrains: "10000000000",
        feeBps: 50,
        feeGrains: "50000000",
        netGrains: "9950000000",
        lane: "fast",
        slowLaneDelaySeconds: 0,
        withinDailyCap: true,
        confirmationsRequired: 6,
        paused: false,
      }),
    );
    const q = await fetchMintQuote(10_000_000_000n);
    expect(q.fee).toBe(50_000_000n);
    expect(q.net).toBe(9_950_000_000n);
    expect(q.lane).toBe("fast");
    expect(q.confirmationsRequired).toBe(6);
  });

  it("throws on a hostile/malformed quote rather than returning NaN-ish data", async () => {
    fetchMock.mockResolvedValue(okJson({ amountGrains: 123, feeGrains: null }));
    await expect(fetchMintQuote(1n)).rejects.toThrow(/E_BRIDGE_API_SHAPE/);
  });
});

describe("fetchBurnQuote", () => {
  it("extracts the transaction plan addresses for the pinned-constant cross-check", async () => {
    fetchMock.mockResolvedValue(
      okJson({
        amountGrains: "1000000000",
        feeBps: 0,
        feeGrains: "0",
        netGrains: "1000000000",
        withinDailyCap: true,
        paused: false,
        addressCheck: { valid: true },
        transaction: {
          chainId: 1,
          steps: [
            { step: "approve", to: "0x07696DcaB55E62cfef953666b29Fe1970518cB00", args: [] },
            { step: "requestBurn", to: "0xA6571B73489d4eBFA269a107208665dF7C80Aef5", args: [] },
          ],
        },
      }),
    );
    const q = await fetchBurnQuote(1_000_000_000n, "prl1ptest");
    expect(q.wprl).toBe("0x07696DcaB55E62cfef953666b29Fe1970518cB00");
    expect(q.bridgeController).toBe("0xA6571B73489d4eBFA269a107208665dF7C80Aef5");
    expect(q.addressValid).toBe(true);
  });

  it("surfaces an invalid payout address as addressValid=false", async () => {
    fetchMock.mockResolvedValue(
      okJson({
        amountGrains: "1",
        feeBps: 0,
        feeGrains: "0",
        netGrains: "1",
        addressCheck: { valid: false, reason: "Not a witness v1 address" },
        transaction: { steps: [{ to: "0x1" }, { to: "0x2" }] },
      }),
    );
    const q = await fetchBurnQuote(1n, "prl1broken");
    expect(q.addressValid).toBe(false);
  });
});

describe("fetchDepositAddress", () => {
  it("returns the derived prl1 address", async () => {
    fetchMock.mockResolvedValue(okJson({ pearlAddress: "prl1pabcdef", ethAddress: "0xabc" }));
    expect(await fetchDepositAddress("0xAbC0000000000000000000000000000000000000")).toBe(
      "prl1pabcdef",
    );
  });

  it("refuses a non-prl1 deposit address (hostile API)", async () => {
    fetchMock.mockResolvedValue(okJson({ pearlAddress: "bc1qattacker" }));
    await expect(
      fetchDepositAddress("0xAbC0000000000000000000000000000000000000"),
    ).rejects.toThrow(/E_BRIDGE_API_SHAPE/);
  });

  it("propagates rate-limit errors", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
    await expect(
      fetchDepositAddress("0xAbC0000000000000000000000000000000000000"),
    ).rejects.toThrow(/429/);
  });
});

describe("lifecycle classification", () => {
  it("classifyMint covers ok / fail / refunded / review / pending", () => {
    expect(classifyMint("minted", false)).toBe("ok");
    expect(classifyMint("finalized", false)).toBe("ok");
    expect(classifyMint("failed", false)).toBe("fail");
    expect(classifyMint("cancelled", false)).toBe("fail");
    expect(classifyMint("under_review", false)).toBe("review"); // hold, not fail
    expect(classifyMint("pending", false)).toBe("pending");
    expect(classifyMint("submitted_stuck", false)).toBe("pending"); // relay auto-RBFs
    // refundedAt wins regardless of state — even while still under_review
    expect(classifyMint("under_review", true)).toBe("refunded");
    expect(classifyMint(null, false)).toBe("pending"); // not-yet-indexed
    // ANY unknown future state surfaces as review, never a silent hang
    expect(classifyMint("some_new_state", false)).toBe("review");
  });

  it("classifyBurn covers the relay's ACTUAL emitted states", () => {
    // Relay emits: pending/signing/submitted/finalized/failed/reorged/under_review
    expect(classifyBurn("finalized")).toBe("ok");
    expect(classifyBurn("failed")).toBe("fail");
    expect(classifyBurn("reorged")).toBe("fail"); // audit H3
    expect(classifyBurn("under_review")).toBe("review"); // audit round-2: was hanging forever
    for (const s of ["pending", "signing", "submitted"]) {
      expect(classifyBurn(s)).toBe("pending");
    }
    expect(classifyBurn(null)).toBe("pending");
    expect(classifyBurn("some_new_state")).toBe("review"); // never silent
  });

  it("MINT_IN_FLIGHT excludes terminal + held states (recovery zombie guard, audit N1)", () => {
    for (const s of ["pending", "queued", "signing", "submitted", "submitted_stuck"]) {
      expect(MINT_IN_FLIGHT.has(s)).toBe(true);
    }
    for (const s of ["minted", "finalized", "failed", "cancelled", "under_review"]) {
      expect(MINT_IN_FLIGHT.has(s)).toBe(false);
    }
  });

  it("fetchMintStatus tolerates the 404/not-found shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ txid: "x", error: "deposit not found" }), { status: 404 }),
    );
    const m = await fetchMintStatus("ab".repeat(32));
    expect(m.state).toBeNull();
    expect(m.mintTxHash).toBeNull();
  });
});

describe("resolveDepositAddress — trust-on-first-use (audit H-2)", () => {
  const ETH = "0xAbC0000000000000000000000000000000000000" as const;
  function memStore(): DepositTofuStore {
    const m = new Map<string, string>();
    return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  }

  it("pins the first address and reports firstUse", async () => {
    fetchMock.mockImplementation(async () => okJson({ pearlAddress: "prl1pgood" }));
    const store = memStore();
    const r1 = await resolveDepositAddress(ETH, store);
    expect(r1).toEqual({ address: "prl1pgood", firstUse: true });
    const r2 = await resolveDepositAddress(ETH, store);
    expect(r2).toEqual({ address: "prl1pgood", firstUse: false });
  });

  it("REFUSES if a later fetch returns a different address (persistent compromise)", async () => {
    const store = memStore();
    fetchMock.mockResolvedValueOnce(okJson({ pearlAddress: "prl1pgood" }));
    await resolveDepositAddress(ETH, store);
    fetchMock.mockResolvedValueOnce(okJson({ pearlAddress: "prl1pattacker" }));
    await expect(resolveDepositAddress(ETH, store)).rejects.toThrow(/E_DEPOSIT_ADDRESS_CHANGED/);
  });
});

describe("API identifier validation (audit C3/C7)", () => {
  const ETH = "0x1111111111111111111111111111111111111111" as const;

  it("fetchRecentDeposit rejects a non-64-hex txid (path-traversal / phantom guard)", async () => {
    fetchMock.mockResolvedValue(
      okJson({ txid: "../status", state: "pending", amountGrains: "100000000" }),
    );
    const { fetchRecentDeposit } = await import("../src/services/bridge-v1");
    expect(await fetchRecentDeposit(ETH)).toBeNull();
  });

  it("fetchRecentDeposit accepts a real 64-hex txid", async () => {
    const txid = "a".repeat(64);
    fetchMock.mockResolvedValue(
      okJson({ txid, state: "pending", amountGrains: "100000000", createdAt: 1 }),
    );
    const { fetchRecentDeposit } = await import("../src/services/bridge-v1");
    const r = await fetchRecentDeposit(ETH);
    expect(r?.txid).toBe(txid);
  });

  it("fetchMintStatus null-outs a malformed mintTxHash (etherscan-link guard)", async () => {
    fetchMock.mockResolvedValue(
      okJson({ state: "minted", mintTxHash: "0x/../address/0xattacker" }),
    );
    const { fetchMintStatus } = await import("../src/services/bridge-v1");
    const m = await fetchMintStatus("b".repeat(64));
    expect(m.mintTxHash).toBeNull();
  });

  it("fetchMintStatus keeps a valid 0x-64hex mintTxHash", async () => {
    const hash = "0x" + "c".repeat(64);
    fetchMock.mockResolvedValue(okJson({ state: "minted", mintTxHash: hash }));
    const { fetchMintStatus } = await import("../src/services/bridge-v1");
    const m = await fetchMintStatus("b".repeat(64));
    expect(m.mintTxHash).toBe(hash);
  });
});
