// Build-time feature switches for user-visible surfaces.
//
// React-free on purpose: imported by App.tsx, pages, the crypto worker and
// node-env tests alike.

/**
 * Master switch for the BTX front end (balance card, Receive tab, Send BTX,
 * Settings sections). When false, no BTX surface renders and the worker
 * refuses BTX derivation/signing, regardless of the persisted per-user
 * `btxEnabled` toggle (which stays in ui-store so the storage key and the
 * BTX services/tests are unaffected).
 *
 * Typed as `boolean` (not the literal `false`) so gated code still
 * type-checks as reachable and the switch can be flipped in one place.
 */
export const BTX_UI_ENABLED: boolean = false;

/** Effective BTX visibility: the build switch AND the user's toggle. */
export function btxSurfaceOn(
  btxEnabled: boolean,
  uiEnabled: boolean = BTX_UI_ENABLED,
): boolean {
  return uiEnabled && btxEnabled;
}

/**
 * Pure routing decision for BTX-only paths. Returns "/dashboard" when the
 * path is a BTX surface that must not render (build switch off, or user
 * toggle off), else null. Mirrors routeGuardTarget's shape so it is
 * unit-testable without a DOM.
 */
export function btxRouteTarget(
  path: string,
  btxEnabled: boolean = true,
  uiEnabled: boolean = BTX_UI_ENABLED,
): string | null {
  if (path !== "/send/btx") return null;
  return btxSurfaceOn(btxEnabled, uiEnabled) ? null : "/dashboard";
}

/** Worker-side hard stop: throws E_BTX_DISABLED when the BTX UI is off. */
export function assertBtxUiEnabled(uiEnabled: boolean = BTX_UI_ENABLED): void {
  if (!uiEnabled) throw new Error("E_BTX_DISABLED");
}
