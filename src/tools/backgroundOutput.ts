/**
 * The retained-output window behind a background execution: how a stream is
 * capped, how the buffer moves when it overflows, and how a reader resumes at a
 * cursor. Pure functions over strings — `BackgroundExecutionManager` keeps the
 * absolute positions, this owns the arithmetic that decides what is still
 * readable and what is gone for good. `MAX_BACKGROUND_OUTPUT_CHARS` has two
 * readers: the retention here, and `monitor_execution`, which has to tell the
 * agent how many characters the cap discarded before its cursor.
 */

export const MAX_BACKGROUND_OUTPUT_CHARS = 200_000;

/** The last `maxLines` lines of a stream, clipped to `maxChars`, for an exit notice. */
export function tailLines(output: string, maxLines: number, maxChars: number): string {
  return output.split(/\r?\n/u).slice(-maxLines).join('\n').slice(-maxChars);
}

/**
 * Append `chunk`, dropping the front when the buffer passes the cap, and report
 * how much was dropped so the caller can advance its base offset: cursors are
 * absolute, so a trimmed buffer is unreadable below the new base.
 */
export function retainOutput(
  current: string,
  chunk: string,
  onTrim: (base: number) => void,
): string {
  const combined = current + chunk;
  if (combined.length <= MAX_BACKGROUND_OUTPUT_CHARS) return combined;
  const trim = combined.length - MAX_BACKGROUND_OUTPUT_CHARS;
  onTrim(trim);
  return combined.slice(trim);
}

/**
 * Read from `cursor` inside the retained window. A cursor behind the window
 * resumes at the window, not at the cursor — the characters in between are gone
 * for good, and `dropped` counts exactly how many the caller lost.
 */
export function readOutput(
  output: string,
  base: number,
  cursor: number,
): { text: string; start: number; dropped: number } {
  const safeCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const start = Math.max(safeCursor, base);
  return { text: output.slice(start - base), start, dropped: Math.max(0, base - safeCursor) };
}
