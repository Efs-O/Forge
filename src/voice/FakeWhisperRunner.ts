import {
  VoiceTranscriptionError,
  type TranscribeOptions,
  type VoiceTranscript,
  type WhisperRunner,
} from './VoiceTypes';

/**
 * Tier A test double for `WhisperRunner`.
 *
 * This exists so the deterministic half of the voice path -- operation
 * ownership, the draft machine, dedup, auditing, auth invalidation,
 * cancellation and temp-file cleanup -- is testable with no model, no Python,
 * no CUDA, no ffmpeg and no network. A checked-in WAV fixture cannot do that:
 * either backend needs a multi-gigabyte model that has no business in
 * `npm run ci`.
 *
 * It replays the failure shapes as well as the happy path, because those are
 * what the state machine actually has to survive.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §24 (Tier A), R4.
 */
export type FakeOutcome =
  | { kind: 'text'; text: string; languageDetected?: string }
  /** Non-zero exit / unreadable artifact. */
  | { kind: 'fail'; message: string }
  /** Process died mid-run, e.g. a killed child. */
  | { kind: 'cancel' }
  /** Resolves only when `signal` aborts, to exercise cancellation races. */
  | { kind: 'hang' };

export class FakeWhisperRunner implements WhisperRunner {
  /** Every call in order, so tests can assert bias-prompt and language wiring. */
  readonly calls: Array<{ wavPath: string; options: TranscribeOptions }> = [];
  private readonly queue: FakeOutcome[] = [];

  constructor(
    private readonly fallback: FakeOutcome = { kind: 'text', text: 'restart the backend' },
    private readonly transcribeMs = 42,
  ) {}

  /** Queues one outcome per upcoming call; exhausted, it uses the fallback. */
  enqueue(...outcomes: FakeOutcome[]): this {
    this.queue.push(...outcomes);
    return this;
  }

  async transcribe(wavPath: string, options: TranscribeOptions): Promise<VoiceTranscript> {
    this.calls.push({ wavPath, options });
    const outcome = this.queue.shift() ?? this.fallback;
    if (options.signal?.aborted) {
      throw new VoiceTranscriptionError('cancelled', 'aborted before transcription started');
    }
    switch (outcome.kind) {
      case 'fail':
        throw new VoiceTranscriptionError('stt_failed', outcome.message);
      case 'cancel':
        throw new VoiceTranscriptionError('cancelled', 'transcription cancelled');
      case 'hang':
        return await this.untilAborted(options.signal);
      case 'text':
        return {
          text: outcome.text,
          languageDetected: outcome.languageDetected ?? 'en',
          transcribeMs: this.transcribeMs,
          backend: 'fake',
          model: 'fake',
          device: 'cpu',
          biasPromptUsed: Boolean(options.initialPrompt),
        };
    }
  }

  private untilAborted(signal: AbortSignal | undefined): Promise<never> {
    return new Promise((_resolve, reject) => {
      const fail = (): void =>
        reject(new VoiceTranscriptionError('cancelled', 'transcription cancelled'));
      if (!signal) return; // Deliberately never settles: an un-cancellable hang.
      if (signal.aborted) return fail();
      signal.addEventListener('abort', fail, { once: true });
    });
  }
}
