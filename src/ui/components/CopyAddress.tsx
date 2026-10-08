// Full-address display + one-click clipboard copy, with the 60-second
// auto-clear of lib/clipboard.ts (it survives leaving the screen). Used
// everywhere the user may need to paste their own address — never
// condensed/ellipsized (shortAddr is misleading because an ellipsis is
// not paste-able).

import { useEffect, useRef, useState } from "react";
import { copyWithAutoClear } from "../../lib/clipboard";

interface Props {
  /** The full address. */
  value: string;
  /** Optional small label above the address (e.g. "Pearl L1"). */
  label?: string;
  /** Optional extra hint shown under the address (e.g. "WPRL + ETH"). */
  hint?: string;
  /** Tailwind class override for the address text — defaults to font-mono break-all. */
  addressClassName?: string;
}

export default function CopyAddress({ value, label, hint, addressClassName }: Props) {
  const [copied, setCopied] = useState(false);
  const copiedFlagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only the "Copied" flag dies with the component; the clipboard clear
  // must not (lib/clipboard.ts).
  useEffect(() => {
    return () => {
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
    };
  }, []);

  async function copy() {
    try {
      await copyWithAutoClear(value);
      setCopied(true);
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
      copiedFlagTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure context, denied permission).
      // Caller's full-address render still lets the user select+copy
      // manually, so no fallback UI needed.
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {label ? (
        <div className="label mb-0">{label}</div>
      ) : null}
      <div className="flex items-center gap-3 rounded-pb border border-line bg-surface-2 p-3">
        <code
          className={
            addressClassName ?? "min-w-0 flex-1 select-all break-all font-mono text-xs leading-relaxed text-text sm:text-sm"
          }
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="btn-secondary shrink-0 px-3 text-xs"
          aria-label={`Copy ${label ?? "address"}`}
        >
          <span role="status" aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {hint ? (
        <div className="text-xs leading-relaxed text-text-3">{hint}</div>
      ) : null}
    </div>
  );
}
