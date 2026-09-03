/**
 * Agent reply -> something worth hearing.
 *
 * A coding assistant's reply is mostly things that are unbearable read aloud:
 * fenced code, file paths, markdown scaffolding, tables. Piper will happily
 * pronounce every backtick and slash of it, and the result is not a degraded
 * version of the feature -- it is a reason to turn the feature off.
 *
 * So the rule here is SUMMARIZE, NOT NARRATE: keep the prose, replace the
 * machinery with a short spoken placeholder that says it exists. The written
 * message is already in the chat; speech is a second channel for the gist, not
 * a substitute for reading it.
 *
 * Deliberately deterministic and dependency-free -- no model, no lexicon yet.
 * §14's pronunciation lexicon and §15's raw-phoneme injection layer on top of
 * this later; neither is needed for a reply to be worth listening to.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §12, §13.
 */

import { applyLexicon } from './SpeechLexicon';

/** Beyond this a spoken reply stops being a summary and becomes a podcast. */
const DEFAULT_MAX_CHARS = 600;

/**
 * Language for the sentence stitched in place of a code block. Kept here rather
 * than in a template so the two locales cannot drift apart.
 */
function codeBlockPhrase(lines: number, language: 'en' | 'el'): string {
  if (language === 'el') {
    return lines === 1 ? ' Μία γραμμή κώδικα. ' : ` Κώδικας, ${lines} γραμμές. `;
  }
  return lines === 1 ? ' One line of code. ' : ` Code block, ${lines} lines. `;
}

/**
 * A path, in three shapes, assembled from a string so each branch can be read.
 *
 * The branches differ in what counts as EVIDENCE that a slash is a path
 * separator rather than punctuation, because `and/or` must survive:
 *
 * 1. A drive letter settles it outright, so one segment is enough -- and only
 *    here are spaces allowed inside a segment. This user's home directory is
 *    `C:/Users/efso office/`, and without that the match stopped at the space
 *    and left the orphan word `efso` to be read aloud. It is confined to this
 *    branch because a space-tolerant segment elsewhere would happily swallow
 *    the prose in front of a path ("Open the src/a.ts file" -> "Open a.ts").
 * 2. Two or more separators.
 * 3. One separator, where the final name carries a dot -- `.forge/config.yaml`.
 *
 * The drive branch must not be folded into the others as an optional prefix: it
 * then matches empty, the match begins at the first directory, and the drive
 * root survives to be spoken as "C colon backslash".
 */
const SEGMENT = String.raw`[\w.-]+`;
const SEGMENT_WITH_SPACES = String.raw`[\w.-]+(?:\x20[\w.-]+)*`;
/** Either separator. Windows paths arrive with backslashes and must not be lost. */
const SEP = String.raw`[\\/]`;
const PATH = new RegExp(
  '(?:' +
    String.raw`[A-Za-z]:${SEP}(?:${SEGMENT_WITH_SPACES}${SEP})*` +
    String.raw`|${SEP}?(?:${SEGMENT}${SEP}){2,}` +
    String.raw`|(?:${SEGMENT}${SEP})+(?=[\w-]*\.[\w-])` +
    ')' +
    String.raw`([\w.-]+)`,
  'g',
);

export interface SpeechRenderOptions {
  readonly language?: 'en' | 'el' | undefined;
  readonly maxChars?: number | undefined;
}

/**
 * The sentences this module SUBSTITUTES IN. A reply made only of these carries
 * no information a listener can use.
 */
const PLACEHOLDER_PATTERNS = [
  /(?:code block, \d+ lines|one line of code)\.?/gi,
  /(?:κώδικας, \d+ γραμμές|μία γραμμή κώδικα)\.?/gi,
  /a table\.?/gi,
  /ένας πίνακας\.?/gi,
  /a link/gi,
];

/**
 * True when a reply is worth speaking at all.
 *
 * Measured on what is left after the placeholders are removed, not on total
 * length: "Code block, 12 lines." is 21 characters of nothing, and hearing it
 * with no surrounding sentence is worse than hearing silence. The user still
 * has the written message, which is where the code was going to be read anyway.
 */
export function isWorthSpeaking(rendered: string): boolean {
  let prose = rendered;
  for (const pattern of PLACEHOLDER_PATTERNS) prose = prose.replace(pattern, ' ');
  return prose.replace(/[\s.,;:]+/g, ' ').trim().length >= 12;
}

export function renderForSpeech(markdown: string, options: SpeechRenderOptions = {}): string {
  const language = options.language ?? 'en';
  let text = markdown;

  // Fenced code first: everything inside is exempt from every rule below, so it
  // has to leave before any of them run.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, body: string) =>
    codeBlockPhrase(body.replace(/\n$/, '').split('\n').length, language),
  );
  // An unterminated fence means the reply was cut off mid-block. Everything from
  // the fence on is code, and saying so is more useful than reading it.
  text = text.replace(/```[\s\S]*$/, codeBlockPhrase(1, language));

  // Inline code keeps its content -- `npm run ci` is worth hearing, the
  // backticks are not. Paths inside it are handled below like any other path.
  text = text.replace(/`([^`]+)`/g, '$1');

  text = text
    // Links: say the label, drop the URL. A spoken URL is never useful.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Bare URLs have no label to fall back on.
    .replace(/https?:\/\/\S+/g, ' a link ')
    .replace(/^#{1,6}\s+/gm, '')
    // A list item is a sentence when spoken. Stripping the bullet alone runs
    // the items together into one breathless clause, because the newline
    // between them collapses to a space further down; the full stop is what
    // makes Piper pause where the eye would have seen a new line.
    .replace(/^\s*[-*+]\s+(.*?)\s*$/gm, (_m, item: string) =>
      /[.!?;:]$/.test(item) ? item : `${item}.`,
    )
    .replace(/^\s*>\s?/gm, '')
    // Emphasis markers only; a lone asterisk or underscore inside a word (a
    // snake_case identifier) is not markup and must survive.
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(?<!\w)[*_](\S(?:.*?\S)?)[*_](?!\w)/g, '$1')
    // A table read aloud is pipes and dashes. Say that one exists instead.
    .replace(/^\|.*\|\s*$/gm, language === 'el' ? 'Ένας πίνακας.' : 'A table.')
    .replace(/^[-=]{3,}\s*$/gm, '')
    // An arrow is punctuation espeak has no word for. It reads as "then" in
    // every place Forge emits one: a config key resolving to a value, a
    // before/after.
    .replace(/\s*(?:->|=>|→|⇒)\s*/g, language === 'el' ? ' στο ' : ' to ');

  // A path is the worst thing to hear character by character. Keep the final
  // segment, which is the part a person would actually say. See PATH above for
  // why it has three branches.
  text = text.replace(PATH, '$1');

  // Vocabulary last of the content passes, and after the path collapse above:
  // it should see `Bridge.ts`, not the six directory segments in front of it.
  text = applyLexicon(text, language);

  // Collapse whatever the substitutions left behind. Paragraph breaks become
  // sentence breaks so Piper still pauses in roughly the right places.
  text = text
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/(?:\.\s*){2,}/g, '. ')
    .trim();

  return truncateAtSentence(text, options.maxChars ?? DEFAULT_MAX_CHARS, language);
}

/**
 * Cuts at a sentence boundary rather than mid-word.
 *
 * A spoken reply that stops mid-sentence sounds like a crash, and the listener
 * cannot tell it from one -- unlike a truncated written message, there is no
 * ellipsis to see.
 */
function truncateAtSentence(text: string, maxChars: number, language: 'en' | 'el'): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  const body = lastStop > maxChars * 0.4 ? head.slice(0, lastStop + 1) : `${head.trimEnd()}.`;
  return `${body}${language === 'el' ? ' Συνεχίζεται στο κείμενο.' : ' The rest is in the message.'}`;
}
