/**
 * The one check every agent text-write tool runs on the text it is about to put
 * in a file: a NUL character (U+0000) means the model meant something else, so
 * the call is refused and nothing is written.
 *
 * Measured 2026-11-24 on the whole session archive (1,284 logs, 18,495
 * `write_file` / `edit_file` / `apply_line_edits` / `append_file` calls, rows
 * deduped): exactly one call ever held one. A low-bit lane model writing a
 * TypeScript test copied the dedup-key convention of
 * `src/remote/remoteStoreQueries.ts` — fields joined with `'\u0000'` — into a
 * template literal, and emitted the JSON escape `\u0000` where it meant a
 * literal backslash-u escape in the source. `JSON.parse` decoded it to a real
 * NUL, `write_file` wrote it verbatim, vitest still passed, and
 * `git diff --cached --stat` said `Bin 0 -> 4623 bytes`: the lane had to notice
 * and strip the bytes by hand.
 *
 * Refusing rather than stripping is the useful half. A NUL that reaches a file
 * is invisible in every view the agent has, so a silent strip would move the
 * mistake from the diff to the model's own text, and the model would never know
 * its escape was wrong. The refusal says how many, where the first one is, and
 * that nothing was written, so one round fixes it.
 *
 * The offset is inside the text the tool was given — the content, the `new_str`,
 * the `replacement_text` — not inside the file: that is the string the model has
 * to correct, so that is the string the number points into. Zero-based, like
 * every other offset the write-side tools take.
 */

const NUL = '\u0000';

/** The refusal for `text`, or undefined when it holds no NUL. `tool` is the name the
 *  model reads it under; `ToolDispatch` prefixes `Error:` to a thrown refusal. */
export function nulTextRefusal(tool: string, text: string): string | undefined {
  const first = text.indexOf(NUL);
  if (first < 0) return undefined;
  let count = 0;
  for (let at = first; at !== -1; at = text.indexOf(NUL, at + 1)) count++;
  return (
    `${tool}: the new text holds ${count} NUL character(s) (\\u0000), the first at character ` +
    `${first}; a source file never contains one. Nothing was written. Resend the text without them.`
  );
}

/** Refuse before anything is written, as `guardTipsWrite` does: a refusal from here means
 *  no bytes changed, which is what the sentence promises. */
export function guardNulFreeText(tool: string, text: string): void {
  const refusal = nulTextRefusal(tool, text);
  if (refusal !== undefined) throw new Error(refusal);
}
