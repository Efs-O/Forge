/**
 * The refusal an `edit_file` call gets back when its `edits` arrive as
 * hand-written JSON text. A low-bit model types the array as a string and now
 * and then slips on one escape — a backslash standing right before a real line
 * break, `\c` instead of `\n`, a double quote inside the code it did not
 * escape — in about one call in 170. The refusal this replaced named neither
 * the place nor the slip, and 22 of 30 retries resent the same broken list, so
 * this one names the character position, the likely slip and the text around
 * it, and points at the single-edit form, whose top-level strings need no JSON
 * escaping. Nothing here repairs the JSON: the tool contract is unchanged, only
 * the wording of the refusal.
 */

/** What to tell the model to send instead, appended to every broken-JSON refusal. */
const RESEND =
  'Resend it as one edit_file call per edit, each with top-level "path", "old_str" and ' +
  '"new_str": those take the text as written, with no JSON escaping.';

/** Show a slice of the model's own text without letting a real line break hide the rest. */
function show(text: string): string {
  return text.replaceAll('\r', '').replaceAll('\n', '⏎');
}

/** The most likely slip at `pos`, in the model's terms; the quote case is the fallback. */
function slipHint(edits: string, message: string, pos: number): string {
  const char = edits[pos];
  if (message.startsWith('Unterminated string')) {
    return 'the text ends inside a string, so a closing quote is missing or the list was cut off.';
  }
  if (edits[pos - 1] === '\\' && char === '\n') {
    return 'a backslash stands right before a line break; inside a JSON string a line break is written \\n.';
  }
  if (edits[pos - 1] === '\\') {
    return (
      `a backslash is followed by ${char === ' ' ? 'a space' : `"${char}"`}, which JSON does ` +
      'not allow; inside a JSON string a backslash is written \\\\ and a line break \\n.'
    );
  }
  return 'this is often a double quote inside "old_str" or "new_str" that is not written as \\".';
}

/**
 * Refusal text for an `edit_file` call whose `edits` is a string rather than an
 * array; undefined when `edits` is an array or absent. A string that parses as
 * JSON is refused as it has always been; one that does not parse is refused
 * with its position, the likely slip and the single-edit form.
 */
export function editFileStringError(args: Record<string, unknown>): string | undefined {
  const edits = args['edits'];
  if (typeof edits !== 'string') return undefined;
  const pathMissing = args['path'] === undefined;
  let invalidJson = false;
  let parseMessage = '';
  try {
    JSON.parse(edits);
  } catch (error) {
    invalidJson = true;
    parseMessage = error instanceof Error ? error.message : String(error);
  }
  if (!invalidJson) {
    const pathIssue = pathMissing ? 'missing required `path`. ' : '';
    const shape = pathMissing
      ? ' Accepted shape: { "path": "...", "edits": [{ "old_str": "...", "new_str": "..." }] }.'
      : ' Send `edits` as a JSON array of { "old_str": "...", "new_str": "..." } objects.';
    return `Error: ${pathIssue}\`edits\` arrived as a string, not an array.${shape}`;
  }
  const prefix = pathMissing ? 'Error: missing required `path`. `edits`' : 'Error: `edits`';
  const where = /at position (\d+)/u.exec(parseMessage);
  if (where === null) {
    return `${prefix} is not valid JSON (${parseMessage}). ${RESEND}`;
  }
  const pos = Number(where[1]);
  const near =
    `…${show(edits.slice(Math.max(0, pos - 30), pos))}⟨here⟩` +
    `${show(edits.slice(pos, pos + 10))}…`;
  return (
    `${prefix} is not valid JSON at character ${pos + 1}: ` +
    `${slipHint(edits, parseMessage, pos)} Near it: ${near} ${RESEND}`
  );
}
