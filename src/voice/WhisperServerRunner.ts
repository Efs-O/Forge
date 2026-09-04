import { readFile } from 'fs/promises';
import * as path from 'path';
import {
  VoiceTranscriptionError,
  type TranscribeOptions,
  type VoiceTranscript,
  type WhisperRunner,
} from './VoiceTypes';

export interface WhisperServerRunnerOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly useGpu?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** HTTP transcription client for a Forge-owned whisper-server process. */
export class WhisperServerRunner implements WhisperRunner {
  constructor(private readonly options: WhisperServerRunnerOptions) {}

  async transcribe(wavPath: string, options: TranscribeOptions): Promise<VoiceTranscript> {
    const started = Date.now();
    const requestAbort = new AbortController();
    let timedOut = false;
    const onAbort = (): void => requestAbort.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      requestAbort.abort();
    }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      if (options.signal?.aborted) requestAbort.abort();
      const bytes = await readFile(wavPath);
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(wavPath));
      form.append('response_format', 'text');
      // whisper-server defaults to English, unlike Forge's `auto` default.
      // Always send the selected language so multilingual detection survives
      // the switch from CLI to resident mode.
      form.append('language', options.language || 'auto');
      if (options.initialPrompt) form.append('prompt', options.initialPrompt);

      const response = await (this.options.fetchFn ?? fetch)(`${this.options.baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: requestAbort.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 4096).trim();
        throw new VoiceTranscriptionError(
          'stt_failed',
          `whisper-server HTTP ${response.status}: ${detail || response.statusText}`,
        );
      }
      return {
        text: await response.text(),
        transcribeMs: Date.now() - started,
        backend: 'whisper.cpp server',
        model: this.options.model,
        device: this.options.useGpu === false ? 'cpu' : 'gpu',
        biasPromptUsed: Boolean(options.initialPrompt),
      };
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) throw error;
      if (timedOut) {
        throw new VoiceTranscriptionError(
          'stt_failed',
          `whisper-server exceeded ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`,
        );
      }
      if (options.signal?.aborted || isAbortError(error)) {
        throw new VoiceTranscriptionError('cancelled', 'transcription cancelled');
      }
      throw new VoiceTranscriptionError(
        'stt_failed',
        `whisper-server request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
