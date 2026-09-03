import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { VoiceOperation } from './VoiceOperation';

/**
 * Text -> a WAV file, via one Piper process per utterance.
 *
 * One-shot rather than resident, decided by measurement rather than by default:
 * a short reply synthesizes in 611-1995 ms on this machine (2026-09-03), which
 * is inside the latency §11.3 set as the threshold for keeping a process alive.
 * Piper is small and CPU-side, so if that changes a resident server is allowed
 * here in a way it is not for Whisper -- it competes for nothing the chat model
 * needs.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §11.
 */

export class PiperSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiperSynthesisError';
  }
}

export interface PiperOptions {
  /** `piper` / `piper.exe`. */
  readonly binary: string;
  /** Directory holding `<voice>.onnx` and its `.json` sidecar. */
  readonly voicesDir: string;
  /** Hard ceiling on one synthesis; a wedged child must not hang delivery. */
  readonly timeoutMs?: number | undefined;
}

/** Comfortably past the measured worst case, tight enough to notice a hang. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class PiperRunner {
  constructor(private readonly options: PiperOptions) {}

  /**
   * Synthesizes `text` into a WAV owned by `operation`.
   *
   * Text goes in over stdin, never as an argv element: a reply can be hundreds
   * of characters and contain anything at all, and Windows argv limits and
   * quoting rules are not a place to discover that.
   */
  async synthesize(operation: VoiceOperation, text: string, voice: string): Promise<string> {
    const model = path.join(this.options.voicesDir, `${voice}.onnx`);
    try {
      await fs.access(model);
    } catch {
      throw new PiperSynthesisError(`Piper voice not found: ${model}`);
    }
    const target = operation.reserve(`speech-${voice}.wav`);
    await this.run(['--model', model, '--output_file', target], text);
    return target;
  }

  private run(args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binary, args, { shell: false, windowsHide: true });
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new PiperSynthesisError('piper timed out')));
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) =>
        finish(() => reject(new PiperSynthesisError(`piper failed to start: ${error.message}`))),
      );
      child.on('close', (code) =>
        finish(() =>
          code === 0
            ? resolve()
            : reject(
                new PiperSynthesisError(`piper exited ${code}: ${stderr.trim() || 'no stderr'}`),
              ),
        ),
      );
      // EPIPE if the child died before reading stdin; the close handler above
      // already owns that failure, so this must not raise a second one.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input, 'utf8');
    });
  }
}
