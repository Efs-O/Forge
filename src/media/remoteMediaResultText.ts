/**
 * The two path rewrites a remote media job's result text goes through
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md phase 2, criterion 8: no desktop path
 * crosses to the laptop).
 *
 * The desktop's own tool writes the result text, and the text is worth keeping:
 * the size, the backend, the time. What is not worth keeping is the path it
 * names. `<globalStorage>/remote-media/<id>/out/fox.png` lives under the
 * desktop's user folder: it does not exist on the laptop, it leaks the desktop's
 * user name, and "To inspect it, call view_image on that path" sends the
 * laptop's model to a file it cannot read. So the desktop rewrites its paths to
 * bare file names on the way out (`desktopPathsToNames`, called in
 * `remoteMediaJobs.ts`), and the laptop rewrites those names back to its own
 * paths on the way in (`namesToLaptopPaths`, called in `remoteMediaTools.ts`).
 *
 * Both are pure string rewrites: no file system, no configuration, no imports.
 * That is why they live in one file — each side of the relay can be tested
 * without the other, and the pair of rules is the whole contract. `toolResultText`
 * belongs to the same step: the desktop's side reads a handler's answer, which is
 * not always a string, before it can rewrite the paths in it.
 *
 * Why the rules are the way they are:
 *
 * - **The job folder is matched literally; only what follows it is scanned.**
 *   A job folder contains spaces (`C:/Users/efso office/AppData/...`), so a path
 *   cannot be found by scanning a word. `jobDir` is compared as text (any case,
 *   either separator), and the match runs on to the first character a path
 *   cannot contain.
 * - **A name is only rewritten where it stands alone.** `myfox.png` and
 *   `fox.pngx` are not the file `fox.png`, and a name inside a laptop path this
 *   function already wrote (`smoke-195/fox.png`) must not be rewritten twice.
 * - **A sentence-final period is punctuation, not part of a file name.**
 */

/**
 * The text a tool handler returned: a plain string, or the `text` field the
 * multimodal and question results carry. Here because the desktop calls it on
 * the same line it rewrites the paths on, and that line has to stay one line.
 * Structural, not the tool contract's own union, so this module imports nothing.
 */
export function toolResultText(result: string | { text: string }): string {
  return typeof result === 'string' ? result : result.text;
}

/** Escape a string for use as a literal inside a regular expression. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** A character a path cannot contain: whitespace or one of `"`, `'`, `` ` ``,
 *  `(`, `)`, `,`, `;`, `<`, `>`. A desktop path in prose ends at the first one,
 *  or at the end of the text. `String.raw` and hex escapes keep the class on one
 *  line without an ambiguity in either the string or the pattern. */
const NOT_A_PATH_CHAR = String.raw`[^\s\x22\x27\x60\x28\x29\x2c\x3b\x3c\x3e]`;

/** Both separators, interchangeable: the desktop writes with `\`, the laptop
 *  reads with `/`, and a tool that has already rewritten text uses `/`. */
const EITHER_SEPARATOR = String.raw`[\x2f\x5c]`;

/** A trailing separator, and the separator class used to split a path. */
const TRAILING_SEPARATOR = /[\\/]+$/u;
const ANY_SEPARATOR = /[\\/]/u;

/** A letter, digit, `_`, `-`, `.`, `/` or `\`: a character glued in front of a
 *  name means it is the tail of a longer word, or a name inside a path that is
 *  already there. */
const ATTACHED_BEFORE = /[\p{L}\p{N}_\x2d\x2e\x2f\x5c]/u;

/** A letter, digit, `_` or `-`: a character glued behind a name means the name
 *  is the front of a longer one. */
const ATTACHED_AFTER = /[\p{L}\p{N}_\x2d]/u;

/** A `.` then a letter or digit: the name grew an extension (`fox.png.bak`). */
const GROWS_AN_EXTENSION = /\.[\p{L}\p{N}]/u;

/**
 * `jobDir` as a pattern: every character its literal self, each of its `/` and
 * `\` characters matching either separator.
 */
function jobDirPattern(jobDir: string): string {
  return [...jobDir]
    .map((char) => (char === '/' || char === '\\' ? EITHER_SEPARATOR : escapeForRegExp(char)))
    .join('');
}

/**
 * The bare file name of a desktop path that was found in prose: its last
 * segment. A sentence-final period is left out of the name and put back where
 * it was, so the text that follows the path is not changed by the rewrite.
 */
function lastSegmentOf(match: string, whole: string, offset: number): string {
  let found = match;
  let punctuation = '';
  if (found.endsWith('.')) {
    const next = whole.charAt(offset + match.length);
    if (next === '' || /\s/u.test(next)) {
      found = found.slice(0, -1);
      punctuation = '.';
    }
  }
  const segments = found.replace(TRAILING_SEPARATOR, '').split(ANY_SEPARATOR);
  const last = segments[segments.length - 1] ?? '';
  return (last || match) + punctuation;
}

/**
 * Replace every path inside `jobDir` (the desktop's folder for this job) with
 * its bare file name, so no desktop path crosses to the laptop. Text with no
 * such path is returned unchanged.
 */
export function desktopPathsToNames(text: string, jobDir: string): string {
  const folder = jobDir.replace(TRAILING_SEPARATOR, '');
  if (!folder) return text;
  const pattern = new RegExp(`${jobDirPattern(folder)}${NOT_A_PATH_CHAR}*`, 'giu');
  return text.replace(pattern, (match: string, offset: number, whole: string): string =>
    lastSegmentOf(match, whole, offset),
  );
}

/**
 * Replace each bare file name with the laptop path it stands for, longest name
 * first, and only where the name stands alone. A name inside a path that is
 * already a laptop path is not touched, because the scan runs over the original
 * text once and never reads its own output.
 */
export function namesToLaptopPaths(text: string, names: Readonly<Record<string, string>>): string {
  const keys = Object.keys(names)
    .filter((name) => name.length > 0 && names[name] !== undefined)
    .sort((a, b) => b.length - a.length);
  if (keys.length === 0) return text;
  const pattern = new RegExp(keys.map(escapeForRegExp).join('|'), 'gu');
  return text.replace(pattern, (match: string, offset: number, whole: string): string => {
    const before = offset === 0 ? '' : whole.charAt(offset - 1);
    if (before && ATTACHED_BEFORE.test(before)) return match;
    const after = whole.slice(offset + match.length, offset + match.length + 2);
    if (ATTACHED_AFTER.test(after.charAt(0))) return match;
    if (GROWS_AN_EXTENSION.test(after)) return match;
    return names[match] ?? match;
  });
}
