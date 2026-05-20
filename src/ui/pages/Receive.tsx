import { useEffect, useMemo, useRef, useState } from "react";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { dataUrl } from "../../lib/qr";

type Tab = "prl" | "wprl";

export default function Receive() {
  const addresses = useWallet((s) => s.addresses);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const [tab, setTab] = useState<Tab>("prl");

  // If the user turns the Ethereum surface off while sitting on the
  // WPRL tab, snap back to PRL so we don't try to render a tab that's
  // hidden anyway. The state is cheap to flip; no need to bounce the
  // whole page.
  useEffect(() => {
    if (!ethEnabled && tab === "wprl") setTab("prl");
  }, [ethEnabled, tab]);
  const [qr, setQr] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [prlIndex, setPrlIndex] = useState(0);
  // Timer handles tracked in refs so we can cancel on unmount. A 60-second
  // clipboard-clear left to fire after navigation could clobber a buffer
  // the user copied something else into in the meantime.
  const copiedFlagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pearlPool = useMemo(
    () => addresses?.pearlPool ?? (addresses ? [addresses.pearl] : []),
    [addresses],
  );

  const addr =
    tab === "prl" ? pearlPool[prlIndex] ?? addresses?.pearl : addresses?.eth;

  useEffect(() => {
    if (!addr) return;
    void dataUrl(addr).then(setQr);
  }, [addr]);

  useEffect(() => {
    return () => {
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current);
    };
  }, []);

  // Auto-clear the clipboard 60s after copy so an address (not as
  // sensitive as a key, but still a privacy/correlation signal) doesn't
  // sit in the OS paste buffer indefinitely. Best-effort: a clipboard
  // write that happened after this copy will be respected — we only
  // clear if the clipboard *still* contains exactly our address.
  async function copy() {
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
      copiedFlagTimerRef.current = setTimeout(() => setCopied(false), 1500);
      // Cancel any pending clear before scheduling a new one — back-to-back
      // copies of two different addresses should be governed by the LATER
      // address's window, not the earlier one's.
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current);
      const copiedAddr = addr;
      clipboardClearTimerRef.current = setTimeout(async () => {
        try {
          const current = await navigator.clipboard.readText();
          if (current === copiedAddr) {
            await navigator.clipboard.writeText("");
          }
        } catch {
          // Permissions or focus restrictions — best-effort only.
        }
      }, 60_000);
    } catch {
      // ignore
    }
  }

  return (
    <Page title="Receive">
      {ethEnabled && (
        <div className="mb-4 inline-flex rounded-xl border border-ink-200 p-1 text-sm dark:border-ink-800">
          <button
            type="button"
            onClick={() => setTab("prl")}
            className={
              tab === "prl"
                ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                : "rounded-lg px-3 py-1 text-ink-500"
            }
          >
            PRL
          </button>
          <button
            type="button"
            onClick={() => setTab("wprl")}
            className={
              tab === "wprl"
                ? "rounded-lg bg-pearl-700 px-3 py-1 text-white"
                : "rounded-lg px-3 py-1 text-ink-500"
            }
          >
            WPRL
          </button>
        </div>
      )}

      <div className="card flex flex-col items-center">
        {qr ? (
          <img
            src={qr}
            alt={`${tab.toUpperCase()} receive address QR code`}
            className="h-64 w-64 rounded-lg"
          />
        ) : (
          <div className="h-64 w-64 animate-pulse rounded-lg bg-ink-100 dark:bg-ink-800" />
        )}
        {tab === "prl" && pearlPool.length > 1 ? (
          <div className="mt-3 text-xs text-ink-500">
            Receive address #{prlIndex} of {pearlPool.length - 1}
          </div>
        ) : null}
        <div className="mt-2 max-w-full break-all font-mono text-sm">{addr}</div>
        <button type="button" onClick={copy} className="btn-secondary mt-4">
          {copied ? "Copied!" : "Copy address"}
        </button>
      </div>

      {tab === "prl" && pearlPool.length > 1 ? (
        <div className="card mt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">All receive addresses</h2>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="text-xs text-pearl-700 hover:underline"
            >
              {showAll ? "Hide" : `Show all (${pearlPool.length})`}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            Pearl L1 is UTXO-based, so your wallet uses a pool of derived addresses.
            Any of these can receive — the wallet aggregates balances across all of them.
          </p>
          {showAll ? (
            <ul className="mt-3 space-y-1 text-xs">
              {pearlPool.map((a, i) => (
                <li key={a} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPrlIndex(i)}
                    className={
                      i === prlIndex
                        ? "rounded bg-pearl-700 px-2 py-0.5 text-white"
                        : "rounded px-2 py-0.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800"
                    }
                  >
                    #{i}
                  </button>
                  <code className="break-all font-mono">{a}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p className="mt-4 text-xs text-ink-500">
        Only send {tab.toUpperCase()} to this address. {tab === "wprl" ? "This is an Ethereum address — sending other ERC-20s to it works (you'll see them in a block explorer), but the wallet only tracks WPRL." : "Pearl L1 only — do not send other assets."}
      </p>
    </Page>
  );
}
