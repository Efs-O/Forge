/**
 * Bounds on what one `search_code` match may contribute to the prompt.
 *
 * `search_code` already limits files (`max_results`), snippets per file
 * (`SNIPPETS_PER_FILE_LIMIT`) and emitted lines (`OUTPUT_LINE_LIMIT`) — but a
 * "line" is whatever the file says it is, and nothing bounded its length.
 * Single-line JSON defeats all three limits at once: measured across 197
 * session logs, ELEVEN calls out of 1,170 produced 96% of every byte
 * `search_code` ever returned, the worst being a 1.7 MB `object_info.json`
 * line — 542,853 tokens in a single tool result, several times any local
 * model's per-slot window.
 *
 * Bounding this loses nothing: a match inside a 1.7 MB line cannot be read,
 * quoted or edited from a search result, and it evicts everything that could.
 *
 * See docs/plans/TOKEN_EFFICIENCY_PLAN.md §2.
 */

/** Longest single snippet line kept verbatim. */
export const MAX_SNIPPET_CHARS = 400;

/**
 * Ceiling on the whole joined result. Generous next to the per-line cap —
 * 50 lines of real source is legitimately large — but finite, so a file of
 * many long lines cannot add up to another context blowout.
 */
export const MAX_SEARCH_RESULT_CHARS = 60_000;

/**
 * Caps one matched line, keeping the searched term visible.
 *
 * `matchStart` is the offset of the first submatch, which ripgrep reports on
 * `match` events. Centring the kept window on it is the point: a head-only cut
 * of a minified line reliably shows the model everything except the thing it
 * searched for. Context lines have no submatch, so they keep their head.
 */
export function capSnippetLine(line: string, matchStart?: number): string {
  if (line.length <= MAX_SNIPPET_CHARS) return line;

  const half = Math.floor(MAX_SNIPPET_CHARS / 2);
  const centre = matchStart ?? 0;
  const start = Math.max(0, Math.min(centre - half, line.length - MAX_SNIPPET_CHARS));
  const end = Math.min(line.length, start + MAX_SNIPPET_CHARS);

  const head = start > 0 ? '…' : '';
  const tail = end < line.length ? '…' : '';
  // State the true size. A bare ellipsis reads as "a few more chars" and the
  // model goes on treating the line as something it could ask to see in full.
  return `${head}${line.slice(start, end)}${tail} [line is ${line.length} chars; showing ${end - start}]`;
}
