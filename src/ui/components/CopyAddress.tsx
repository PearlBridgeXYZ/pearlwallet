// Full-address display + one-click clipboard copy. Mirrors the
// 60-second auto-clear policy from Receive.tsx so an address (still
// a correlation signal even if less sensitive than a key) doesn't
// sit in the OS paste buffer indefinitely. Used everywhere the user
// may need to paste their own address — never condensed/ellipsized
// (shortAddr is misleading because an ellipsis is not paste-able).
//
// The auto-clear is best-effort: a clipboard write that happened
// after this copy will be respected (we only clear if the buffer
// still contains exactly our address at the 60s mark).

import { useEffect, useRef, useState } from "react";

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
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
      copiedFlagTimerRef.current = setTimeout(() => setCopied(false), 1500);
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current);
      const copiedValue = value;
      clipboardClearTimerRef.current = setTimeout(async () => {
        try {
          const current = await navigator.clipboard.readText();
          if (current === copiedValue) {
            await navigator.clipboard.writeText("");
          }
        } catch {
          // Permissions or focus restrictions — best-effort only.
        }
      }, 60_000);
    } catch {
      // Clipboard API unavailable (insecure context, denied permission).
      // Caller's full-address render still lets the user select+copy
      // manually, so no fallback UI needed.
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <div className="text-xs text-ink-500">{label}</div>
      ) : null}
      <div className="flex items-start gap-2">
        <code
          className={
            addressClassName ?? "min-w-0 flex-1 break-all font-mono text-sm"
          }
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-lg border border-ink-300 px-2 py-1 text-xs hover:bg-ink-100 dark:border-ink-700 dark:hover:bg-ink-800"
          aria-label={`Copy ${label ?? "address"}`}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      {hint ? (
        <div className="text-xs text-ink-500">{hint}</div>
      ) : null}
    </div>
  );
}
