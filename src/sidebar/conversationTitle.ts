/**
 * What a conversation is called: the untitled placeholder, and the rules for
 * deriving a name from the first user message.
 *
 * Split out of `sessionTypes.ts`, which owns the session schema and its
 * persistence. Naming is a separate concern with no dependency on either — this
 * module imports nothing, so both the ops layer and the persistence layer can
 * take it without pulling the schema in behind it.
 */

const TITLE_MAX_LEN = 48;

/**
 * What a conversation is called until its first user message names it via
 * `deriveTitle`. A placeholder, not an action — so it cannot be mistaken for
 * the New chat button.
 */
export const UNTITLED_TITLE = 'Untitled chat';

/** Placeholders used before 0.13.22. They remain in already-saved sessions. */
const UNTITLED_TITLES_LEGACY = new Set(['Chat', 'New chat']);

/** Whether a title is a placeholder rather than one a prompt or the user chose. */
export function isUntitled(title: string): boolean {
  return title === UNTITLED_TITLE || UNTITLED_TITLES_LEGACY.has(title);
}

/**
 * The title the webview shows. Sessions written before this rename keep their
 * stored placeholder — rewriting them would mean a migration pass over every
 * file in ~/.forge/sessions/ to change a string that is only ever displayed, so
 * the translation happens at the meta builders that feed the webview instead.
 */
export function displayTitle(title: string): string {
  return isUntitled(title) ? UNTITLED_TITLE : title;
}

/**
 * A conversation name from its first user line: whitespace collapsed and length
 * capped, so a pasted wall of text cannot blow out the row it renders in.
 */
export function deriveTitle(firstUserLine: string): string {
  const line = firstUserLine.replace(/\s+/g, ' ').trim();
  if (!line) return UNTITLED_TITLE;
  return line.length > TITLE_MAX_LEN ? `${line.slice(0, TITLE_MAX_LEN)}…` : line;
}
