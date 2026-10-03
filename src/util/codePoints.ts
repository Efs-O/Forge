/**
 * Length and slicing in Unicode code points, not UTF-16 code units.
 *
 * `String.prototype.length` and `.slice()` count UTF-16 code units, so any
 * character outside the Basic Multilingual Plane — emoji, mathematical
 * alphanumerics, much of the emoji range — counts as TWO and can be cut in
 * half. A service that guards a limit with `.length` and a sender that trims
 * with `.slice()` therefore disagree: the guard refuses a caption the
 * transport would have accepted, and the trim can emit a lone surrogate that
 * arrives as a replacement character.
 *
 * This is the single owner of that distinction. Anything that enforces or
 * trims a limit expressed in "characters" against an external API should use
 * it rather than re-deriving the iteration.
 */

/** Number of code points in `text` — what an API means by "characters". */
export function codePointLength(text: string): number {
  // `.` with the `u` flag matches one whole code point, surrogate pairs
  // included, so the match count is the code-point count.
  return text.match(/./gu)?.length ?? 0;
}

/** First `limit` code points of `text`, never cutting a surrogate pair. */
export function sliceCodePoints(text: string, limit: number): string {
  if (limit <= 0) return '';
  // Code points never exceed code units, so a string already within the limit
  // needs no walking — and no risk of splitting a pair.
  if (text.length <= limit) return text;
  let units = 0;
  let seen = 0;
  for (const character of text) {
    if (seen === limit) break;
    units += character.length;
    seen += 1;
  }
  return text.slice(0, units);
}
