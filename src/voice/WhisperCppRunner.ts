import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import {
  VoiceTranscriptionError,
  type TranscribeOptions,
  type VoiceTranscript,
  type WhisperRunner,
} from './VoiceTypes';

/**
 * `WhisperRunner` over whisper.cpp's `whisper-cli`.
 *
 * whisper.cpp is the decided backend, and the reason is deployment rather than
 * speed: it is one .exe and one .bin, where faster-whisper's CUDA path needs a
 * `cublas64_12.dll` that its own wheel does not ship. Measured on this machine,
 * that DLL is simply absent and the engine cannot start -- a failure an end user
 * would have to fix themselves. See §6.1b.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §6.1b, §6.4, §7.
 */

export interface WhisperCppOptions {
  /** Absolute path to `whisper-cli` / `whisper-cli.exe`. */
  readonly binary: string;
  /** Absolute path to a `ggml-*.bin`. */
  readonly model: string;
  /**
   * false passes `-ng`. Undefined leaves whisper-cli's own default, which is
   * GPU on for a CUDA build -- so this is about pinning placement, not enabling
   * acceleration that was otherwise off.
   */
  readonly useGpu?: boolean | undefined;
  /** `-dev N`. A CUDA ordinal, which is not necessarily nvidia-smi's ordering. */
  readonly gpuDevice?: number | undefined;
  /** `-t N`. */
  readonly threads?: number | undefined;
  /** `-bs N`. */
  readonly beamSize?: number | undefined;
  /** `-fa` / `-nfa`. Passed either way rather than relying on the CLI default,
   *  which has flipped between builds. */
  readonly flashAttn?: boolean | undefined;
  /** Hard ceiling on one transcription. A hung child must not hang a turn. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Builds whisper-cli's argv.
 *
 * Split out and exported so the flag mapping is testable without spawning a
 * 3 GB model: a wrong `-dev` is invisible in a transcript -- the text comes back
 * correct off whichever card ran it -- so the argv is the only thing that can be
 * asserted on.
 *
 * Every knob is omitted when unset. Passing whisper-cli's documented default
 * back to it would look harmless but silently pins a value the next build may
 * have moved.
 */
export function buildWhisperArgs(
  options: WhisperCppOptions,
  wavPath: string,
  transcribe: TranscribeOptions,
): string[] {
  const args = [
    '-m',
    options.model,
    '-f',
    wavPath,
    '-l',
    transcribe.language || 'auto',
    '-np',
    '-nt',
  ];
  if (options.useGpu === false) args.push('-ng');
  // Only meaningful with the GPU in play; `-dev` alongside `-ng` is contradictory
  // enough to be worth not emitting rather than letting the CLI pick a winner.
  else if (options.gpuDevice !== undefined) args.push('-dev', String(options.gpuDevice));
  if (options.threads !== undefined) args.push('-t', String(options.threads));
  if (options.beamSize !== undefined) args.push('-bs', String(options.beamSize));
  if (options.flashAttn !== undefined) args.push(options.flashAttn ? '-fa' : '-nfa');
  // §6.4 decoder bias. whisper.cpp caps the initial prompt at the first
  // 224 tokens of context; a longer string is silently truncated, so keep it
  // to a vocabulary list rather than an instruction.
  if (transcribe.initialPrompt) args.push('--prompt', transcribe.initialPrompt);
  return args;
}

/**
 * Cold-start floor measured at ~4.2 s (§6.1b), so the default has to clear model
 * load plus a long utterance with room to spare. It exists to catch a wedged
 * process, not to enforce a latency target.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

export class WhisperCppRunner implements WhisperRunner {
  constructor(private readonly options: WhisperCppOptions) {}

  /**
   * whisper-cli writes the transcript to stdout under `-nt` (no timestamps) and
   * `-np` (no progress prints). stdout is read rather than an `-otxt` artifact
   * because there is then no file to own, race on, or fail to delete -- and the
   * §7 admission rule's "read the artifact only after exit" condition is
   * satisfied for free by awaiting `close`.
   */
  async transcribe(wavPath: string, options: TranscribeOptions): Promise<VoiceTranscript> {
    await this.assertReadable(this.options.binary, 'whisper binary (voice.whisper_binary)');
    await this.assertReadable(this.options.model, 'whisper model (voice.whisper_model)');

    const args = buildWhisperArgs(this.options, wavPath, options);

    const started = Date.now();
    const stdout = await this.run(args, options.signal);
    return {
      text: stdout,
      transcribeMs: Date.now() - started,
      backend: 'whisper.cpp',
      model: this.options.model,
      // Derived from the flag actually sent, not configured separately: the
      // audit row's job is to say what ran, and two sources for that guarantee
      // they disagree eventually.
      device: this.options.useGpu === false ? 'cpu' : 'gpu',
      biasPromptUsed: Boolean(options.initialPrompt),
    };
  }

  /**
   * A missing binary or model is the single most likely misconfiguration, and
   * whisper-cli's own error for it is a bare non-zero exit. Checking first turns
   * that into a message naming the config key the user has to fix.
   */
  private async assertReadable(target: string, label: string): Promise<void> {
    try {
      await fs.access(target);
    } catch {
      throw new VoiceTranscriptionError('stt_failed', `${label} not found: ${target}`);
    }
  }

  private run(args: string[], signal: AbortSignal | undefined): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binary, args, { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => {
        child.kill();
        finish(() => reject(new VoiceTranscriptionError('cancelled', 'transcription cancelled')));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() =>
          reject(
            new VoiceTranscriptionError(
              'stt_failed',
              `whisper-cli exceeded ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`,
            ),
          ),
        );
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Bounded: whisper-cli prints per-segment diagnostics on some builds.
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        finish(() =>
          reject(
            new VoiceTranscriptionError(
              'stt_failed',
              `whisper-cli failed to start: ${error.message}`,
            ),
          ),
        );
      });
      child.on('close', (code) => {
        // Condition 1 of the admission rule: a non-zero exit is never a
        // transcript, however much text arrived on stdout before it.
        if (code !== 0) {
          return finish(() =>
            reject(
              new VoiceTranscriptionError(
                'stt_failed',
                `whisper-cli exited ${code}: ${stderr.trim() || 'no stderr'}`,
              ),
            ),
          );
        }
        // Segments arrive one per line; the utterance is their concatenation.
        finish(() =>
          resolve(
            stdout
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .join(' '),
          ),
        );
      });
    });
  }
}
