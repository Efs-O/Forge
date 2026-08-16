/**
 * Default cap on a tool result fed back into the conversation. MCP servers can
 * return arbitrarily large payloads (whole profiles, documents); uncapped they
 * blow past the per-slot context window of a local model and llama-server
 * rejects the next request outright.
 */
export const DEFAULT_MAX_RESULT_CHARS = 24000;

/** Truncates oversized tool output, appending a visible marker so the model knows. */
export function capResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated by Forge MCP bridge — showing ${maxChars} of ${text.length} chars]`;
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
