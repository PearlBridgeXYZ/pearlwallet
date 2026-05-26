// Install-as-app surface. Three render paths:
//
//   1. Already-installed → nothing.
//   2. Android/Chrome/Edge with beforeinstallprompt cached → "Install"
//      button that triggers the native prompt.
//   3. iOS Safari → expandable Add-to-Home-Screen instructions
//      (there's no JS API on iOS — the user has to tap Share).
//
// Two variants:
//
//   <InstallPWA variant="card" />    full card with explainer text;
//                                    use in Settings.
//   <InstallPWA variant="banner" />  compact dismissible banner; use
//                                    on Dashboard.
//
// The banner variant respects a "dismissed" localStorage flag so a
// user who said "not now" once doesn't see it every dashboard render.
// The Settings card variant ignores that flag — finding the install
// option is the WHOLE reason someone scrolled to Settings.

import { useState } from "react";
import { usePwaInstall } from "../../lib/pwa-install";

const DISMISS_KEY = "pearl-wallet-pwa-banner-dismissed";

interface Props {
  variant?: "card" | "banner";
}

function isBannerDismissed(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function setBannerDismissed(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Storage quota / private-mode lockout — banner will reappear next
    // load, which is fine. Better than crashing the dashboard.
  }
}

export default function InstallPWA({ variant = "card" }: Props) {
  const install = usePwaInstall();
  const [dismissed, setDismissed] = useState<boolean>(() => isBannerDismissed());
  const [iosOpen, setIosOpen] = useState(false);
  const [macOpen, setMacOpen] = useState(false);
  const [result, setResult] = useState<"accepted" | "dismissed" | null>(null);

  // Hide on the offline single-file build (no manifest = nothing to
  // install) and once the wallet is already running as a standalone
  // PWA.
  if (install.isStandalone) return null;
  if (install.isFileProtocol) return null;

  // Banner variant respects the dismissed flag. Settings variant
  // doesn't — it lives in Settings precisely so the user can find it.
  if (variant === "banner" && dismissed) return null;

  // Nothing the browser can offer AND not iOS AND not macOS Safari →
  // suppress entirely (desktop Firefox, in-app browsers, etc.). Showing
  // a useless button or instructions for a different platform is noise.
  if (!install.canPromptNow && !install.isIOS && !install.isMacSafari) return null;

  async function onInstall() {
    const outcome = await install.prompt();
    if (outcome === "accepted") setResult("accepted");
    else if (outcome === "dismissed") setResult("dismissed");
    // "unavailable" stays as null — the button is gone because
    // canPromptNow flipped to false, so no UI feedback needed.
  }

  function onDismiss() {
    setBannerDismissed();
    setDismissed(true);
  }

  // Shared visuals so banner + card don't drift apart.
  // The banner variant uses the brand-primary gradient and bigger type so
  // it can't be missed on the dashboard; the card variant uses the muted
  // pearl-50/900 background that matches the rest of Settings.
  const wrapper =
    variant === "banner"
      ? "rounded-2xl border border-pearl-300 bg-gradient-to-br from-pearl-100 to-pearl-200 p-5 shadow-sm dark:border-pearl-700 dark:from-pearl-800 dark:to-pearl-900"
      : "card";
  const heading =
    variant === "banner"
      ? "text-base font-semibold sm:text-lg"
      : "text-sm font-semibold";
  const body =
    variant === "banner"
      ? "mt-1 text-sm text-ink-700 dark:text-ink-200"
      : "mt-1 text-xs text-ink-600 dark:text-ink-300";
  const primaryBtn =
    "tap mt-3 inline-flex w-full items-center justify-center rounded-xl bg-pearl-700 px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-pearl-800 active:bg-pearl-900 sm:w-auto";
  const secondaryBtn =
    "tap mt-3 inline-flex w-full items-center justify-center rounded-xl border border-pearl-700 px-5 py-3 text-base font-semibold text-pearl-700 hover:bg-pearl-50 active:bg-pearl-100 dark:border-pearl-400 dark:text-pearl-200 dark:hover:bg-pearl-900 sm:w-auto";

  // ── iOS instructions ──────────────────────────────────────────────
  if (install.isIOS) {
    return (
      <div className={wrapper}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h3 className={heading}>📱 Install as App</h3>
            <p className={body}>
              Add PearlWallet to your home screen — opens full-screen like a
              native app, faster launch, no browser chrome.
            </p>
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              <span className="font-semibold">Tip:</span> on iPhone/iPad,
              install <em>before</em> creating your wallet. Safari and the
              installed app use separate storage on iOS, so a wallet
              created here won't appear in the app (and vice versa).
            </p>
            <button
              type="button"
              className={secondaryBtn}
              aria-expanded={iosOpen}
              onClick={() => setIosOpen((v) => !v)}
            >
              {iosOpen ? "Hide instructions" : "Install as App"}
            </button>
            {iosOpen && (
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-700 dark:text-ink-200">
                <li>Tap the Share button at the bottom of Safari (the square with an up-arrow).</li>
                <li>
                  Scroll and tap <span className="font-semibold">Add to Home Screen</span>.
                </li>
                <li>Confirm the name "PearlWallet" and tap Add.</li>
                <li>Launch from the new home-screen icon — it opens full-screen with no Safari bar.</li>
              </ol>
            )}
          </div>
          {variant === "banner" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss install banner"
              className="-mr-1 -mt-1 rounded-md p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-900 dark:hover:bg-ink-800 dark:hover:text-ink-100"
            >
              ×
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── macOS Safari (File → Add to Dock) ─────────────────────────────
  // Safari 17+ on macOS supports adding web apps to the Dock but has no
  // JS API to trigger it — the user picks the menu item.
  if (install.isMacSafari) {
    return (
      <div className={wrapper}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h3 className={heading}>📱 Install as App</h3>
            <p className={body}>
              Add PearlWallet to your Dock — opens in its own window, no
              browser chrome, faster launch.
            </p>
            <button
              type="button"
              className={secondaryBtn}
              aria-expanded={macOpen}
              onClick={() => setMacOpen((v) => !v)}
            >
              {macOpen ? "Hide instructions" : "Install as App"}
            </button>
            {macOpen && (
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-700 dark:text-ink-200">
                <li>In Safari's menu bar, open the <span className="font-semibold">File</span> menu.</li>
                <li>
                  Choose <span className="font-semibold">Add to Dock…</span>{" "}
                  (Safari 17 or newer).
                </li>
                <li>Confirm the name "PearlWallet" and click Add.</li>
                <li>Launch from the Dock — it opens in its own window without Safari around it.</li>
              </ol>
            )}
          </div>
          {variant === "banner" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss install banner"
              className="-mr-1 -mt-1 rounded-md p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-900 dark:hover:bg-ink-800 dark:hover:text-ink-100"
            >
              ×
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Android / Chrome / Edge ───────────────────────────────────────
  return (
    <div className={wrapper}>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h3 className={heading}>📱 Install as App</h3>
          <p className={body}>
            Add PearlWallet to your home screen — opens full-screen like a
            native app, faster launch, no browser chrome.
          </p>
          <button type="button" onClick={onInstall} className={primaryBtn}>
            Install as App
          </button>
          {result === "dismissed" && (
            <p className="mt-2 text-xs text-ink-500">
              No problem — you can install any time from Settings.
            </p>
          )}
          {result === "accepted" && (
            <p className="mt-2 text-xs text-green-700 dark:text-green-400">
              Installed. Launch from your home screen.
            </p>
          )}
        </div>
        {variant === "banner" && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss install banner"
            className="-mr-1 -mt-1 rounded-md p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-900 dark:hover:bg-ink-800 dark:hover:text-ink-100"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
