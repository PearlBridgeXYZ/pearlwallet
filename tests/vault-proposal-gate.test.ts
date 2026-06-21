// Locks the load-bearing invariant for the /vault/tx/:token deeplink: the
// one-time relay token is consumed ONLY when the user can actually act on
// it — Vaults enabled, wallet unlocked, token present. A regression here
// would silently burn a cosign request for a user who has opted out of the
// Vaults surface (audit finding, v0.5.0).

import { describe, it, expect } from "vitest";
import { shouldConsumeProposal } from "../src/services/vault-proposal-gate";

const TOKEN = "A".repeat(43);

describe("shouldConsumeProposal", () => {
  it("consumes only when Vaults enabled AND unlocked AND token present", () => {
    expect(
      shouldConsumeProposal({ multisigEnabled: true, status: "unlocked", token: TOKEN }),
    ).toBe(true);
  });

  it("never consumes when the Vaults surface is opted out (the fix)", () => {
    // Even fully unlocked with a valid token, an opted-out user must not
    // have the one-time token burned.
    expect(
      shouldConsumeProposal({ multisigEnabled: false, status: "unlocked", token: TOKEN }),
    ).toBe(false);
  });

  it("does not consume while locked", () => {
    expect(
      shouldConsumeProposal({ multisigEnabled: true, status: "locked", token: TOKEN }),
    ).toBe(false);
    expect(
      shouldConsumeProposal({ multisigEnabled: true, status: "onboarding", token: TOKEN }),
    ).toBe(false);
  });

  it("does not consume without a token", () => {
    expect(
      shouldConsumeProposal({ multisigEnabled: true, status: "unlocked", token: undefined }),
    ).toBe(false);
    expect(
      shouldConsumeProposal({ multisigEnabled: true, status: "unlocked", token: "" }),
    ).toBe(false);
  });

  it("Vaults-off dominates every other condition", () => {
    for (const status of ["unlocked", "locked", "onboarding"]) {
      for (const token of [TOKEN, "", undefined]) {
        expect(
          shouldConsumeProposal({ multisigEnabled: false, status, token }),
        ).toBe(false);
      }
    }
  });
});
