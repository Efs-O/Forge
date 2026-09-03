import { normalizeToWav, type NormalizeOptions } from './AudioNormalizer';
import { acceptTranscript } from './TranscriptAcceptance';
import { VoiceAuditLog } from './VoiceAudit';
import type { VoiceOperation } from './VoiceOperation';
import {
  VoiceTranscriptionError,
  type VoiceAudioHandle,
  type VoiceRejectionReason,
  type VoiceSurface,
  type VoiceTranscript,
  type WhisperRunner,
} from './VoiceTypes';

/**
 * Audio in, transcript out: the one cancellable unit between a recorded
 * utterance and the existing prompt-admission path.
 *
 * The entry point takes a FILE PATH, never a microphone handle, a Telegram
 * file_id or a network stream -- those belong to the callers above it. That one
 * constraint is what makes the whole path testable from a WAV fixture, and
 * with `FakeWhisperRunner` testable with no model, GPU or network at all.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §5, §7, §20.1.
 */

export interface VoiceIngressOptions {
  readonly surface: VoiceSurface;
  readonly language: string;
  readonly initialPrompt?: string | undefined;
  readonly audioMs?: number | undefined;
  readonly normalize?: NormalizeOptions | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type IngressResult =
  | { ok: true; text: string; transcript: VoiceTranscript }
  | { ok: false; reason: VoiceRejectionReason; detail: string };

export class VoiceIngress {
  constructor(
    private readonly runner: WhisperRunner,
    private readonly audit: VoiceAuditLog,
  ) {}

  /**
   * Runs normalize -> transcribe -> admission-rule for one operation.
   *
   * The operation is disposed before this returns on EVERY path. Audio dies
   * here, which is what lets `PendingVoiceDraft` be incapable of extending its
   * lifetime (R8): by the time a draft exists there is nothing left to retain.
   *
   * Emits `started`, and on failure the `rejected` terminal row.
   *
   * It does NOT emit `admitted`: `auto_submitted` and `edited_before_submit`
   * are only known once the draft resolves (§9.6), which happens after ingress
   * has returned and disposed. So the one-terminal-row invariant spans ingress
   * and the draft: a successful ingress whose draft later expires terminates as
   * `draft_expired`, and the caller owns that row. `VoiceAuditLog` enforces the
   * invariant across both halves.
   */
  async run(
    operation: VoiceOperation,
    source: VoiceAudioHandle,
    options: VoiceIngressOptions,
  ): Promise<IngressResult> {
    this.audit.started({
      operation_id: operation.id,
      surface: options.surface,
      audio_ms: options.audioMs,
      bytes: source.bytes,
      media_type: source.mediaType,
    });
    try {
      return await this.transcribe(operation, source, options);
    } finally {
      // Before any draft is constructed, and before the caller sees the text.
      await operation.dispose();
    }
  }

  private async transcribe(
    operation: VoiceOperation,
    source: VoiceAudioHandle,
    options: VoiceIngressOptions,
  ): Promise<IngressResult> {
    let transcript: VoiceTranscript;
    try {
      const wav = await normalizeToWav(operation, source, {
        ...options.normalize,
        signal: options.signal,
      });
      transcript = await this.runner.transcribe(wav.path, {
        language: options.language,
        initialPrompt: options.initialPrompt,
        signal: options.signal,
      });
    } catch (error) {
      return this.reject(operation.id, reasonOf(error), detailOf(error));
    }
    // Conditions 3-5 of the admission rule. Exit status and read-after-exit
    // (1, 2) are the runner's; cancellation (6) surfaced as a throw above.
    const accepted = acceptTranscript(transcript.text);
    if (!accepted.ok) {
      return this.reject(operation.id, accepted.reason, accepted.detail, transcript);
    }
    return { ok: true, text: accepted.text, transcript };
  }

  private reject(
    operationId: string,
    reason: VoiceRejectionReason,
    detail: string,
    transcript?: VoiceTranscript | undefined,
  ): IngressResult {
    this.audit.rejected({
      operation_id: operationId,
      reason,
      detail,
      backend: transcript?.backend,
      transcribe_ms: transcript?.transcribeMs,
    });
    return { ok: false, reason, detail };
  }
}

function reasonOf(error: unknown): VoiceRejectionReason {
  return error instanceof VoiceTranscriptionError ? error.reason : 'stt_failed';
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
