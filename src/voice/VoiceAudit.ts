import type { VoiceRejectionReason, VoiceSurface, VoiceTranscript } from './VoiceTypes';

/**
 * Three session-log rows per voice operation, sharing one `operation_id`.
 *
 * Fields on the user turn were not enough: a rejected voice note produces no
 * user turn to hang them on, and that is the case most worth finding later. The
 * user's real input is audio Forge deliberately does not retain, so if this is
 * not written the origin of a voice turn is gone the moment it completes.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §20.1.
 */

export interface VoiceIngressStarted {
  type: 'voice_ingress_started';
  operation_id: string;
  ts_ms: number;
  surface: VoiceSurface;
  audio_ms?: number | undefined;
  bytes: number;
  media_type: string;
}

export interface VoiceIngressRejected {
  type: 'voice_ingress_rejected';
  operation_id: string;
  ts_ms: number;
  reason: VoiceRejectionReason;
  detail?: string | undefined;
  backend?: string | undefined;
  transcribe_ms?: number | undefined;
}

export interface VoicePromptAdmitted {
  type: 'voice_prompt_admitted';
  operation_id: string;
  ts_ms: number;
  backend: string;
  model: string;
  device: 'cpu' | 'gpu';
  language_detected?: string | undefined;
  audio_ms?: number | undefined;
  transcribe_ms: number;
  bias_prompt_used: boolean;
  auto_submitted: boolean;
  /**
   * Did the user change the transcript before sending (§9.6)? A free,
   * continuous measurement of real-world STT accuracy from ordinary use -- the
   * field that says whether a bias prompt or a backend swap actually helped.
   */
  edited_before_submit: boolean;
  /** The §8A grammar entry this utterance matched, or null for a prompt. */
  grammar_match: string | null;
}

export type VoiceAuditEvent = VoiceIngressStarted | VoiceIngressRejected | VoicePromptAdmitted;

/** Where audit rows go. Kept narrow so tests can assert on them directly. */
export interface VoiceAuditSink {
  write(event: VoiceAuditEvent): void;
}

/**
 * Emits the three rows and enforces the invariant that makes them countable:
 * exactly one terminal row per operation, never both, never neither.
 *
 * An operation with a `started` row and no terminal row is itself a bug worth
 * detecting, so a double-terminal attempt throws rather than silently writing a
 * second row that would inflate every later count.
 */
export class VoiceAuditLog {
  private readonly terminated = new Set<string>();

  constructor(
    private readonly sink: VoiceAuditSink,
    private readonly now: () => number = Date.now,
  ) {}

  started(event: Omit<VoiceIngressStarted, 'type' | 'ts_ms'>): void {
    this.sink.write({ type: 'voice_ingress_started', ts_ms: this.now(), ...event });
  }

  rejected(event: Omit<VoiceIngressRejected, 'type' | 'ts_ms'>): void {
    this.markTerminal(event.operation_id);
    this.sink.write({ type: 'voice_ingress_rejected', ts_ms: this.now(), ...event });
  }

  admitted(event: Omit<VoicePromptAdmitted, 'type' | 'ts_ms'>): void {
    this.markTerminal(event.operation_id);
    this.sink.write({ type: 'voice_prompt_admitted', ts_ms: this.now(), ...event });
  }

  /** True once a terminal row exists, so ingress can skip a redundant reject. */
  isTerminal(operationId: string): boolean {
    return this.terminated.has(operationId);
  }

  private markTerminal(operationId: string): void {
    if (this.terminated.has(operationId)) {
      throw new Error(`voice operation ${operationId} already has a terminal audit row`);
    }
    this.terminated.add(operationId);
  }
}

/** Builds the admitted row from a transcript, keeping field names in one place. */
export function admittedFrom(
  operationId: string,
  transcript: VoiceTranscript,
  extras: {
    audioMs?: number | undefined;
    autoSubmitted: boolean;
    editedBeforeSubmit: boolean;
    grammarMatch: string | null;
  },
): Omit<VoicePromptAdmitted, 'type' | 'ts_ms'> {
  return {
    operation_id: operationId,
    backend: transcript.backend,
    model: transcript.model,
    device: transcript.device,
    language_detected: transcript.languageDetected,
    audio_ms: extras.audioMs,
    transcribe_ms: transcript.transcribeMs,
    bias_prompt_used: transcript.biasPromptUsed,
    auto_submitted: extras.autoSubmitted,
    edited_before_submit: extras.editedBeforeSubmit,
    grammar_match: extras.grammarMatch,
  };
}
