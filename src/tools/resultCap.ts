/**
 * Default cap on a tool result fed back into the conversation. MCP servers can
 * return arbitrarily large payloads (whole profiles, documents); uncapped they
 * blow past the per-slot context window of a local model and llama-server
 * rejects the next request outright.
 */
export const DEFAULT_MAX_RESULT_CHARS = 24000;

/**
 * Upper bound on a single `read_file` result. Deliberately far larger than the
 * MCP cap — reading a big source file is legitimate work — but bounded, because
 * `read_file` was uncapped entirely and a 1.3 MB file could exhaust a one-slot
 * context in a single tool result.
 */
export const MAX_READ_FILE_CHARS = 120000;

/**
 * Truncates oversized tool output, appending a visible marker so the model knows.
 * `source` names the component that did the cutting and `advice` (optional) tells
 * the model how to get the rest — a bare truncation notice leaves it guessing.
 */
export function capResultText(
  text: string,
  maxChars: number,
  source = 'Forge MCP bridge',
  advice?: string,
): string {
  if (text.length <= maxChars) return text;
  const tail = advice ? `. ${advice}` : '';
  return `${text.slice(0, maxChars)}\n\n[truncated by ${source} — showing ${maxChars} of ${text.length} chars${tail}]`;
}

/**
 * Cap on what the transcript *shows*. Far larger than the old 600-char preview:
 * a delegated CLI agent's report is the payload, not a status line. The model
 * always receives the full result — this bounds only the webview copy.
 */
export const MAX_DISPLAY_RESULT_CHARS = 16000;

/** Caps text for display, preserving newlines, and reports the original size. */
export function capDisplayText(
  text: string,
  maxChars: number = MAX_DISPLAY_RESULT_CHARS,
): { text: string; totalChars: number } {
  if (text.length <= maxChars) return { text, totalChars: text.length };
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated for display — showing ${maxChars} of ${text.length} chars]`,
    totalChars: text.length,
  };
}
