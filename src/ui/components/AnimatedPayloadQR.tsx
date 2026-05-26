// Animated QR display for offline-signing payloads.
//
// Renders a single QR when the payload fits in one frame, or cycles
// through multiple frames at a fixed interval so a phone camera can
// pick them up one at a time. The frame counter ("3 / 7") tells the
// user how much the receiving side has to scan.
//
// We deliberately don't try to be clever about scan speed — 600ms per
// frame is comfortably above the minimum a typical iPhone camera needs
// to lock focus and decode. Users with faster cameras can speed it up
// via the dropdown; users on a flaky old device can slow it down.

import { useEffect, useMemo, useState } from "react";
import { dataUrl } from "../../lib/qr";
import {
  FRAME_CHUNK_BYTES,
  splitIntoFrames,
} from "../../lib/offline-signing/qr-frames";

interface Props {
  /** The base64url-encoded payload to transmit. */
  payload: string;
  /** Frame size override (bytes before the header). */
  chunkBytes?: number;
}

const SPEED_OPTIONS = [
  { ms: 1200, label: "Slow (1.2s/frame)" },
  { ms: 800, label: "Normal (0.8s/frame)" },
  { ms: 500, label: "Fast (0.5s/frame)" },
];
const DEFAULT_SPEED_MS = 800;

export default function AnimatedPayloadQR({ payload, chunkBytes }: Props) {
  const { frames } = useMemo(
    () => splitIntoFrames(payload, chunkBytes ?? FRAME_CHUNK_BYTES),
    [payload, chunkBytes],
  );
  const [idx, setIdx] = useState(0);
  const [speedMs, setSpeedMs] = useState(DEFAULT_SPEED_MS);
  const [src, setSrc] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // Reset index whenever the payload (and thus frames) changes.
  useEffect(() => {
    setIdx(0);
  }, [frames]);

  // Render the current frame to a data-URL QR. Re-render on idx change.
  useEffect(() => {
    let cancelled = false;
    const frame = frames[idx % frames.length] ?? "";
    void dataUrl(frame, 320).then((u) => {
      if (!cancelled) setSrc(u);
    });
    return () => {
      cancelled = true;
    };
  }, [frames, idx]);

  // Cycle through frames at the chosen speed. Single-frame payloads
  // don't animate — there's nothing to cycle.
  useEffect(() => {
    if (frames.length <= 1) return;
    if (paused) return;
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % frames.length);
    }, speedMs);
    return () => clearInterval(id);
  }, [frames, speedMs, paused]);

  return (
    <div className="flex flex-col items-center gap-3">
      {/* The QR itself fits within the parent container — the rendered
          PNG is 320px square, but we let the <img> shrink with the
          card on narrow screens (max-w 100% + auto height) so it stays
          fully visible on a 360px-wide phone. */}
      <div className="rounded bg-white p-2">
        {src ? (
          <img
            src={src}
            alt={`QR frame ${idx + 1} of ${frames.length}`}
            width={320}
            height={320}
            className="h-auto w-full max-w-[320px]"
          />
        ) : (
          <div className="aspect-square w-full max-w-[320px] animate-pulse rounded bg-ink-100 dark:bg-ink-800" />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-ink-500">
        <span className="tabular-nums">
          Frame {idx + 1} / {frames.length}
        </span>
        {frames.length > 1 && (
          <>
            <button
              type="button"
              className="tap rounded border px-3 py-2 text-xs hover:bg-ink-100 dark:hover:bg-ink-800"
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <select
              className="tap rounded border bg-transparent px-3 py-2 text-xs"
              value={speedMs}
              onChange={(e) => setSpeedMs(Number(e.target.value))}
            >
              {SPEED_OPTIONS.map((o) => (
                <option key={o.ms} value={o.ms}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="tap rounded border px-3 py-2 text-xs hover:bg-ink-100 dark:hover:bg-ink-800"
              onClick={() => setIdx((i) => (i + 1) % frames.length)}
            >
              Next
            </button>
          </>
        )}
      </div>
    </div>
  );
}
