// Monotonic time helper for security-sensitive timers (auto-lock).
//
// v0.1.8 audit Opus2 M-1: the auto-lock poll used Date.now() to measure
// "ms since last user activity". An attacker who shoulder-surfs the
// unlock, distracts the user, then walks the system clock backward (or
// the OS does it automatically — NTP step, daylight-saving rollback,
// VM resume from snapshot) makes `Date.now() - lastActivity` negative,
// the `since > AUTO_LOCK_MS` check fails, and the wallet stays unlocked
// past the policy window.
//
// performance.now() is monotonic by spec: its underlying clock never
// goes backward and is unaffected by user-space clock adjustments. We
// use it everywhere a lock-relevant elapsed comparison happens. The
// fallback for environments without performance.now() (legacy IE,
// some test runners) wraps Date.now() in a one-way max so a backward
// step still doesn't reduce the reported value.

let monotonicFallbackHigh = 0;

export function monotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  // Last-resort fallback. Latch the highest Date.now() we've seen so a
  // backward step does NOT reduce the returned value — the timer "stalls"
  // until wall-clock catches back up, which is the safe failure mode for
  // auto-lock (worst case: user locks slightly late once after a clock
  // step, but never gets locked indefinitely or skipped).
  const now = Date.now();
  if (now > monotonicFallbackHigh) monotonicFallbackHigh = now;
  return monotonicFallbackHigh;
}

/** Test-only: reset the fallback latch between tests. */
export function __resetMonotonicForTests(): void {
  monotonicFallbackHigh = 0;
}
