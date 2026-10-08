import { useEffect, useMemo, useRef, useState } from "react";
import Page from "../components/Page";
import { useWallet } from "../../state/wallet-store";
import { useUI } from "../../state/ui-store";
import { btxSurfaceOn } from "../../lib/features";
import { dataUrl } from "../../lib/qr";
import { copyWithAutoClear } from "../../lib/clipboard";
import { useQuery } from "@tanstack/react-query";
import { cryptoWorker } from "../../crypto/worker-client";

type Tab = "prl" | "wprl" | "btx";

export default function Receive() {
  const addresses = useWallet((s) => s.addresses);
  const ethEnabled = useUI((s) => s.ethEnabled);
  const btxOn = btxSurfaceOn(useUI((s) => s.btxEnabled));
  const [tab, setTab] = useState<Tab>("prl");

  // BTX receive address — derived in the crypto worker (ML-DSA/SLH-DSA keygen,
  // ~1.8s, cached on the session). Same query key as BtxCard so it's shared.
  const btxAddrQ = useQuery({
    queryKey: ["btxAddress"],
    queryFn: () => cryptoWorker.call<"deriveBtx", { btx: string }>("deriveBtx", {}),
    staleTime: Infinity,
    enabled: btxOn,
  });
  const btxAddress = btxAddrQ.data?.btx;

  // If the user turns a surface off while sitting on its tab, snap back to PRL
  // so we don't render a tab that's hidden anyway.
  useEffect(() => {
    if (!ethEnabled && tab === "wprl") setTab("prl");
    if (!btxOn && tab === "btx") setTab("prl");
  }, [ethEnabled, btxOn, tab]);
  const [qr, setQr] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [prlIndex, setPrlIndex] = useState(0);
  // The "Copied" flag's timer dies with the page; the 60-second clipboard
  // clear doesn't (lib/clipboard.ts — it only clears a clipboard that
  // still holds exactly the copied address).
  const copiedFlagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pearlPool = useMemo(
    () => addresses?.pearlPool ?? (addresses ? [addresses.pearl] : []),
    [addresses],
  );

  const addr =
    tab === "prl"
      ? pearlPool[prlIndex] ?? addresses?.pearl
      : tab === "btx"
      ? btxAddress
      : addresses?.eth;

  useEffect(() => {
    if (!addr) return;
    void dataUrl(addr).then(setQr);
  }, [addr]);

  useEffect(() => {
    return () => {
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
    };
  }, []);

  async function copy() {
    if (!addr) return;
    try {
      await copyWithAutoClear(addr);
      setCopied(true);
      if (copiedFlagTimerRef.current) clearTimeout(copiedFlagTimerRef.current);
      copiedFlagTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <Page title="Receive">
      <p className="mb-6 text-sm leading-7 text-text-2">
        Share your address or QR code with the sender. Check the asset and network before sending.
      </p>
      {(ethEnabled || btxOn) && (
        <div className="mb-6 inline-flex max-w-full flex-wrap gap-1 rounded-pb border border-line bg-surface-2 p-1 text-sm">
          <button
            type="button"
            onClick={() => setTab("prl")}
            aria-pressed={tab === "prl"}
            className={
              tab === "prl"
                ? "min-h-11 min-w-16 rounded-pb bg-accent-bg px-4 py-2 font-semibold text-on-accent"
                : "min-h-11 min-w-16 rounded-pb px-4 py-2 text-text-3 hover:text-heading"
            }
          >
            PRL
          </button>
          {ethEnabled && (
            <button
              type="button"
              onClick={() => setTab("wprl")}
              aria-pressed={tab === "wprl"}
              className={
                tab === "wprl"
                  ? "min-h-11 min-w-16 rounded-pb bg-accent-bg px-4 py-2 font-semibold text-on-accent"
                  : "min-h-11 min-w-16 rounded-pb px-4 py-2 text-text-3 hover:text-heading"
              }
            >
              WPRL
            </button>
          )}
          {btxOn && (
            <button
              type="button"
              onClick={() => setTab("btx")}
              aria-pressed={tab === "btx"}
              className={
                tab === "btx"
                  ? "min-h-11 min-w-16 rounded-pb bg-accent-bg px-4 py-2 font-semibold text-on-accent"
                  : "min-h-11 min-w-16 rounded-pb px-4 py-2 text-text-3 hover:text-heading"
              }
            >
              BTX
            </button>
          )}
        </div>
      )}

      <div className="card flex flex-col items-center gap-2">
        {qr ? (
          <img
            src={qr}
            alt={`${tab.toUpperCase()} receive address QR code`}
            className="h-auto w-64 max-w-full border border-line bg-white p-2"
          />
        ) : (
          <div className="aspect-square w-64 max-w-full animate-pulse rounded-pb bg-surface-2" role="status" aria-label="Loading receive QR code" />
        )}
        {tab === "prl" && pearlPool.length > 1 ? (
          <div className="mt-3 text-xs text-text-3">
            Receive address #{prlIndex} · one of {pearlPool.length} addresses in this wallet
          </div>
        ) : null}
        <div className="mt-3 w-full break-all border-y border-line py-4 text-center font-mono text-sm leading-6">{addr}</div>
        <button type="button" onClick={copy} className="btn-primary mt-2 w-full sm:w-auto">
          {copied ? "Copied!" : "Copy address"}
        </button>
      </div>

      {tab === "prl" && pearlPool.length > 1 ? (
        <div className="mt-8 border-t border-heading pt-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4">
            <h2 className="text-sm font-semibold">All receive addresses</h2>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className="min-h-11 shrink-0 text-sm text-accent underline decoration-line underline-offset-4 hover:decoration-accent"
            >
              {showAll ? "Hide" : `Show all (${pearlPool.length})`}
            </button>
          </div>
          <p className="mt-2 text-sm leading-6 text-text-2">
            These Pearl addresses belong to the same wallet. Any of them can receive PRL;
            PearlWallet combines their balances. Select a number to show its QR code above.
          </p>
          {showAll ? (
            <ul className="mt-3 divide-y divide-line text-xs">
              {pearlPool.map((a, i) => (
                <li key={a} className="flex items-center gap-3 py-2">
                  <button
                    type="button"
                    onClick={() => setPrlIndex(i)}
                    aria-pressed={i === prlIndex}
                    className={
                      i === prlIndex
                        ? "min-h-11 min-w-11 rounded-pb bg-accent-bg px-2 py-2 text-on-accent"
                        : "min-h-11 min-w-11 rounded-pb px-2 py-2 text-text-3 hover:bg-surface-2"
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

      <p className="mt-6 border-l-2 border-warn-line bg-warn-bg p-4 text-sm leading-6 text-warn">
        Only send {tab.toUpperCase()} to this address.{" "}
        {tab === "wprl"
          ? "This is an Ethereum address — sending other ERC-20s to it works (you'll see them in a block explorer), but the wallet only tracks WPRL."
          : tab === "prl"
          ? "Pearl L1 only — do not send other assets."
          : null}
        {btxOn && tab === "btx" && (
          <>This is a post-quantum P2MR address (btx1z…) on the BTX L1 — send only native BTX. WBTX (wrapped BTX) lives on Ethereum; do not send it here.</>
        )}
      </p>
    </Page>
  );
}
