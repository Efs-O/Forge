/**
 * `generate_music`'s strict schema, kept apart from the tool's behaviour so
 * the canonical literal (`scripts/tool-audit-catalog.mjs` extracts it) stays
 * readable and the tool file stays under the repo's 500-line stop.
 */
import type { MediaConfig } from '../../config/mediaSchema';
import type { ToolDefinition } from '../../llm/types';

export const MUSIC_TOOL_NAME = 'generate_music';
/** The launcher's own shell, the same one the shipped adapter's tests use. */
export const POWERSHELL = 'powershell.exe';
export const MUSIC_PROMPT_ARGUMENT_LIMIT = 2_000;

export const MUSIC_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: MUSIC_TOOL_NAME,
    description:
      'Render a music track with the configured local engine. The lyrics choice routes the engine: ' +
      'user, agent or analysis lyrics go to ACE-Step 1.5 (it can sing), none goes to Stable Audio 3 ' +
      'post-trained (it cannot). An audio source is analysed first by Music Flamingo DLT. Replicate ' +
      'copies its caption to ACE; for Stable Audio, vocal-related sentences are removed and ' +
      '"instrumental music throughout" is appended. The render starts in the ' +
      'background and this call returns the run id, the run folder and what it will do; the chat is ' +
      'woken with the run manifest when it ends.',
    parameters: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          maxLength: MUSIC_PROMPT_ARGUMENT_LIMIT,
          description:
            'The song-style caption: genre, mood, instruments, tempo (up to 2,000 characters). ' +
            'ACE-Step accepts up to 512; Stable Audio has no adapter prompt ceiling. Omit style only ' +
            'with replicate: true, which uses this run\u2019s Flamingo analysis instead.',
        },
        lyrics: {
          type: 'string',
          enum: ['user', 'agent', 'analysis', 'none'],
          description:
            'Who writes the words: user (your own text in lyrics_path), agent (words you wrote and ' +
            'the user approved, in lyrics_path), analysis (Flamingo\u2019s verbatim partial hearing), ' +
            'none (instrumental, and Stable Audio 3 is used).',
        },
        lyrics_path: {
          type: 'string',
          description:
            'A workspace file holding the lyric text. Required for user, agent and analysis; refused ' +
            'for none, which keeps lyrics out of an inline blob.',
        },
        source_audio_path: {
          type: 'string',
          description:
            'An MP3, OGG/Opus, M4A, WAV, FLAC, AAC or WebM audio file to analyse first: Music Flamingo DLT describes it, and the ' +
            'description guides the render. Not a voice clone and not a cover.',
        },
        analyze: {
          type: 'boolean',
          description:
            'Run the Flamingo analysis stage. Defaults to true when source_audio_path is set, and ' +
            'to false otherwise.',
        },
        replicate: {
          type: 'boolean',
          description:
            'Copy the Flamingo description and, when lyrics is analysis, its lyric text from this ' +
            'run. ACE receives the caption unchanged apart from its 512-character trim. Stable Audio ' +
            'has vocal-related sentences removed, then appends "instrumental music throughout"; ' +
            'every removed sentence is reported. Omit style.',
        },
        engine: {
          type: 'string',
          description:
            'Override the routed engine within what it can do: ace_step with lyrics none is an ' +
            'instrumental, stable_audio with lyrics is refused because it cannot sing.',
        },
        seconds: {
          type: 'number',
          description:
            'Track length. Default is the source duration when one was given, otherwise ' +
            'media.music.default_seconds; capped at the engine\u2019s max_seconds.',
        },
        seed: {
          type: 'integer',
          minimum: 0,
          description:
            'Reproduce a track. Absent means the adapter picks one and the manifest records it.',
        },
      },
      required: ['lyrics'],
      additionalProperties: false,
    },
  },
};

/** The configured ids, offered as the enum the model was actually shown. */
export function withMusicEngineEnum(media: MediaConfig | undefined): ToolDefinition {
  const copy = structuredClone(MUSIC_DEFINITION);
  const engines = media?.music?.engines ?? [];
  if (engines.length) {
    const properties = copy.function.parameters.properties as Record<string, unknown>;
    (properties.engine as Record<string, unknown>).enum = engines.map((engine) => engine.id);
  }
  return copy;
}
