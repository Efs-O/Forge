/**
 * Lyrics and the Flamingo caption for `generate_music`.
 *
 * The plan's rule (docs/plans/MEDIA_SHIPPED_PLAN.md §1, "Replicate from an MP3")
 * is that nothing passes through the model in that mode: the caption and the
 * lyric text come from the run's own analysis files. ACE keeps its 512-character
 * caption trim; Stable Audio removes whole vocal-related sentences and has no
 * adapter prompt ceiling. Every change is reported. No
 * paraphrase, no reordering, no metadata-only fallback — and no invented
 * lyrics: Music Flamingo's own analysis says it does not transcribe, so a
 * `lyrics: analysis` request fails closed unless the run actually produced
 * lyric text.
 *
 * ACE captions and supplied lyrics keep their original whitespace before any
 * reported limit cut. For SA3, every retained sentence stays byte-identical;
 * the removed sentences are listed in the run report.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { writeFileAtomic } from '../../util/atomicWrite';
import {
  ACE_CAPTION_LIMIT_CHARS,
  ACE_INSTRUMENTAL_LYRICS,
  ACE_LYRICS_LIMIT_CHARS,
} from './mediaJobFile';

export type MusicCaptionEngine = 'ace_standalone' | 'comfyui_sa3';

export function captionOriginReport(replicate: boolean, engine: MusicCaptionEngine): string {
  if (!replicate) return 'the user’s style prompt';
  return engine === 'comfyui_sa3'
    ? 'Flamingo description with vocal-related sentences removed for Stable Audio'
    : 'Flamingo description, copied verbatim';
}

export function replicateModeResult(engine: MusicCaptionEngine): string {
  return engine === 'comfyui_sa3'
    ? 'Replicate mode: Stable Audio removes vocal-related sentences, appends ' +
        '"instrumental music throughout", and reports each removed sentence in the manifest and completion notice.'
    : 'Replicate mode: ACE copies the caption and any lyric text from this run’s ' +
        'analysis files; its caption and lyric trims are reported in the manifest and completion notice.';
}

export function replicateSourceNote(engine: MusicCaptionEngine): string {
  return engine === 'comfyui_sa3'
    ? ' adapted for Stable Audio instrumental output (replicate: true)'
    : ' copied verbatim (replicate: true)';
}

/** Trim to an engine's ceiling and keep what was cut, so the result can say so. */
export function trimTo(
  text: string,
  limit: number,
  what: string,
): { text: string; report?: string } {
  if (text.length <= limit) return { text };
  const cut = text.slice(limit);
  return {
    text: text.slice(0, limit),
    report:
      `${what} was ${text.length} characters, over the engine's ${limit}: the last ` +
      `${cut.length} were cut (${JSON.stringify(cut.slice(0, 120))}). ` +
      'Shorten it and rerun if you wanted those words.',
  };
}

/** Read a file the model wrote, byte for byte; only a missing one is refused. */
async function readTextFile(candidate: string, what: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(candidate, 'utf8');
  } catch (error) {
    throw new Error(
      `${what} could not be read at "${candidate}": ` +
        `${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return raw;
}

export interface MediaLyricsResolution {
  /** The file the adapter reads as `inputs.lyrics_path`. */
  path: string;
  /** The exact text that will be sung. */
  text: string;
  /** Where the words came from, in the user's terms. */
  source: string;
  /** Trim reports, shown in the result and kept in the job file's details. */
  reports: string[];
}

/**
 * `lyrics: user` and `lyrics: agent` both arrive as a file the model already
 * wrote — the user's own words, or words the agent wrote and the user approved.
 * The tool never rewrites them beyond the engine's 4096-character ceiling.
 */
export async function resolveSuppliedLyrics(
  lyricsPath: string,
  source: string,
): Promise<MediaLyricsResolution> {
  const text = await readTextFile(
    lyricsPath,
    `generate_music: lyrics_path for "lyrics: ${source}"`,
  );
  // Whitespace-only is still nothing to sing; the text itself is passed on
  // untrimmed, because these are the words the user chose.
  if (text.trim() === '') {
    throw new Error(
      `generate_music: lyrics_path "${lyricsPath}" is empty, so there is nothing to sing. ` +
        'Write the words there first, or send lyrics: none for an instrumental.',
    );
  }
  const trimmed = trimTo(text, ACE_LYRICS_LIMIT_CHARS, 'Lyrics');
  return {
    path: lyricsPath,
    text: trimmed.text,
    source: `the ${source}'s own words, read unchanged from "${lyricsPath}"`,
    reports: trimmed.report ? [trimmed.report] : [],
  };
}

/**
 * `lyrics: none` on ACE-Step: the runtime still needs a lyrics file, and the
 * plan's answer is the marker, not an empty file. Stable Audio 3 never gets here
 * (it is instrumental by construction and refuses a lyrics path outright).
 */
export async function writeInstrumentalLyrics(runDir: string): Promise<MediaLyricsResolution> {
  const target = path.join(runDir, 'input', 'lyrics.txt');
  await writeFileAtomic(target, `${ACE_INSTRUMENTAL_LYRICS}\n`);
  return {
    path: target,
    text: ACE_INSTRUMENTAL_LYRICS,
    source: 'nobody: instrumental, marked ' + ACE_INSTRUMENTAL_LYRICS,
    reports: [],
  };
}

/**
 * The analysis stage's own output: `music_analyze.py` writes
 * `output/analysis.json` with `raw_text`, `raw_records` and `fields`, and the
 * manifest says whether the stage completed. Everything replicate-mode reads
 * comes from those files, so a stage that did not finish is refused rather
 * than answered with a guess.
 */
export interface MediaAnalysis {
  rawText: string;
  fields: Record<string, unknown>;
  warnings: string[];
}

export async function readAnalysis(runDir: string, toolName: string): Promise<MediaAnalysis> {
  const analysisPath = path.join(runDir, 'output', 'analysis.json');
  const manifestPath = path.join(runDir, 'manifest.json');
  let manifest: { status?: string; engine?: string } | undefined;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest =
      parsed && typeof parsed === 'object'
        ? (parsed as { status?: string; engine?: string })
        : undefined;
  } catch {
    manifest = undefined;
  }
  if (!manifest || manifest.status !== 'completed') {
    throw new Error(
      `${toolName}: the analysis stage of this run left no completed manifest, so nothing ` +
        'was analysed. The render stage did not start; check the run folder logs.',
    );
  }
  const analysis = JSON.parse(await fs.readFile(analysisPath, 'utf8')) as {
    engine?: string;
    raw_text?: string;
    raw_records?: unknown[];
    fields?: Record<string, unknown>;
    warnings?: string[];
  };
  if (
    analysis.engine !== 'flamingo_dlt' ||
    typeof analysis.raw_text !== 'string' ||
    !analysis.raw_text.trim()
  ) {
    throw new Error(
      `${toolName}: the analysis stage produced no raw Flamingo text, so a replicate ` +
        'render has nothing to copy. It did not start.',
    );
  }
  return {
    rawText: analysis.raw_text,
    fields: analysis.fields ?? {},
    warnings: analysis.warnings ?? [],
  };
}

/**
 * Flamingo's description for ACE, byte for byte, cut only at its 512-character
 * caption limit — and the cut is reported, never silent (the plan's replicate rule).
 */
export function flamingoCaption(
  analysis: MediaAnalysis,
  engine: MusicCaptionEngine,
): { text: string; reports: string[] } {
  if (engine === 'comfyui_sa3') return stableAudioCaption(analysis.rawText);
  const trimmed = trimTo(analysis.rawText, ACE_CAPTION_LIMIT_CHARS, 'The Flamingo description');
  return { text: trimmed.text, reports: trimmed.report ? [trimmed.report] : [] };
}

function sentenceChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!'.!?'.includes(text[index])) continue;
    if (
      text[index] === '.' &&
      index > 0 &&
      index + 1 < text.length &&
      /\d/.test(text[index - 1]) &&
      /\d/.test(text[index + 1])
    ) {
      continue;
    }
    let end = index + 1;
    while (end < text.length && '.!?'.includes(text[end])) end += 1;
    while (end < text.length && /["'”’)}\]]/.test(text[end])) end += 1;
    if (end < text.length && !/\s/.test(text[end])) continue;
    chunks.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

const VOCAL_OR_LYRIC_WORDING =
  /\b(?:vocals?|vocalist|singers?|sing(?:s|ing)?|sang|sung|lyrics?|lyricist|rapped|rapping|spoken\s+word)\b/iu;

function stableAudioCaption(rawText: string): { text: string; reports: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const sentence of sentenceChunks(rawText)) {
    (VOCAL_OR_LYRIC_WORDING.test(sentence) ? removed : kept).push(sentence);
  }
  const instrumentalPrompt = kept.join('');
  const separator = instrumentalPrompt && !/\s$/.test(instrumentalPrompt) ? ' ' : '';
  return {
    text: `${instrumentalPrompt}${separator}instrumental music throughout`,
    reports: [
      'Stable Audio 3 has no hard prompt length limit; the caption was not trimmed.',
      ...removed.map(
        (sentence) =>
          `Removed vocal-related sentence from Flamingo description: ${JSON.stringify(sentence)}`,
      ),
    ],
  };
}

/**
 * The only lyric text this mode may use: whatever the analysis itself contains.
 * Labelled as Flamingo's partial, unverified hearing — the plan's rule that
 * `lyrics: user` is how the real words get in.
 */
export function flamingoLyrics(
  analysis: MediaAnalysis,
  runDir: string,
): { text: string; source: string } {
  const labelled = /\b(?:lyrics?|words?)\s*[:=]\s*([\s\S]+?)(?:\r?\n\r?\n|$)/iu.exec(
    analysis.rawText,
  );
  const fromRecords = [
    analysis.fields['lyrics'],
    analysis.fields['lyric_text'],
    analysis.fields['transcript'],
  ].find((value) => typeof value === 'string' && value.trim());
  // Verbatim: Flamingo own spacing is kept. An all-whitespace answer is still
  // no lyric text at all, and the text handed on is the untrimmed original.
  const candidate = typeof fromRecords === 'string' ? fromRecords : labelled?.[1];
  if (!candidate || candidate.trim() === '') {
    throw new Error(
      'generate_music: this Flamingo analysis returned no lyric text, so "lyrics: analysis" ' +
        'has nothing to copy. Its own warnings say Music Flamingo analysis does not transcribe ' +
        'lyrics; it is not a transcription engine. Use lyrics: user (your own words) or ' +
        'lyrics: agent (words written from the analysis, shown to you first), or lyrics: none ' +
        'for an instrumental. Nothing was rendered.',
    );
  }
  return {
    text: candidate,
    source:
      `Flamingo's own partial hearing, copied verbatim from "${path.join(runDir, 'output', 'analysis.json')}" ` +
      'and unverified: lyrics: user is how the real words get in',
  };
}

/**
 * Write lyric text the tool produced itself (analysis mode) into the run: the
 * extracted text byte for byte, no added newline, cut only at ACE lyrics
 * ceiling, and that cut reported.
 */
export async function writeLyricsFile(target: string, text: string): Promise<string> {
  const trimmed = trimTo(text, ACE_LYRICS_LIMIT_CHARS, 'Lyrics');
  await writeFileAtomic(target, trimmed.text);
  return trimmed.report ?? '';
}
