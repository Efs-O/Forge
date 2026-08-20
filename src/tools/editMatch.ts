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
  const firstLine = oldStr.replace(/\r\n?/gu, '\n').split('\n')[0]?.trim() ?? '';
  if (firstLine.length >= 3) {
    const lines = content.replace(/\r\n?/gu, '\n').split('\n');
    const near = lines.findIndex((line) => line.trim() === firstLine);
    if (near !== -1) {
      return (
        ` Its first line WAS found at line ${near + 1}, so a later line of old_str is what ` +
        'differs — re-read that region with read_file and copy it verbatim.'
      );
    }
    const loose = lines.findIndex((line) => line.includes(firstLine));
    if (loose !== -1) {
      return (
        ` The nearest line is ${loose + 1}: "${lines[loose].trim().slice(0, 120)}" — re-read ` +
        'that region with read_file and copy it verbatim.'
      );
    }
  }
  return ' Re-read the file with read_file and copy the target text verbatim.';
}
