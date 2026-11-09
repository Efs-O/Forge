/**
 * What a conversation is called: the untitled placeholder, and the rules for
 * deriving a name from the first user message.
 *
 * Split out of `sessionTypes.ts`, which owns the session schema and its
 * persistence. Naming is a separate concern with no dependency on either — this
 * module imports nothing, so both the ops layer and the persistence layer can
 * take it without pulling the schema in behind it.
 */

const TITLE_MAX_LEN = 160;
/** Titles saved before the wider sessions panel retained only this many units. */
const LEGACY_TITLE_MAX_LEN = 48;

/** The cap `deriveTitle` applies, in UTF-16 units. Exported because the retitle
 *  job refuses a model answer that would be cut anyway (`src/jobs/retitleRun.ts`). */
export const TITLE_MAX_UNITS = TITLE_MAX_LEN;

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
 * Who a title came from, so a name a person chose is never overwritten by an
 * automatic one. The daily retitle job (`src/jobs/retitleRun.ts`) proposes names
 * only for chats still marked `prompt`, so a typed name, and a name the job
 * already gave, are both left alone from then on.
 *
 * `title_source` is optional on every record: chats written before the field
 * still parse, and `titleSourceOf` below resolves them.
 */
export type TitleSource = 'prompt' | 'user' | 'auto';

/**
 * The source of a title, resolving records written before the field existed.
 *
 * An old record has no field to read, so it is judged the way the field would
 * have been written at the time: a title equal to `deriveTitle` of its first
 * user line is the automatic one, anything else came from a person. A record
 * whose first line is not at hand is treated as `user`, because that is the
 * direction that cannot rename something the owner named themselves.
 */
export function titleSourceOf(
  record: { title_source?: TitleSource | undefined; title: string },
  firstUserLine?: string,
): TitleSource {
  if (record.title_source) return record.title_source;
  // A placeholder is never a name a person chose, even when its first line
  // cannot be read (a log-sourced archive row has no body).
  if (isUntitled(record.title)) return 'prompt';
  if (firstUserLine === undefined) return 'user';
  const line = firstUserLine.replace(/\s+/g, ' ').trim();
  const legacyTitle =
    line.length > LEGACY_TITLE_MAX_LEN ? `${line.slice(0, LEGACY_TITLE_MAX_LEN)}…` : line;
  return record.title === deriveTitle(firstUserLine) || record.title === legacyTitle
    ? 'prompt'
    : 'user';
}

/**
 * Drop a leading ATX heading marker (`#`, `##`, up to `######`) from a line a
 * chat is about to be named from. An agent brief that opens
 * `# Split SdServerBackend.ts` is *about* that file; the `#` is its document
 * structure, not part of its name, and a title starting in `# ` reads as a
 * formatting accident in a list of chats.
 *
 * A `#` with no space after it is a hashtag, not a heading, and stays.
 */
export function stripHeadingMarker(line: string): string {
  return line.replace(/^#{1,6}[ \t]+/u, '').trim();
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
