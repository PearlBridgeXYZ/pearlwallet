// Router selection. React-free so it is unit-testable in node.
//
// The web build keeps path URLs (BrowserRouter): vault proposal links such as
// /vault/tx/<token> are already in the wild and Cloudflare serves the SPA
// fallback for deep links.
//
// The offline single-file build is opened from file://. There the pathname is
// the file's own path, and BrowserRouter's redirect to "/" calls
// history.replaceState with URL file:/// — which an opaque-origin document is
// not allowed to create (SecurityError, blank page). HashRouter keeps the
// document path fixed and routes inside the fragment instead.
export type RouterKind = "browser" | "hash";

export function routerKindFor(protocol: string): RouterKind {
  return protocol === "file:" ? "hash" : "browser";
}
