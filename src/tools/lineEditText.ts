/**
 * The one rule `apply_line_edits` uses to turn the text it is given into lines.
 *
 * Both sides of an operation arrive as a single string (`expected_text`,
 * `replacement_text`) because the array form — every code line a separately quoted item, two list
 * levels deep — arrived unparseable in 23 of 474 calls on 2026-11-24, ten times the rate of
 * `edit_file`, which takes one string per side. The string is split here, once, so the count
 * check, the stale check, the auto-alignment and the splice cannot disagree about what it meant.
 *
 * It lives apart from the tool because `structuredEditTool.ts` is at the file-length gate.
 */

/** The most lines one operation may expect or replace, and the longest any one of them may be. */
export const MAX_LINES_PER_OPERATION = 500;
export const MAX_LINE_CHARS = 4_000;

/**
 * Split one side of an operation into lines. A trailing newline ends the last line rather than
 * adding an empty one (`"a\n"` is one line, `"a\n\n"` is two), `\r\n` is a line break, and `""` is
 * no lines at all — which is how `replacement_text: ""` deletes a range.
 */
export function splitEditTextLines(text: string): string[] {
  return text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r?\n/);
}

/**
 * Split one side and enforce the two bounds that keep an operation's text off the file-length
 * path: at most `MAX_LINES_PER_OPERATION` lines, none longer than `MAX_LINE_CHARS`.
 * `index` is the zero-based operation index and `field` the name the refusal quotes.
 */
export function checkedEditTextLines(
  text: string,
  index: number,
  field: 'expected_text' | 'replacement_text',
): string[] {
  const lines = splitEditTextLines(text);
  if (
    lines.length > MAX_LINES_PER_OPERATION ||
    lines.some((line) => line.length > MAX_LINE_CHARS)
  ) {
    throw new Error(`apply_line_edits: operation ${index + 1} has invalid ${field}`);
  }
  return lines;
}
