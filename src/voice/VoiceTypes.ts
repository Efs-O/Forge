/**
 * Voice transport types. Voice is I/O around the existing agent loop, never a
 * second agent mode: audio becomes ordinary UTF-8 user text and then follows
 * every gate typed input follows.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §5, §9.2, §20.1.
 */

/** Where an utterance came from. Recorded on every audit row (§20.1). */
export type VoiceSurface = 'telegram' | 'sidebar' | 'command';

/**
 * Why an operation produced no prompt. One of these is the `reason` on
 * `voice_ingress_rejected`; the set is closed so failure rates can be counted
 * per cause without parsing prose.
 */
export type VoiceRejectionReason =
  | 'oversize'
  | 'too_long'
  | 'decode_failed'
  | 'stt_failed'
  | 'empty'
  | 'refusal'
  | 'echo'
  | 'cancelled'
  | 'draft_expired';

/**
 * A bounded temp audio file owned by one voice operation.
 *
 * Audio never becomes a string (§9.2): base64 inflation and the 14 MB
 * `RemoteInboundAttachmentSchema.data` cap both stop applying, and ffmpeg and
 * the STT runner want a path anyway -- an encoded payload would be written back
 * out to a temp file two steps later regardless.
 */
export interface VoiceAudioHandle {
  /** Absolute path to a temp file outside the workspace. */
  readonly path: string;
  /** Size on disk, already checked against `voice.input.max_bytes`. */
  readonly bytes: number;
  readonly mediaType: string;
  /** Owning operation. Cleanup is keyed to it, never to a stray `finally`. */
  readonly operationId: string;
}

/** What the STT process produced, before the admission rule runs. */
export interface VoiceTranscript {
  readonly text: string;
  readonly languageDetected?: string | undefined;
  readonly transcribeMs: number;
  readonly backend: string;
  readonly model: string;
  readonly device: 'cpu' | 'gpu';
  /** Whether a §6.4 decoding-bias prompt was supplied for this call. */
  readonly biasPromptUsed: boolean;
}

/**
 * Spawn an STT process, hand it a WAV path, get a transcript, observe exit.
 *
 * Written against that shape and never against one engine's argv, so selecting
 * a backend in Phase 0 does not touch ingress, normalization, the draft machine
 * or the audit events (§6.1). The Tier A fake implements this interface, which
 * is why the whole state path is testable with no model, GPU or network (§24).
 */
export interface WhisperRunner {
  /**
   * @param wavPath 16 kHz mono s16 WAV. Callers normalize first (§10).
   * @throws {VoiceTranscriptionError} on non-zero exit or unreadable output.
   */
  transcribe(wavPath: string, options: TranscribeOptions): Promise<VoiceTranscript>;
}

export interface TranscribeOptions {
  /** `auto`, or an explicit ISO code for troubleshooting (§16). */
  readonly language: string;
  /** §6.4 decoding bias. Empty disables it. */
  readonly initialPrompt?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The STT process failed or was cancelled. Typed rather than a bare Error so
 * ingress can map it to a closed `VoiceRejectionReason` instead of sniffing a
 * message string.
 */
export class VoiceTranscriptionError extends Error {
  constructor(
    readonly reason: Extract<VoiceRejectionReason, 'stt_failed' | 'decode_failed' | 'cancelled'>,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}
