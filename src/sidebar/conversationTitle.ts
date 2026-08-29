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
 * `deriveTitle`. A placeholder, not a name — which is why it reads as one.
 */
export const UNTITLED_TITLE = 'New chat';

/** The placeholder used before 0.13.21. Still on disk in every older session. */
const UNTITLED_TITLE_LEGACY = 'Chat';

/** Whether a title is a placeholder rather than one a prompt or the user chose. */
export function isUntitled(title: string): boolean {
  return title === UNTITLED_TITLE || title === UNTITLED_TITLE_LEGACY;
}

/**
 * The title the webview shows. Sessions written before the rename keep their
 * stored 'Chat' — rewriting them would mean a migration pass over every file in
 * ~/.forge/sessions/ to change a string that is only ever displayed, so the
 * translation happens at the meta builders that feed the webview instead.
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
