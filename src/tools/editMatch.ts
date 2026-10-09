/**
 * Single owner of how `edit_file` locates `old_str` inside a file.
 *
 * A model composes `old_str` from what it read, which is line-separated by
 * "\n". Windows files — and worse, the files that are half-converted and carry
 * both — separate with "\r\n". A raw indexOf then fails on text the model
 * quoted perfectly, and the refusal ("check your whitespace and indentation")
 * points at the one thing that was never wrong. Matching is therefore
 * line-ending insensitive, while the splice and the write stay byte-exact
 * against the original file so no unrelated line silently changes ending.
 */

export interface EditMatch {
  /** Offset into the ORIGINAL text. */
  index: number;
  /** Length in the ORIGINAL text, which may differ from old_str's length. */
  length: number;
}

interface NormalizedText {
  text: string;
  /** originOf[i] is the offset in the original string of normalized char i. */
  originOf: number[];
}

/** Collapses CRLF and lone CR to LF, remembering where each char came from. */
function normalize(input: string): NormalizedText {
  let text = '';
  const originOf: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\r') {
      // CR, or the CR of a CRLF pair: emit one LF for either.
      text += '\n';
      originOf.push(i);
      if (input[i + 1] === '\n') i++;
      continue;
    }
    text += ch;
    originOf.push(i);
  }
  originOf.push(input.length);
  return { text, originOf };
}

/**
 * Finds `oldStr` in `content`, ignoring line-ending style. Exact matches are
 * tried first so ordinary edits keep their existing behaviour and cost.
 */
export function findEditMatch(content: string, oldStr: string): EditMatch | undefined {
  const exact = content.indexOf(oldStr);
  if (exact !== -1) return { index: exact, length: oldStr.length };

  const haystack = normalize(content);
  const needle = normalize(oldStr).text;
  if (!needle) return undefined;

  const hit = haystack.text.indexOf(needle);
  if (hit === -1) return undefined;

  const start = haystack.originOf[hit];
  const end = haystack.originOf[hit + needle.length];
  return { index: start, length: end - start };
}

export interface IndentShiftedMatch extends EditMatch {
  /** `new_str` with the same shift applied, ready to splice. */
  newStr: string;
  /** 1-based line where the block starts. */
  line: number;
  /** Positive adds indentation, negative removes it. */
  shift: number;
}

/**
 * Finds `oldStr` once its indentation is shifted by a uniform amount, and
 * shifts `newStr` to match. Applied only when nothing can be ambiguous: one
 * block of whole lines matches, every leading whitespace (file block, old_str,
 * new_str) is one character kind, every non-blank line differs by the same
 * count, and new_str can take that count. Anything else is a miss, reported by
 * `describeEditMiss` as before. The shift keeps new_str's relative nesting, so
 * a nesting change the model meant to make survives a Python or YAML edit.
 */
export function findIndentShiftedMatch(
  content: string,
  oldStr: string,
  newStr: string,
): IndentShiftedMatch | undefined {
  let needle = oldStr.replace(/\r\n?/gu, '\n').split('\n');
  const trailingNewline = needle.length > 1 && needle.at(-1) === '';
  if (trailingNewline) needle = needle.slice(0, -1);
  const stripped = needle.map((line) => line.replace(/^[ \t]+/u, ''));
  if (!stripped.some((line) => line.length >= 3)) return undefined;

  const spans = lineSpans(content);
  const starts: number[] = [];
  for (let start = 0; start + needle.length <= spans.length; start++) {
    const window = spans.slice(start, start + needle.length);
    if (window.every((span, i) => span.text.replace(/^[ \t]+/u, '') === stripped[i])) {
      starts.push(start);
      if (starts.length > 1) return undefined;
    }
  }
  if (starts.length !== 1) return undefined;
  const start = starts[0]!;
  const window = spans.slice(start, start + needle.length);
  if (trailingNewline && start + needle.length >= spans.length) return undefined;

  const newLines = newStr.replace(/\r\n?/gu, '\n').split('\n');
  const indents = [...window.map((span) => span.text), ...needle, ...newLines]
    .map((line) => /^[ \t]*/u.exec(line)![0])
    .join('');
  const kind = indents[0];
  if (kind !== undefined && [...indents].some((ch) => ch !== kind)) return undefined;

  let shift: number | undefined;
  for (const [i, line] of needle.entries()) {
    if (stripped[i] === '') continue;
    const delta = indentWidth(window[i]!.text) - indentWidth(line);
    if (shift === undefined) shift = delta;
    else if (delta !== shift) return undefined;
  }
  if (shift === undefined || shift === 0) return undefined;
  if (shift < 0 && newLines.some((line) => line.trim() !== '' && indentWidth(line) < -shift)) {
    return undefined;
  }
  const pad = (kind ?? ' ').repeat(Math.max(0, shift));
  const shifted = newLines
    .map((line) => {
      if (line.trim() === '') return line.slice(0, Math.max(0, line.length + Math.min(0, shift!)));
      return shift! > 0 ? pad + line : line.slice(-shift!);
    })
    .join('\n');

  const index = window[0]!.start;
  const end = trailingNewline ? spans[start + needle.length]!.start : window.at(-1)!.end;
  return { index, length: end - index, newStr: shifted, line: start + 1, shift };
}

interface LineSpan {
  text: string;
  /** Offset of the line's first character in the original text. */
  start: number;
  /** Offset just past the line's last character, before its line ending. */
  end: number;
}

function lineSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = [];
  const eol = /\r\n|\r|\n/gu;
  let start = 0;
  for (let m = eol.exec(content); m; m = eol.exec(content)) {
    spans.push({ text: content.slice(start, m.index), start, end: m.index });
    start = m.index + m[0].length;
  }
  spans.push({ text: content.slice(start), start, end: content.length });
  return spans;
}

function indentWidth(line: string): number {
  return /^[ \t]*/u.exec(line)![0].length;
}

/** The line ending the file mostly uses, so inserted text matches its neighbours. */
export function dominantEol(content: string): '\r\n' | '\n' {
  const crlf = (content.match(/\r\n/gu) ?? []).length;
  const lf = (content.match(/\n/gu) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** Rewrites `text` to use `eol` throughout, whatever it arrived with. */
export function applyEol(text: string, eol: '\r\n' | '\n'): string {
  const normalized = text.replace(/\r\n?/gu, '\n');
  return eol === '\n' ? normalized : normalized.replace(/\n/gu, '\r\n');
}

/**
 * Explains a failed match in terms the model can act on. A bare "not found"
 * costs a full round to a blind retry — usually with a differently-guessed
 * anchor rather than a re-read, which is what it actually needs.
 */
export function describeEditMiss(content: string, oldStr: string): string {
  const indent = describeIndentShift(content, oldStr);
  if (indent) return indent;

  const firstLine = oldStr.replace(/\r\n?/gu, '\n').split('\n')[0]?.trim() ?? '';
  if (firstLine.length >= 3) {
    const lines = content.replace(/\r\n?/gu, '\n').split('\n');
    const near = lines.findIndex((line) => line.trim() === firstLine);
    if (near !== -1) {
      return (
        ` Its first line WAS found at line ${near + 1}, so a later line of old_str is what ` +
        'differs — copy the current region below and retry.' +
        describeCurrentRegion(lines, near)
      );
    }
    const loose = lines.findIndex((line) => line.includes(firstLine));
    if (loose !== -1) {
      return (
        ` The nearest line is ${loose + 1}: "${lines[loose].trim().slice(0, 120)}" — ` +
        'copy the current region below and retry.' +
        describeCurrentRegion(lines, loose)
      );
    }
    const closest = closestLine(lines, firstLine);
    if (closest) {
      const lineNumber = Number(closest.match(/closest line is (\d+)/u)?.[1]);
      return `${closest}${describeCurrentRegion(lines, lineNumber - 1)}`;
    }
  }
  return ' Re-read the file with read_file and copy the target text verbatim.';
}

/** Read-file style context for a named miss line, bounded for batch failures. */
function describeCurrentRegion(lines: string[], index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) return '';
  const displayLines = [...lines];
  if (displayLines.length > 1 && displayLines.at(-1) === '') displayLines.pop();
  const start = Math.max(0, index - 3);
  const end = Math.min(displayLines.length, index + 4);
  const width = String(displayLines.length).length;
  const numbered = displayLines
    .slice(start, end)
    .map((line, offset) => `${String(start + offset + 1).padStart(width, ' ')}|${line}`)
    .join('\n');
  const prefix = ` Current text (lines ${start + 1}-${end}):\n`;
  return `${prefix}${numbered.slice(0, Math.max(0, 1200 - prefix.length))}`;
}

/**
 * The line sharing the longest prefix with old_str's first line, and where the
 * two part. A one-character slip mid-line (`6.283` for `6.28`) defeats both the
 * exact and the substring search above, and a bare "re-read the file" then
 * costs a grep round just to find the line again.
 */
function closestLine(lines: string[], firstLine: string): string | undefined {
  let best = -1;
  let bestLength = 0;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    let shared = 0;
    while (
      shared < trimmed.length &&
      shared < firstLine.length &&
      trimmed[shared] === firstLine[shared]
    )
      shared++;
    if (shared > bestLength) {
      best = index;
      bestLength = shared;
    }
  }
  // Below this a shared prefix is boilerplate (`const `, `  if (`), not a sighting.
  if (best === -1 || bestLength < Math.max(12, firstLine.length / 3)) return undefined;
  const text = lines[best]!.trim();
  const from = Math.max(0, bestLength - 20);
  return (
    ` The closest line is ${best + 1}; old_str's first line departs from it at character ` +
    `${bestLength + 1}: the file has "${text.slice(from, bestLength + 40)}" where old_str has ` +
    `"${firstLine.slice(from, bestLength + 40)}". Copy that line from the file verbatim.`
  );
}

/**
 * The one miss worth naming before any other: `old_str` that matches the file
 * exactly once its leading whitespace is shifted by a constant.
 *
 * A model composing `old_str` from a `numbered: true` read used to inherit the
 * separator's trailing space on EVERY line, so the block differed from the file
 * by one uniform space and nothing else. The generic diagnosis below reads that
 * as "your first line matched, a later line differs" — true by `trim()`, and
 * exactly wrong: it sends the model hunting a later line that is fine. Six
 * consecutive edits failed that way on 2026-09-05 against `.forge/config.yaml`.
 *
 * `read_file` no longer emits that space, but a model can still hand-indent a
 * block, and an off-by-one indent must not cost a turn to a message that points
 * somewhere else. A uniform, unambiguous shift is applied by
 * `findIndentShiftedMatch` before this runs (2026-10-09, user decision; it once
 * was never auto-applied); this names the cases it refuses: mixed tabs and
 * spaces, a shift that varies by line, or several matching blocks.
 */
function describeIndentShift(content: string, oldStr: string): string | undefined {
  const needle = oldStr.replace(/\r\n?/gu, '\n').split('\n');
  if (needle.length === 0) return undefined;

  const stripped = needle.map((line) => line.replace(/^[ \t]+/u, ''));
  // An all-blank or single-token block has no indentation to be wrong about,
  // and would match far too loosely to accuse anyone of anything.
  if (!stripped.some((line) => line.length >= 3)) return undefined;

  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  for (let start = 0; start + needle.length <= lines.length; start++) {
    const window = lines.slice(start, start + needle.length);
    if (!window.every((line, i) => line.replace(/^[ \t]+/u, '') === stripped[i])) continue;

    const wanted = leadingWhitespace(window, stripped);
    const given = leadingWhitespace(needle, stripped);
    return (
      ` The text WAS found at line ${start + 1}, differing only in leading whitespace: the ` +
      `file indents that block with ${describeWidth(wanted)} where old_str has ` +
      `${describeWidth(given)}. Re-send old_str with the file's own indentation — if you ` +
      'built it from a numbered read, the prefix ends at the "|" and the next character is ' +
      'already column 1, so do not add a space after it.' +
      describeCurrentRegion(lines, start)
    );
  }
  return undefined;
}

/** The indent of the first line in `lines` that actually carries content. */
function leadingWhitespace(lines: string[], stripped: string[]): string {
  const index = stripped.findIndex((line) => line.length > 0);
  if (index === -1) return '';
  return lines[index]!.slice(0, lines[index]!.length - stripped[index]!.length);
}

function describeWidth(indent: string): string {
  if (indent.length === 0) return 'no leading whitespace';
  const tabs = (indent.match(/\t/gu) ?? []).length;
  if (tabs > 0) return `${tabs} tab(s) + ${indent.length - tabs} space(s)`;
  return `${indent.length} space${indent.length === 1 ? '' : 's'}`;
}
