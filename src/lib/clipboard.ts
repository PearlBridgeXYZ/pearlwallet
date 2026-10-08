// Copying an address, then clearing it from the clipboard after
// CLIPBOARD_CLEAR_MS (an address is a privacy / correlation signal). The
// timer is module-scoped, so leaving the screen that copied doesn't cancel
// it; a later copy replaces it (the later address's window governs). The
// clear only happens if the clipboard still holds exactly the copied text,
// so anything the user copied since is left alone. Best effort: browsers
// may refuse to read the clipboard from an unfocused page.

export const CLIPBOARD_CLEAR_MS = 60_000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/** Writes `text` to the clipboard (throws if that fails) and schedules
 *  the clear. */
export async function copyWithAutoClear(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    void (async () => {
      try {
        if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText("");
      } catch {
        // Permissions or focus restrictions — best effort only.
      }
    })();
  }, CLIPBOARD_CLEAR_MS);
}
