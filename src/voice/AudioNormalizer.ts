import { spawn } from 'child_process';
import { resolveFfmpeg } from '../tools/ffmpegLocate';
import type { VoiceAudioHandle } from './VoiceTypes';
import { VoiceTranscriptionError } from './VoiceTypes';
import type { VoiceOperation } from './VoiceOperation';

/**
 * Anything -> 16 kHz mono s16 WAV, the input both STT candidates want.
 *
 * ffmpeg discovery is NOT reimplemented here: `src/tools/ffmpegLocate.ts` owns
 * it, including the WinGet walk and the typed missing-binary error whose
 * message names the install command. The configured override stays the existing
 * `video.ffmpeg_path` key -- a second ffmpeg path setting would be two owners
 * for one concern.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §10, §24 (silence trimming).
 */

/**
 * Trailing-silence trim, tuned CONSERVATIVELY on purpose.
 *
 * whisper.cpp appends spurious end-of-audio lines (a line repeated x4, a stray
 * "Thank you") -- measured, §27.1 -- and trimming silence is the cheap
 * mitigation. But the same filter clips soft initial/final consonants (Greek θ,
 * φ, σ; English fricatives) and short negations, which are exactly the tokens
 * the R3 safety corpus is built from. An over-trimmed "μην" is a safety
 * failure; retained silence costs at worst a hallucinated trailing line that
 * the draft echo catches. So the bias is toward keeping audio.
 *
 * Phase 0 must sweep these across microphones and noise levels and record the
 * chosen values with the benchmark result (R7). They are deliberately loose
 * until that measurement exists.
 */
export const SILENCE_TRIM_FILTER =
  'silenceremove=start_periods=1:start_duration=0.15:start_threshold=-50dB:' +
  'stop_periods=1:stop_duration=0.6:stop_threshold=-50dB:detection=peak';

export interface NormalizeOptions {
  /** From `video.ffmpeg_path`; empty resolves from PATH/WinGet. */
  readonly ffmpegPath?: string | undefined;
  /** Off only for the Phase 0 A/B that measures the filter's cost. */
  readonly trimSilence?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Decodes and resamples `source` into a WAV owned by the same operation.
 *
 * argv is fixed and never shell-interpolated: paths come from a temp directory
 * Forge created, and `shell: false` keeps operator characters in a filename
 * inert.
 */
export async function normalizeToWav(
  operation: VoiceOperation,
  source: VoiceAudioHandle,
  options: NormalizeOptions = {},
): Promise<VoiceAudioHandle> {
  const { ffmpeg } = resolveFfmpeg(options.ffmpegPath);
  const target = operation.reserve('normalized.wav');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-i',
    source.path,
    ...(options.trimSilence === false ? [] : ['-af', SILENCE_TRIM_FILTER]),
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    target,
  ];
  await runFfmpeg(ffmpeg, args, options.signal);
  return operation.adopt(target, 'audio/wav');
}

function runFfmpeg(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { shell: false, windowsHide: true });
    let stderr = '';
    const onAbort = (): void => {
      child.kill();
      reject(new VoiceTranscriptionError('cancelled', 'audio normalization cancelled'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: a decoder failing on every frame can emit unboundedly.
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        new VoiceTranscriptionError('decode_failed', `ffmpeg failed to start: ${error.message}`),
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return;
      if (code === 0) return resolve();
      reject(
        new VoiceTranscriptionError(
          'decode_failed',
          `ffmpeg exited ${code}: ${stderr.trim() || 'no stderr'}`,
        ),
      );
    });
  });
}

/**
 * WAV -> OGG/Opus, the format Telegram plays inline as a voice message.
 *
 * `sendAudio` would accept the WAV, but it renders as a file attachment with a
 * download step; `sendVoice` requires OGG/Opus and renders as a waveform that
 * plays on tap. For a reply you are meant to just hear, that difference is the
 * whole feature.
 *
 * 24 kHz mono at 32 kbps: Piper emits 22.05 kHz mono, and Opus resamples to its
 * own internal rates regardless, so bitrate is the only real lever. 32k is
 * transparent for a single speaking voice.
 */
export async function encodeToOpus(
  operation: VoiceOperation,
  wavPath: string,
  options: { ffmpegPath?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<string> {
  const { ffmpeg } = resolveFfmpeg(options.ffmpegPath);
  const target = operation.reserve('speech.ogg');
  await runFfmpeg(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      wavPath,
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ar',
      '24000',
      '-ac',
      '1',
      target,
    ],
    options.signal,
  );
  return target;
}
