import { useEffect, useState } from "react";
import "./ascii-pulse.css";

// Presentation-only receipt memory: revisiting bridge activity must not replay
// old crossings. Nothing here reads a wallet, starts a request or signs anything.
const openedAt = Date.now();
const seen = new Set<string>();
const ramp = ".:;+x#@";

function glyphs(ring: boolean): string {
  return Array.from({ length: 13 }, (_, row) =>
    Array.from({ length: 31 }, (_, col) => {
      const x = (col - 15) * 4.8;
      const y = (row - 6) * 8;
      const radius = Math.hypot(x, y);
      if (ring) return Math.abs(radius - 43) < 2.8 ? "." : " ";
      if (radius >= 25) return " ";
      const nx = x / 25;
      const ny = y / 25;
      const nz = Math.sqrt(1 - nx * nx - ny * ny);
      const light = Math.max(0, -.5 * nx - .55 * ny + .67 * nz);
      return ramp[Math.round((.83 - .65 * light) * (ramp.length - 1))];
    }).join(""),
  ).join("\n");
}

const pearl = glyphs(false);
const ripple = glyphs(true);
type Receipt = { id: string; createdAt: number };

/** Mount only in an existing broadcast/result view. One 1.5s CSS ripple, then
 * a static pearl. Bridge receipts predating this page session stay static. */
export default function AsciiPulse({ receipt }: { receipt?: Receipt }) {
  const [settled, setSettled] = useState(() =>
    typeof window === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    !!(receipt && (receipt.createdAt < openedAt || seen.has(receipt.id))),
  );
  const [paused, setPaused] = useState(() => typeof document !== "undefined" && document.hidden);

  useEffect(() => {
    if (receipt) seen.add(receipt.id);
    if (settled) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const visibility = () => setPaused(document.hidden);
    const preference = () => { if (motion.matches) setSettled(true); };
    visibility();
    preference();
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", preference);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", preference);
    };
  }, [settled, receipt?.id]);

  return (
    <div className="ascii-pulse" aria-hidden="true" data-phase={settled ? "settled" : "playing"} data-paused={paused}>
      <pre className="ascii-pulse-pearl">{pearl}</pre>
      <pre className="ascii-pulse-ring" onAnimationEnd={() => setSettled(true)}>{ripple}</pre>
    </div>
  );
}
