// v0.3.0 — Vault proposal relay deeplink surface.
//
// Three pure surfaces to lock down:
//   1. routeGuardTarget — locked + /vault/tx/<token> must redirect to
//      /unlock?next=<encoded path> (not to /unlock alone) so the
//      deeplink survives the unlock round-trip and the one-time GET
//      isn't burnt before the user can act.
//   2. safeNext — open-redirect guard on Unlock.tsx. Only paths
//      matching the explicit whitelist may follow through; everything
//      else (absolute URLs, protocol-relative, control chars,
//      arbitrary internal routes) falls back to /dashboard.
//   3. proposal-store — single-shot read semantics: consumePsbt() and
//      consumeIntent() return the artifact AND clear the slot, and
//      only match their own kind.
//
// All three are pure / store-only — no jsdom, no react-router fixtures
// needed. Matches the v024-route-guard pattern.

import { describe, it, expect, beforeEach } from "vitest";
import { routeGuardTarget } from "../src/App";
import { safeNext, NEXT_PATH_PATTERNS } from "../src/ui/pages/Unlock";
import { useProposal } from "../src/state/proposal-store";

const VALID_TOKEN = "A".repeat(43); // 43 base64url chars
const VALID_TOKEN_2 = "B1_-".repeat(10) + "xyz"; // 43 chars w/ url-safe punctuation
const TOKEN_PATH = `/vault/tx/${VALID_TOKEN}`;

describe("v0.3.0 route guard — vault deeplink survives unlock", () => {
  // The whole point of the deeplink rule: a locked user clicking a TG
  // link must NOT lose the token. Without the rule, App.tsx would
  // bounce them to /unlock (no next param), they unlock, land on
  // /dashboard, and the one-time token is never opened — and worse,
  // sits there as a live single-use credential until TTL expires. The
  // rule preserves the next param so Unlock.tsx can route them back.
  it("locked + /vault/tx/<43-char token> redirects with encoded next param", () => {
    const target = routeGuardTarget("locked", TOKEN_PATH);
    expect(target).toBe(`/unlock?next=${encodeURIComponent(TOKEN_PATH)}`);
  });

  it("locked + /vault/tx/<token with url-safe punctuation> preserved", () => {
    const path = `/vault/tx/${VALID_TOKEN_2}`;
    expect(routeGuardTarget("locked", path)).toBe(
      `/unlock?next=${encodeURIComponent(path)}`,
    );
  });

  it("locked + /vault/tx/<short token> falls back to /unlock (regex must match exact length)", () => {
    // Not 43 chars → no whitelist match → no next-preserve → plain
    // /unlock bounce. The token would 404 at the relay anyway, but a
    // tight matrix is a clearer statement of intent.
    expect(routeGuardTarget("locked", "/vault/tx/short")).toBe("/unlock");
  });

  it("locked + /vault/tx/<token>/extra falls back to /unlock", () => {
    // Trailing-path suffix breaks the anchor. Defends against an
    // attacker crafting /vault/tx/<43>/foo to slip past the deeplink
    // matcher (it wouldn't reach the relay anyway, but the matrix
    // mustn't acknowledge it).
    expect(routeGuardTarget("locked", `${TOKEN_PATH}/extra`)).toBe("/unlock");
  });

  it("locked + arbitrary /vault path falls back to /unlock", () => {
    expect(routeGuardTarget("locked", "/vault/something")).toBe("/unlock");
  });

  it("unlocked + /vault/tx/<token> → allowed (no bounce; route handles it)", () => {
    expect(routeGuardTarget("unlocked", TOKEN_PATH)).toBeNull();
  });

  it("no-wallet + /vault/tx/<token> → bounce to / (must onboard first)", () => {
    // A proposal landing on a freshly-installed wallet is useless — no
    // vault exists to sign for. Bounce home so the user onboards
    // first. The relay token is sacrificed in this edge case (the
    // proposer can re-issue), which is better than auto-burning it
    // during a half-set-up state.
    expect(routeGuardTarget("no-wallet", TOKEN_PATH)).toBe("/");
  });

  it("initializing + /vault/tx/<token> → null (wait for init)", () => {
    expect(routeGuardTarget("initializing", TOKEN_PATH)).toBeNull();
  });
});

describe("v0.3.0 safeNext — open-redirect guard on Unlock", () => {
  it("null returns /dashboard fallback", () => {
    expect(safeNext(null)).toBe("/dashboard");
  });

  it("empty string returns /dashboard", () => {
    expect(safeNext("")).toBe("/dashboard");
  });

  it("valid /vault/tx/<43-char> path is honoured verbatim", () => {
    expect(safeNext(TOKEN_PATH)).toBe(TOKEN_PATH);
  });

  it("token with url-safe base64 chars (-, _) honoured", () => {
    const path = `/vault/tx/${VALID_TOKEN_2}`;
    expect(safeNext(path)).toBe(path);
  });

  it("absolute https:// URL is rejected (open-redirect)", () => {
    // The headline attack: a phishing link puts ?next=https://evil
    // in the unlock URL. Unguarded, the unlock form would post to
    // evil after a successful password entry.
    expect(safeNext("https://evil.example.com/")).toBe("/dashboard");
  });

  it("protocol-relative //evil is rejected", () => {
    // Browsers treat //host as protocol-inheriting absolute — same
    // open-redirect vector with one fewer character.
    expect(safeNext("//evil.example.com/dashboard")).toBe("/dashboard");
  });

  it("javascript: scheme is rejected", () => {
    // Doesn't start with "/", so the guard rejects on the first check.
    expect(safeNext("javascript:alert(1)")).toBe("/dashboard");
  });

  it("data: scheme is rejected", () => {
    expect(safeNext("data:text/html,<script>")).toBe("/dashboard");
  });

  it("unrelated internal path /settings is rejected (not on whitelist)", () => {
    // Whitelist-only: even though /settings is a real route, we don't
    // honour it as a post-unlock next destination. The whitelist is
    // intentionally narrow — add entries here as new deeplink surfaces
    // are introduced.
    expect(safeNext("/settings")).toBe("/dashboard");
  });

  it("/vault/tx/ (no token) rejected", () => {
    expect(safeNext("/vault/tx/")).toBe("/dashboard");
  });

  it("/vault/tx/<42-char token> rejected (must be exactly 43)", () => {
    expect(safeNext(`/vault/tx/${"A".repeat(42)}`)).toBe("/dashboard");
  });

  it("/vault/tx/<44-char token> rejected", () => {
    expect(safeNext(`/vault/tx/${"A".repeat(44)}`)).toBe("/dashboard");
  });

  it("/vault/tx/<token>/extra rejected (suffix breaks anchor)", () => {
    expect(safeNext(`${TOKEN_PATH}/extra`)).toBe("/dashboard");
  });

  it("/vault/tx/<token>?query rejected (query suffix breaks anchor)", () => {
    expect(safeNext(`${TOKEN_PATH}?evil=1`)).toBe("/dashboard");
  });

  it("NEXT_PATH_PATTERNS exposed for audit (single explicit entry)", () => {
    // Stake the whitelist size — adding a new pattern requires
    // touching this test too, which forces an audit pass.
    expect(NEXT_PATH_PATTERNS).toHaveLength(1);
  });
});

describe("v0.3.0 proposal-store — single-shot read", () => {
  beforeEach(() => {
    useProposal.getState().clear();
  });

  it("consumePsbt() returns null when slot empty", () => {
    expect(useProposal.getState().consumePsbt()).toBeNull();
  });

  it("consumeIntent() returns null when slot empty", () => {
    expect(useProposal.getState().consumeIntent()).toBeNull();
  });

  it("consumePsbt returns the artifact AND clears the slot", () => {
    useProposal.getState().set({
      kind: "psbt-base64",
      payload: "cHNidP8B",
      metadata: null,
      token: VALID_TOKEN,
    });
    const first = useProposal.getState().consumePsbt();
    expect(first).not.toBeNull();
    expect(first?.payload).toBe("cHNidP8B");
    // Second read MUST return null — guards against double-consume by
    // strict-mode double-invocation in dev, accidental re-mount, or a
    // back-button into the signing screen.
    expect(useProposal.getState().consumePsbt()).toBeNull();
    expect(useProposal.getState().pending).toBeNull();
  });

  it("consumeIntent returns the artifact AND clears the slot", () => {
    useProposal.getState().set({
      kind: "tx-intent",
      intent: {
        vaultAddress: "prl1vault",
        destination: "prl1dest",
        amountGrains: "100000000",
      },
      metadata: null,
      token: VALID_TOKEN,
    });
    const first = useProposal.getState().consumeIntent();
    expect(first?.intent.destination).toBe("prl1dest");
    expect(useProposal.getState().consumeIntent()).toBeNull();
    expect(useProposal.getState().pending).toBeNull();
  });

  it("consumePsbt does NOT consume an intent-kind slot", () => {
    // Defends against a routing bug delivering a tx-intent to the PSBT
    // page — the PSBT consumer must refuse to eat the wrong-kind
    // payload, so VaultProposal's dispatch is the only path that ever
    // wires up the right consumer for the right page.
    useProposal.getState().set({
      kind: "tx-intent",
      intent: {
        vaultAddress: "prl1vault",
        destination: "prl1dest",
        amountGrains: "1",
      },
      metadata: null,
      token: VALID_TOKEN,
    });
    expect(useProposal.getState().consumePsbt()).toBeNull();
    // The intent slot must still be intact for the right consumer.
    expect(useProposal.getState().pending).not.toBeNull();
  });

  it("consumeIntent does NOT consume a psbt-kind slot", () => {
    useProposal.getState().set({
      kind: "psbt-base64",
      payload: "cHNidP8B",
      metadata: null,
      token: VALID_TOKEN,
    });
    expect(useProposal.getState().consumeIntent()).toBeNull();
    expect(useProposal.getState().pending).not.toBeNull();
  });

  it("clear() empties the slot regardless of kind", () => {
    useProposal.getState().set({
      kind: "psbt-base64",
      payload: "x",
      metadata: null,
      token: VALID_TOKEN,
    });
    useProposal.getState().clear();
    expect(useProposal.getState().pending).toBeNull();
  });

  it("set() overwrites prior pending (last-writer-wins)", () => {
    // If two proposal links are opened in quick succession, the second
    // overwrites the first. This is intentional — only one proposal
    // can be in-flight in the UI at once, and the relay records both
    // as consumed so neither is replayable.
    useProposal.getState().set({
      kind: "psbt-base64",
      payload: "first",
      metadata: null,
      token: VALID_TOKEN,
    });
    useProposal.getState().set({
      kind: "psbt-base64",
      payload: "second",
      metadata: null,
      token: VALID_TOKEN_2,
    });
    const p = useProposal.getState().consumePsbt();
    expect(p?.payload).toBe("second");
  });
});
