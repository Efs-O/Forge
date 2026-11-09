/**
 * The stale-`expected_lines` refusal texts for `apply_line_edits`, kept apart from the tool so
 * the tool stays inside the file-length gate and the texts stay one place. Each sentence exists
 * because a measured failure class cost the model a round it could have avoided (the overnight
 * lab, docs/reports/TOOL_TEST_LEDGER.md T16/T27/T35/T36): the refusal is what teaches, so the
 * refusal has to contain the answer.
 */

import type { LineEditOperation } from './structuredEditTool';

/** Hard cap on any single refusal: a refusal that outgrows it stops teaching and starts costing
 *  the model context. The quoted block is cut to fit; the warning never is. */
const MAX_REFUSAL_CHARS = 1_200;

/** Throw the refusal for an operation whose `expected_lines` do not match the requested range.
 *  Returns silently only when there is nothing to refuse. */
export function throwStaleRefusal(
  operation: LineEditOperation,
  index: number,
  lines: readonly string[],
): void {
  // The stale class is the worst-abandoned failure measured (18 of 38 in the 2026-11-09 baseline
  // never reached another success), and it happens because the file moved between the read and
  // the edit. A bare refusal left the model to re-read and guess again, so the refusal does the
  // two lookups that re-read was for: WHERE the model's text actually is, if it is still in the
  // file, and WHAT the requested range holds now. The second is a trap in the other direction —
  // after an insertion above the target the range holds different code, so the echo says so
  // instead of inviting a copy-paste of the wrong lines.
  const where = findBlockLocations(lines, operation.expected_lines);
  if (where.length === 1) {
    throw new Error(
      `apply_line_edits: operation ${index} is stale; expected_lines do not match the current ` +
        `file, but they DO match lines ${where[0][0]}-${where[0][1]} — use those line numbers.`,
    );
  }
  // Common text (`}`, `return;`, a blank line) appears in a file more than once. Naming one copy
  // "use those line numbers" sends the model to the wrong place — exactly the trap the
  // moved-file guard exists to close. So when the block appears several times, the heading itself
  // lists up to three copies (nearest to the requested range first, prefixed "closest 3:" when
  // there are more than three) and closes with "No changes were written."; the quoted requested
  // range follows, and both this case and the not-found case end on the same re-read warning.
  // The block is cut at a line boundary so the whole message fits the cap.
  const detail = numberedBlock(lines, operation.start_line, operation.end_line);
  const suffix =
    '\nIf these are not the lines you meant, the file changed since you read it — re-read it ' +
    'before editing.';
  let heading: string;
  if (where.length > 1) {
    const nearest = where
      .map(([first]) => [first, Math.abs(first - operation.start_line)] as const)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .map(([first]) => `${first}-${first + operation.expected_lines.length - 1}`)
      .join(', ');
    heading =
      `apply_line_edits: operation ${index} is stale; expected_lines do not match the current ` +
      `file, and they appear ${where.length} times in it ` +
      `(${where.length > 3 ? 'closest 3: lines ' : 'lines '}${nearest}, nearest to your requested ` +
      'range first), so no single range is safe to name. No changes were written.';
  } else {
    heading =
      `apply_line_edits: operation ${index} is stale; expected_lines do not match the current ` +
      'file and do not appear anywhere in it. No changes were written. Current text:\n';
  }
  throw new Error(
    heading +
      capAtLineBoundary(detail, MAX_REFUSAL_CHARS - heading.length - suffix.length) +
      suffix,
  );
}

/** The requested range, numbered the way `read_file numbered: true` prints it. Shared by the two
 *  refusals that quote current file text, so they cannot drift apart. */
export function numberedBlock(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  const current = lines
    .slice(startLine - 1, endLine)
    .map((line, offset) => `${startLine + offset}|${line}`)
    .join('\n');
  return ` Current file lines ${startLine}-${endLine}:\n${current}`;
}

/** Where `block` occurs in `lines`, every occurrence as [firstLine, lastLine] (1-based). This is
 *  the lookup a model pays a re-read for when its target moved: the text is usually still in the
 *  file, just under a different line number. Every copy is reported, because naming one copy of
 *  common text as "the" place sends the model to the wrong lines. */
export function findBlockLocations(
  lines: readonly string[],
  block: readonly string[],
): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  if (block.length === 0 || block.length > lines.length) return found;
  for (let start = 0; start + block.length <= lines.length; start += 1) {
    if (sameLines(lines.slice(start, start + block.length), block)) {
      found.push([start + 1, start + block.length]);
    }
  }
  return found;
}

/** Cut `text` to at most `budget` characters, at the last whole line boundary so a quoted block
 *  never ends on a half line. The caller keeps the warning outside this string, so the advice
 *  survives the cut. */
export function capAtLineBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf('\n', budget);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, budget);
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
