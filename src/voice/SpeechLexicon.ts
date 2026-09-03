import table from './lexicon.json';

/**
 * How a technical token should be SAID.
 *
 * `SpeechRenderer` handles structure -- fences, paths, tables, links. This
 * handles vocabulary, which is the half that made a 41-second reply out of four
 * sentences: `b10733`, `a15...bdc`, `Q3_K_XL.gguf` and `GGUF` have no natural
 * spoken form, and espeak will attempt every one of them as a word.
 *
 * Two ideas, in priority order:
 *
 * 1. A curated lexicon (`lexicon.json`) for terms whose pronunciation is simply
 *    known -- CUDA, npm, YAML, Qwen.
 * 2. Generic token classes for everything else, because a lexicon can never
 *    cover build ids and hashes. Long opaque tokens are REPLACED by a category
 *    word, short ones are spelled out. Saying "a hash" costs one second and
 *    loses nothing: the exact value is in the written message, which is where
 *    anyone would read it from anyway.
 *
 * Deliberately NOT phoneme-based. §15's `[[ phonemes ]]` escape is not honored
 * by piper 1.2.0 -- measured, see `lexicon.json`. The entry schema carries
 * optional phoneme fields for a runtime that supports them; nothing emits them.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §14, §15.
 */

export interface LexiconEntry {
  readonly en_text?: string;
  readonly el_text?: string;
  readonly en_phonemes?: string;
  readonly el_phonemes?: string;
}

/** `_readme` is documentation living with the data; it is not a term. */
const ENTRIES: ReadonlyMap<string, LexiconEntry> = new Map(
  Object.entries(table as Record<string, unknown>)
    .filter(([key, value]) => !key.startsWith('_') && typeof value === 'object' && value !== null)
    .map(([key, value]) => [key.toLowerCase(), value as LexiconEntry]),
);

/**
 * An elided identifier -- `a15...bdc` in a chat header. Handled before
 * tokenization because the ellipsis is what makes it recognizable, and the
 * renderer's own punctuation collapsing would destroy that evidence.
 */
const ELIDED_ID = /\b[0-9a-f]{2,}\.{3}[0-9a-f]{2,}\b/gi;

/**
 * A hash. At least one digit is REQUIRED so ordinary English words made only of
 * hex letters -- `decade`, `facade`, `deface` -- can never match. That guard is
 * the whole reason this is not simply `[0-9a-f]{7,}`.
 */
const HASH = /^(?=.*\d)[0-9a-f]{7,}$/i;

/** A dotted version. Read with the dots said, not swallowed into one number. */
const VERSION = /^\d+(?:\.\d+)+$/;

/** Words a listener wants read as digits, where the number is an address. */
const SPELLED_AFTER = /\b(port|pid|ports)\s+(\d{2,6})\b/gi;

const DIGITS_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const DIGITS_EL = [
  'μηδέν',
  'ένα',
  'δύο',
  'τρία',
  'τέσσερα',
  'πέντε',
  'έξι',
  'επτά',
  'οκτώ',
  'εννέα',
];

/**
 * A token: letters, digits and underscores, extended across dots and hyphens
 * ONLY when the separator is followed by more of the same. That is what keeps
 * `llama.cpp` and `Bridge.ts` whole while leaving a sentence-final full stop
 * alone -- and the hyphen is what lets `Qwen3.8-27B-UD-Q3_K_XL.gguf` be
 * recognized as ONE machine-generated name instead of five fragments each
 * spelled out separately.
 */
const TOKEN = /[A-Za-z0-9_]+(?:[._-][A-Za-z0-9_]+)*/g;

export type SpeechLanguage = 'en' | 'el';

function digits(text: string, language: SpeechLanguage): string {
  const names = language === 'el' ? DIGITS_EL : DIGITS_EN;
  return [...text].map((d) => names[Number(d)] ?? d).join(' ');
}

/**
 * Looks a term up, falling back to the other language's spelling.
 *
 * The entry is stored in its natural casing, so a sentence-initial `Forge`
 * would come back as `forge` and quietly decapitalize the sentence. espeak uses
 * capitalization as one of its sentence-boundary cues, so this is not merely
 * cosmetic in a transcript nobody reads.
 */
function lookup(token: string, language: SpeechLanguage): string | undefined {
  const entry = ENTRIES.get(token.toLowerCase());
  if (!entry) return undefined;
  const said =
    (language === 'el' ? entry.el_text : entry.en_text) ?? entry.en_text ?? entry.el_text;
  if (said === undefined) return undefined;
  // Only a TITLE-CASE token carries its capital across. An all-caps acronym
  // does not: `YAML` is capitalized because it is an acronym, not because it
  // starts a sentence, and "Yammle" mid-sentence would be wrong.
  const titleCase = /^\p{Lu}/u.test(token) && !/^\p{Lu}+$/u.test(token);
  return titleCase && /^\p{Ll}/u.test(said) ? said[0]!.toUpperCase() + said.slice(1) : said;
}

/**
 * Renders one indivisible token -- no dots, no underscores left.
 *
 * Order matters: the lexicon always wins, because it is the only part of this
 * that someone deliberately decided.
 */
function part(token: string, language: SpeechLanguage): string {
  const known = lookup(token, language);
  if (known !== undefined) return known;

  if (HASH.test(token)) return language === 'el' ? 'ένα hash' : 'a hash';

  // Mixed letters and digits: a build id, a quant name, a revision. Letters are
  // spelled, digits are read one at a time -- `b10733` is not ten thousand
  // anything, and reading it as a number states a quantity that does not exist.
  if (/[A-Za-z]/.test(token) && /\d/.test(token)) {
    return token
      .split(/(\d+)/)
      .filter(Boolean)
      .map((chunk) => (/^\d+$/.test(chunk) ? digits(chunk, language) : letters(chunk, language)))
      .join(' ');
  }

  if (/^[A-Z]{2,5}$/.test(token)) return token.split('').join(' ');
  return camel(token);
}

/** Spells an acronym, but leaves a real word as a word. */
function letters(chunk: string, language: SpeechLanguage): string {
  const known = lookup(chunk, language);
  if (known !== undefined) return known;
  if (/^[A-Z]{1,5}$/.test(chunk)) return chunk.split('').join(' ');
  return camel(chunk);
}

/**
 * `RemoteVoiceBridge` -> `Remote Voice Bridge`.
 *
 * espeak runs an unsplit identifier together into one unpronounceable word.
 * Only applied to letter-only tokens with an internal capital, so ordinary
 * prose is never touched.
 */
function camel(token: string): string {
  if (!/^[A-Za-z]+$/.test(token) || !/[a-z][A-Z]/.test(token)) return token;
  return token.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Extensions whose file NAME is usually machine-generated rather than chosen.
 *
 * `Qwen3.8-27B-UD-Q3_K_XL.gguf` spelled out is eleven seconds of letters that
 * nobody can write down from audio, and the name is in the written message
 * anyway. `.exe` and `.dll` are the opposite case: `llama-server` is a name a
 * person picked and says out loud, so only the extension is dropped.
 */
const FILE_KINDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\.(?:gguf|onnx|safetensors|bin|pt|pth)$/i, 'a model file', 'ένα αρχείο μοντέλου'],
  [/\.(?:zip|tar|gz|7z|vsix|whl)$/i, 'an archive', 'ένα αρχείο συμπίεσης'],
];

/** Extensions worth dropping outright, leaving the stem to be spoken. */
const SILENT_EXTENSION = /\.(?:exe|dll|so|dylib|lib|obj)$/i;

/**
 * How long a stem has to be before it stops being a name and starts being an
 * identifier. `model.gguf` is worth saying; `Qwen3.8-27B-UD-Q3_K_XL.gguf` is
 * not, and the digits are what mark the difference.
 */
const OPAQUE_STEM = /\d/;
const OPAQUE_STEM_CHARS = 12;

function fileName(token: string, language: SpeechLanguage): string | undefined {
  for (const [pattern, en, el] of FILE_KINDS) {
    if (!pattern.test(token)) continue;
    const stem = token.replace(pattern, '');
    if (stem.length >= OPAQUE_STEM_CHARS && OPAQUE_STEM.test(stem))
      return language === 'el' ? el : en;
    return undefined;
  }
  if (SILENT_EXTENSION.test(token)) {
    return applyLexicon(token.replace(SILENT_EXTENSION, ''), language);
  }
  return undefined;
}

/**
 * Rewrites every technical token in `text` for speech.
 *
 * Whole tokens only, never substrings. This repo has been bitten twice by
 * substring matching in a guard (`rm -rf` matching a bare `r`, a shell-operator
 * check matching inside a script), and the failure here would be quieter than
 * either: a term silently mangled inside a longer identifier, audible only to
 * whoever is listening at the time.
 */
export function applyLexicon(text: string, language: SpeechLanguage = 'en'): string {
  let out = text.replace(ELIDED_ID, language === 'el' ? 'ένα αναγνωριστικό' : 'an I D');
  out = out.replace(
    SPELLED_AFTER,
    (_m, word: string, value: string) => `${word} ${digits(value, language)}`,
  );
  return out.replace(TOKEN, (token) => {
    const known = lookup(token, language);
    if (known !== undefined) return known;
    // A version number keeps its dots audible: "zero point fifteen point
    // thirteen" is a version, "zero fifteen thirteen" is three numbers.
    if (VERSION.test(token)) {
      return token.split('.').join(language === 'el' ? ' τελεία ' : ' point ');
    }
    const filed = fileName(token, language);
    if (filed !== undefined) return filed;
    // Split only after the whole-token lookup, so `llama.cpp` is found as
    // itself rather than as `llama` plus `cpp`.
    if (/[._-]/.test(token)) {
      return token
        .split(/[._-]/)
        .filter(Boolean)
        .map((piece) => part(piece, language))
        .join(' ');
    }
    return part(token, language);
  });
}
