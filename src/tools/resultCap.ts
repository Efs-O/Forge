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
