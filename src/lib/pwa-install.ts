// PWA install detection + prompt state machine.
//
// Two install paths:
//
//   Android / Chrome / Edge — the browser fires `beforeinstallprompt`
//     when the manifest + service-worker (or document criteria) check
//     out. We capture the event, suppress the default mini-infobar,
//     and re-fire it on user click via `event.prompt()`.
//
//   iOS Safari — no programmatic install API exists. The user must
//     tap Share → Add to Home Screen. We detect iOS Safari and
//     render the instruction sheet instead of a button.
//
// Behaviour at a glance:
//
//   isStandalone   → already installed; suppress all install UI.
//   canPromptNow   → browser captured a beforeinstallprompt; show a
//                    one-click button.
//   isIOS          → render the manual instruction sheet.
//   neither        → desktop browser / unsupported. Show nothing.
//
// The hook never throws — every environment check is `try`-guarded so
// jsdom (where vitest runs) and exotic browsers degrade to "no
// install UI available" rather than crashing the wallet.

import { useEffect, useState } from "react";

// Subset of BeforeInstallPromptEvent we actually use. The full lib.dom
// type isn't exported in older TS targets, so we duck-type it.
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

/** Is the page currently running as an installed PWA (home-screen launch)? */
export function detectStandalone(): boolean {
  try {
    if (typeof window === "undefined") return false;
    // Android / Chrome / Edge / Firefox
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    // iOS Safari sets this non-standard property on the navigator.
    const nav = window.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) return true;
    return false;
  } catch {
    return false;
  }
}

/** Is this iOS Safari (or an iPad-on-Mac UA), where install is manual? */
export function detectIOS(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const ua = window.navigator.userAgent || "";
    const platform = (window.navigator as Navigator & { platform?: string }).platform || "";
    // iPhone / iPod
    if (/iPhone|iPod/.test(ua)) return true;
    // iPad — iOS ≥ 13 reports as Mac with touch support.
    if (/iPad/.test(ua)) return true;
    if (platform === "MacIntel" && (window.navigator.maxTouchPoints ?? 0) > 1) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Is the file: protocol active? PWA install doesn't work off file:// —
 * no manifest, no service worker, no beforeinstallprompt. Used to hide
 * the install UI in the single-file offline build entirely.
 */
export function detectFileProtocol(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.location.protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * Is this desktop Safari on macOS? Safari 17+ supports installing web
 * apps via File → Add to Dock, but there's no JS API to trigger it.
 * We show manual instructions on this path the same way we do for
 * iOS Safari. Chrome/Edge/Brave on macOS fire beforeinstallprompt and
 * fall through to the one-click path.
 */
export function detectMacSafari(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const ua = window.navigator.userAgent || "";
    // Chrome / Edge / Brave all include "Safari" in the UA but ALSO
    // include "Chrome"/"Edg"/"CriOS"/"Chromium". Exclude those first.
    if (/Chrome|Chromium|Edg\/|CriOS|FxiOS|OPR\//.test(ua)) return false;
    if (!/Safari\//.test(ua)) return false;
    // Mac. Touch maxTouchPoints ≤ 1 distinguishes from iPad-as-Mac.
    const platform = (window.navigator as Navigator & { platform?: string }).platform || "";
    if (platform !== "MacIntel") return false;
    if ((window.navigator.maxTouchPoints ?? 0) > 1) return false;
    return true;
  } catch {
    return false;
  }
}

export interface PwaInstallState {
  /** Already installed; hide all install UI. */
  isStandalone: boolean;
  /** iOS Safari — show manual Add-to-Home-Screen instructions. */
  isIOS: boolean;
  /** macOS desktop Safari — show File → Add to Dock instructions. */
  isMacSafari: boolean;
  /** Running off file:// — hide all install UI. */
  isFileProtocol: boolean;
  /** Browser fired beforeinstallprompt; a one-click button will work. */
  canPromptNow: boolean;
  /** Call to trigger the native install prompt. No-op if !canPromptNow. */
  prompt: () => Promise<"accepted" | "dismissed" | "unavailable">;
}

export function usePwaInstall(): PwaInstallState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(() => detectStandalone());
  const [isIOS] = useState<boolean>(() => detectIOS());
  const [isMacSafari] = useState<boolean>(() => detectMacSafari());
  const [isFileProtocol] = useState<boolean>(() => detectFileProtocol());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeInstall = (e: Event) => {
      // Suppress the mini-infobar so we can place the prompt ourselves
      // (Settings row, Dashboard banner) at a moment that makes sense.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      // The browser already fired the install; flip standalone-detect
      // and drop the cached event. Even if matchMedia hasn't updated
      // yet (it does, immediately), this short-circuits any UI we were
      // about to render.
      setDeferred(null);
      setIsStandalone(true);
    };
    // Some browsers (e.g. very old Chromes) cache the standalone media
    // query lazily. Re-evaluate when visibility changes back to visible
    // — that's the moment the user returns from completing an install
    // on Android.
    const onVis = () => {
      if (document.visibilityState === "visible") {
        setIsStandalone(detectStandalone());
      }
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  async function prompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
    if (!deferred) return "unavailable";
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      // Per spec, the event is single-use — drop it after we resolved.
      setDeferred(null);
      return outcome;
    } catch {
      // User-gesture failure (rare): fall through to "unavailable" so
      // the UI can offer the manual instruction sheet instead.
      return "unavailable";
    }
  }

  return {
    isStandalone,
    isIOS,
    isMacSafari,
    isFileProtocol,
    canPromptNow: deferred !== null,
    prompt,
  };
}
