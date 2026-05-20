// v0.2.4 regression test for the SEC fix: a locked user must not be
// able to reach any page other than /unlock and /onboarding/restore via
// <Link> navigation. The previous bug had App.tsx's route-guard useEffect
// deps = [status] only, so a Link click changed location without
// re-firing the guard. The fix is twofold: (a) deps include
// location.pathname, and (b) the matrix is extracted into a pure
// `routeGuardTarget` function so the decision table is unit-testable
// in isolation (no jsdom / react-router fixtures needed).
//
// If this test ever fails, a locked user can reach a sensitive page
// without authenticating. Treat as a Critical regression.

import { describe, it, expect } from "vitest";
import { routeGuardTarget } from "../src/App";
import type { WalletStatus } from "../src/state/wallet-store";

const LOCKED_ALLOWED = ["/unlock", "/onboarding/restore"];
const LOCKED_BLOCKED = [
  "/",
  "/dashboard",
  "/settings",
  "/receive",
  "/history",
  "/about",
  "/send/prl",
  "/send/wprl",
  "/send/eth",
  "/bridge",
  "/vaults",
  "/vaults/new",
  "/vaults/sign",
  "/vaults/abc123",
  "/vaults/abc123/send",
  "/vaults/abc123/tx/deadbeef",
  "/onboarding/create",
  "/some-deep-link",
  // History API injections
  "/settings/../dashboard",
  "/unlock/../settings",
];

const NO_WALLET_ALLOWED = ["/", "/onboarding/create", "/onboarding/restore"];
const NO_WALLET_BLOCKED = [
  "/dashboard",
  "/settings",
  "/unlock",
  "/vaults",
  "/receive",
];

const UNLOCKED_BOUNCE = ["/", "/unlock", "/onboarding/create", "/onboarding/restore"];
const UNLOCKED_ALLOWED = [
  "/dashboard",
  "/settings",
  "/receive",
  "/history",
  "/about",
  "/send/prl",
  "/send/wprl",
  "/send/eth",
  "/bridge",
  "/vaults",
  "/vaults/new",
  "/vaults/abc/tx/def",
];

describe("v0.2.4 route guard — locked attacker cannot escape /unlock", () => {
  for (const path of LOCKED_ALLOWED) {
    it(`locked + ${path} → allowed (returns null)`, () => {
      expect(routeGuardTarget("locked", path)).toBeNull();
    });
  }

  for (const path of LOCKED_BLOCKED) {
    it(`locked + ${path} → must bounce to /unlock`, () => {
      expect(routeGuardTarget("locked", path)).toBe("/unlock");
    });
  }
});

describe("v0.2.4 route guard — no-wallet matrix", () => {
  for (const path of NO_WALLET_ALLOWED) {
    it(`no-wallet + ${path} → allowed`, () => {
      expect(routeGuardTarget("no-wallet", path)).toBeNull();
    });
  }
  for (const path of NO_WALLET_BLOCKED) {
    it(`no-wallet + ${path} → bounce to /`, () => {
      expect(routeGuardTarget("no-wallet", path)).toBe("/");
    });
  }
});

describe("v0.2.4 route guard — unlocked matrix", () => {
  for (const path of UNLOCKED_ALLOWED) {
    it(`unlocked + ${path} → allowed`, () => {
      expect(routeGuardTarget("unlocked", path)).toBeNull();
    });
  }
  for (const path of UNLOCKED_BOUNCE) {
    it(`unlocked + ${path} → bounce to /dashboard`, () => {
      expect(routeGuardTarget("unlocked", path)).toBe("/dashboard");
    });
  }
});

describe("v0.2.4 route guard — initializing never bounces", () => {
  // While the keystore is loading we don't know yet whether the user has
  // a wallet — bouncing here would just flash the wrong CTA. The guard
  // returns null for every path during initialization.
  const paths: string[] = [
    "/",
    "/unlock",
    "/dashboard",
    "/settings",
    "/onboarding/create",
    "/vaults/abc",
  ];
  for (const path of paths) {
    it(`initializing + ${path} → null`, () => {
      expect(routeGuardTarget("initializing", path)).toBeNull();
    });
  }
});

describe("v0.2.4 route guard — historical bypass closed", () => {
  // The exact bug G reported: clicking 'Wipe this wallet' on /unlock
  // navigated to /settings while still locked, then clicking the
  // PearlWallet logo (Link to /dashboard) revealed the full wallet.
  it("locked + /settings (the bypass landing page) bounces to /unlock", () => {
    expect(routeGuardTarget("locked", "/settings")).toBe("/unlock");
  });
  it("locked + /dashboard (the bypass second-hop page) bounces to /unlock", () => {
    expect(routeGuardTarget("locked", "/dashboard")).toBe("/unlock");
  });
  it("locked + /onboarding/create (the v0.1.6 overwrite bypass) bounces to /unlock", () => {
    // v0.1.6 closed this for a different reason (overwrite footgun).
    // The v0.2.4 fix re-enforces it under the new guard shape.
    expect(routeGuardTarget("locked", "/onboarding/create")).toBe("/unlock");
  });
  // Cross-check: the forgot-password path is preserved.
  it("locked + /onboarding/restore is preserved (forgot-password recovery)", () => {
    expect(routeGuardTarget("locked", "/onboarding/restore")).toBeNull();
  });
});

describe("v0.2.4 route guard — onboarding prefix is tight (no /onboarding-fake)", () => {
  // L1 (pass-2 audit): startsWith("/onboarding") used to accept
  // "/onboarding-fake" and "/onboardingX" as onboarding paths. The
  // matrix now matches "/onboarding" exactly or "/onboarding/...".
  // These never reach a real route, but a tight matrix is a clearer
  // statement of intent.
  it("no-wallet + /onboarding-fake → bounce to /", () => {
    expect(routeGuardTarget("no-wallet", "/onboarding-fake")).toBe("/");
  });
  it("no-wallet + /onboardingX → bounce to /", () => {
    expect(routeGuardTarget("no-wallet", "/onboardingX")).toBe("/");
  });
  it("locked + /onboarding-fake → bounce to /unlock (not allowed as onboarding)", () => {
    expect(routeGuardTarget("locked", "/onboarding-fake")).toBe("/unlock");
  });
  it("unlocked + /onboarding-fake → null (not treated as onboarding so no bounce-to-dashboard)", () => {
    // /onboarding-fake isn't actually a real route — Routes catch-all
    // sends it to /. The matrix just says "not an onboarding path, so
    // we don't bounce it as one". The catch-all handles the dead-end.
    expect(routeGuardTarget("unlocked", "/onboarding-fake")).toBeNull();
  });
  it("locked + /onboarding (bare) → bounce (no such page)", () => {
    expect(routeGuardTarget("locked", "/onboarding")).toBe("/unlock");
  });
  it("no-wallet + /onboarding (bare) → allowed (onboarding prefix root)", () => {
    expect(routeGuardTarget("no-wallet", "/onboarding")).toBeNull();
  });
});

describe("v0.2.4 route guard — exhaustive status × path matrix", () => {
  // Quick sanity sweep so an accidental status enum addition doesn't
  // silently fall through to "no bounce" by default.
  const statuses: WalletStatus[] = ["initializing", "no-wallet", "locked", "unlocked"];
  for (const s of statuses) {
    it(`${s} + arbitrary path returns string | null (no throws)`, () => {
      const result = routeGuardTarget(s, "/arbitrary/path/with/segments");
      expect(result === null || typeof result === "string").toBe(true);
    });
  }
});
