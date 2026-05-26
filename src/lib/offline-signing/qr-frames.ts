// Multi-frame QR transport for offline-signing payloads.
//
// A single QR with error-correction "M" tops out around ~1.5kB of data
// before the symbol becomes too dense for a phone camera to scan
// reliably. A Pearl tx with 8 inputs + a tip output is already ~1.2kB
// once base64-encoded — and we want headroom for 24-input, multi-output
// transactions, so we chunk.
//
// Frame format (ASCII, no whitespace):
//
//   PWQR/v1/<sessionId>/<idx>/<total>/<chunkData>
//
// where <sessionId> is a 6-char URL-safe random id (so a reader can tell
// two different transactions apart if a user accidentally points the
// camera at the wrong screen), <idx> is 0-based, <total> is the total
// frame count, and <chunkData> is a contiguous slice of the base64url
// payload.
//
// A single-frame payload is just `PWQR/v1/<sid>/0/1/<allData>`.
//
// The decoder accepts frames in any order, deduplicates, and returns
// `{ complete: true, data }` once it has every chunk. This is the
// standard animated-QR pattern (BBQr, UR, etc) — we keep it explicit
// and simple because we're not optimizing for streaming, just for the
// "user films a 30-frame animation with their phone" UX.

const FRAME_PREFIX = "PWQR/v1/";

/** Max payload bytes per frame BEFORE the header. 1100 keeps the total
 *  symbol comfortably under 1500 for camera scanning even with the
 *  prefix + indices. Tuned conservatively — we'd rather animate 1 extra
 *  frame than have a phone fail to lock on. */
export const FRAME_CHUNK_BYTES = 1100;

export interface SplitResult {
  sessionId: string;
  frames: string[];
}

/** Split a string payload into one or more QR frames. */
export function splitIntoFrames(
  payload: string,
  chunkSize: number = FRAME_CHUNK_BYTES,
  sessionId: string = randomSessionId(),
): SplitResult {
  if (chunkSize <= 0) throw new Error("E_QR_CHUNK_SIZE");
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(sessionId)) {
    throw new Error("E_QR_SESSION_ID: must be 1-16 url-safe chars");
  }
  const total = Math.max(1, Math.ceil(payload.length / chunkSize));
  const frames: string[] = [];
  for (let i = 0; i < total; i++) {
    const slice = payload.slice(i * chunkSize, (i + 1) * chunkSize);
    frames.push(`${FRAME_PREFIX}${sessionId}/${i}/${total}/${slice}`);
  }
  return { sessionId, frames };
}

export interface ParsedFrame {
  sessionId: string;
  idx: number;
  total: number;
  data: string;
}

/** Parse a single frame string. Returns null if it doesn't match the
 *  PWQR/v1 grammar (so a reader scanning ambient text can ignore it). */
export function parseFrame(s: string): ParsedFrame | null {
  if (!s.startsWith(FRAME_PREFIX)) return null;
  const body = s.slice(FRAME_PREFIX.length);
  // sessionId/idx/total/data — data may itself contain '/' since it's
  // base64url which doesn't, but be defensive: split into exactly 4.
  const slash1 = body.indexOf("/");
  if (slash1 < 0) return null;
  const sessionId = body.slice(0, slash1);
  const rest1 = body.slice(slash1 + 1);
  const slash2 = rest1.indexOf("/");
  if (slash2 < 0) return null;
  const idxStr = rest1.slice(0, slash2);
  const rest2 = rest1.slice(slash2 + 1);
  const slash3 = rest2.indexOf("/");
  if (slash3 < 0) return null;
  const totalStr = rest2.slice(0, slash3);
  const data = rest2.slice(slash3 + 1);
  const idx = Number.parseInt(idxStr, 10);
  const total = Number.parseInt(totalStr, 10);
  if (!Number.isInteger(idx) || idx < 0) return null;
  if (!Number.isInteger(total) || total <= 0) return null;
  if (idx >= total) return null;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(sessionId)) return null;
  return { sessionId, idx, total, data };
}

/** Reassembler accepts frames one at a time, deduplicates, returns the
 *  reassembled payload string once all expected frames are present. */
export class FrameReassembler {
  private sessionId: string | null = null;
  private total: number | null = null;
  private chunks: Map<number, string> = new Map();
  private mismatchedFrames = 0;

  /** Returns `{ complete, progress }`:
   *   - complete=true → all frames received; payload = result()
   *   - complete=false, progress={received, total} → keep scanning
   *  Throws on a frame from a different sessionId after we've locked in
   *  one (the user pointed the camera at a different payload mid-scan).
   */
  accept(frame: ParsedFrame): { complete: boolean; progress: { received: number; total: number } } {
    if (this.sessionId === null) {
      this.sessionId = frame.sessionId;
      this.total = frame.total;
    } else if (frame.sessionId !== this.sessionId) {
      // Mid-scan switch. Count it but don't accept the frame — the
      // caller decides whether to call reset() and start over.
      this.mismatchedFrames += 1;
      throw new Error("E_QR_SESSION_MISMATCH");
    } else if (frame.total !== this.total) {
      // Same session id but different total — corruption or a
      // malicious replay. Reject the frame outright.
      throw new Error("E_QR_TOTAL_MISMATCH");
    }
    this.chunks.set(frame.idx, frame.data);
    const received = this.chunks.size;
    const total = this.total!;
    return {
      complete: received === total,
      progress: { received, total },
    };
  }

  result(): string {
    if (this.sessionId === null || this.total === null) {
      throw new Error("E_QR_NO_FRAMES");
    }
    if (this.chunks.size !== this.total) {
      throw new Error("E_QR_INCOMPLETE");
    }
    let out = "";
    for (let i = 0; i < this.total; i++) {
      const chunk = this.chunks.get(i);
      if (chunk === undefined) throw new Error(`E_QR_MISSING_FRAME: ${i}`);
      out += chunk;
    }
    return out;
  }

  /** Reset to accept a brand-new session. */
  reset(): void {
    this.sessionId = null;
    this.total = null;
    this.chunks.clear();
    this.mismatchedFrames = 0;
  }

  get progress(): { received: number; total: number | null } {
    return { received: this.chunks.size, total: this.total };
  }
}

/** Convenience: a stateless one-shot for the test suite and any caller
 *  that already has the full frame array in hand. */
export function reassembleFrames(frames: string[]): string {
  const r = new FrameReassembler();
  for (const f of frames) {
    const parsed = parseFrame(f);
    if (!parsed) throw new Error("E_QR_BAD_FRAME");
    r.accept(parsed);
  }
  return r.result();
}

function randomSessionId(): string {
  // 6 URL-safe chars (~36 bits). Collisions across two simultaneous
  // pastes on the same machine are basically impossible.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(6);
  // crypto.getRandomValues is available in browsers + Node ≥17.
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}
