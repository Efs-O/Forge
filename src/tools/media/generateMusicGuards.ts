/**
 * The request-level refusals `generate_music` makes before it touches a GPU.
 *
 * They are argument rules, not stage machinery: every one is a fail-closed
 * answer the model can act on, and they are the plan’s rules that a lyric
 * mode never invents text and a replicate never paraphrases. Nothing here
 * reads a file, takes a lease or spawns a child.
 */
import { ACE_CAPTION_LIMIT_CHARS } from './mediaJobFile';

export interface MusicRequest {
  /** The lyrics mode the schema enum allowed: it is what routes the engine. */
  lyricsMode: 'user' | 'agent' | 'analysis' | 'none';
  /** The song-style caption, when the user sent one. */
  style?: string;
  /** The lyrics file the user named. */
  lyricsPath?: string;
  /** The MP3 to analyse, when the user named one. */
  sourceAudio?: string;
  /** Whether this run analyses the MP3: `analyze`, else implied by a source. */
  analyze: boolean;
  /** Replicate mode: copy the analysis instead of writing a caption. */
  replicate: boolean;
}

/** Refuse a request that cannot deliver what it asks for; each fix is named. */
export function refuseInvalidMusicRequest(request: MusicRequest): void {
  const { lyricsMode, style, lyricsPath, sourceAudio, analyze, replicate } = request;
  // lyrics_path: required for the three sung modes, refused for the instrumental.
  if (lyricsMode === 'none' && lyricsPath) {
    throw new Error(
      `generate_music: lyrics_path is refused when lyrics is "none" \u2014 it would be read as ` +
        'lyric text anyway. Drop lyrics_path for an instrumental, or pick a sung mode.',
    );
  }
  if (lyricsMode !== 'none' && !lyricsPath) {
    throw new Error(
      `generate_music: lyrics_path is required when lyrics is "${lyricsMode}". ` +
        'Write the words to a workspace file first (for agent lyrics, show them to the user and ' +
        'let them approve), then pass that path.',
    );
  }
  if (replicate && style) {
    throw new Error(
      'generate_music: replicate: true copies Flamingo\u2019s own description, so style must be ' +
        'omitted \u2014 a style here would be a paraphrase of it. Drop one of the two.',
    );
  }
  if (!replicate && !style) {
    throw new Error(
      'generate_music: style is required \u2014 the song-style caption (genre, mood, instruments, ' +
        'tempo) \u2014 unless replicate: true, which takes the analysis text instead.',
    );
  }
  if (replicate && !sourceAudio) {
    throw new Error(
      'generate_music: replicate: true needs source_audio_path \u2014 there is no MP3 to analyse, ' +
        'so there is nothing to copy. Pass the MP3, or send style yourself.',
    );
  }
  if (analyze && !sourceAudio) {
    throw new Error(
      'generate_music: analyze needs source_audio_path, or pass analyze: false with a style prompt.',
    );
  }
  // Fail closed: replicate and `lyrics: analysis` both copy their text out of
  // this run\u2019s own analysis, so an analyze switched off is a refusal, never a
  // caption-less replicate render or a run with invented words.
  if (replicate && !analyze) {
    throw new Error(
      'generate_music: replicate: true with analyze: false has nothing to copy, because the ' +
        'caption comes from this run\u2019s analysis of the MP3. Pass the MP3 and leave ' +
        'analyze on (omit analyze, or send analyze: true), or send style yourself and drop ' +
        'replicate.',
    );
  }
  if (lyricsMode === 'analysis' && (!sourceAudio || !analyze)) {
    throw new Error(
      `generate_music: lyrics: "analysis" copies lyric text out of this run\u2019s analysis, so ` +
        `it needs source_audio_path and analyze on (${
          !sourceAudio ? 'no source_audio_path was given' : 'analyze: false was sent'
        }). Pass the MP3 and leave analyze on, or use lyrics: user / lyrics: agent with a ` +
        'lyrics_path you wrote. Nothing was rendered.',
    );
  }
}

/** ACE's caption ceiling is checked after routing; SA3 has no adapter ceiling. */
export function refuseOverlongAceStyle(style: string | undefined): void {
  if (style !== undefined && style.length > ACE_CAPTION_LIMIT_CHARS) {
    throw new Error(
      `generate_music: style is ${style.length} characters, over ACE-Step's ` +
        `${ACE_CAPTION_LIMIT_CHARS}-character caption limit. Shorten it before rendering.`,
    );
  }
}
