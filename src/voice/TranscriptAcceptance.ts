import type { VoiceRejectionReason } from './VoiceTypes';

/**
 * The admission rule: whether a transcript may become a user prompt.
 *
 * "Never admit a partial transcript" is not testable as prose, so it is six
 * explicit conditions here. Note what this deliberately does NOT promise:
 * audio that cut off mid-sentence transcribes cleanly and exits 0, and neither
 * whisper.cpp nor faster-whisper exposes a signal for it. The draft echo (§9.5)
 * is the real mitigation for that case -- the user sees it end mid-thought.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §7, §27.2.
 */

/**
 * Marker tokens backends emit for non-speech audio. Stripped before the
 * emptiness check, or a note of pure silence reads as a real prompt.
 */
const MARKER_TOKENS = [
  '[BLANK_AUDIO]',
  '[SILENCE]',
  '[MUSIC]',
  '[music]',
  '[NOISE]',
  '(silence)',
  '[INAUDIBLE]',
];

/**
 * Phrases a transcription model produces INSTEAD of transcribing. Ported from
 * Gemma4kids `src/shared/transcription.ts` (§27.2).
 *
 * whisper.cpp is not instruction-following and rarely does this, but the
 * check costs nothing and the failure it prevents is severe: admitting
 * "I cannot transcribe this audio" as a user prompt is the `ask_user`
 * `(cancelled)` bug again -- a tool that lies costs more than one that fails.
 */
const REFUSAL_PATTERNS = [
  /^i (?:can(?:no|')t|am unable to|cannot) (?:transcribe|hear|make out|understand)/i,
  /^(?:there is |there's )?no (?:audible )?(?:speech|audio|sound)\b/i,
  /^(?:sorry|unfortunately)[,.]? (?:i )?(?:can(?:no|')t|cannot|am unable)/i,
  /^(?:the )?audio (?:is |was )?(?:empty|silent|unintelligible|inaudible)\b/i,
  /^δεν (?:μπορώ να )?(?:ακούω|καταλαβαίνω|μεταγράψω)/i,
];

/**
 * Instruction-tuned backends echo their own prompt back before the transcript.
 * Only leading echoes are stripped: the same words appearing mid-sentence are
 * the user's, not the model's.
 */
const ECHO_PREFIXES = [
  /^transcribe the following audio[:.]?\s*/i,
  /^(?:here is|this is) the transcription[:.]?\s*/i,
  /^transcription[:.]\s*/i,
  /^output only the transcription text[^:]*[:.]?\s*/i,
];

export function stripMarkers(text: string): string {
  let out = text;
  for (const marker of MARKER_TOKENS) out = out.split(marker).join(' ');
  return out.replace(/\s+/g, ' ').trim();
}

export function stripPromptEcho(text: string): string {
  let out = text.trim();
  for (const pattern of ECHO_PREFIXES) out = out.replace(pattern, '');
  return out.trim();
}

export function looksLikeTranscriptionRefusal(text: string): boolean {
  const probe = text.trim();
  // A refusal is the whole output. Long text that merely opens this way is a
  // user dictating a sentence about not being able to hear something.
  if (probe.length > 200) return false;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(probe));
}

export type AcceptanceResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: Extract<VoiceRejectionReason, 'empty' | 'refusal' | 'echo'>;
      detail: string;
    };

/**
 * Applies conditions 3-5 of the admission rule to a transcript whose process
 * already exited 0 and whose artifact was read in full after exit.
 *
 * Conditions 1, 2 and 6 (exit status, read-after-exit, cancellation) belong to
 * the runner and ingress -- they are about the process, not the text.
 */
export function acceptTranscript(raw: string): AcceptanceResult {
  const echoStripped = stripPromptEcho(raw);
  if (echoStripped.length === 0) {
    return { ok: false, reason: 'echo', detail: 'transcript was prompt echo only' };
  }
  if (looksLikeTranscriptionRefusal(echoStripped)) {
    return {
      ok: false,
      reason: 'refusal',
      detail: `looksLikeTranscriptionRefusal matched: ${echoStripped.slice(0, 120)}`,
    };
  }
  const normalized = stripMarkers(echoStripped);
  if (normalized.length === 0) {
    return { ok: false, reason: 'empty', detail: 'transcript was silence markers only' };
  }
  return { ok: true, text: normalized };
}
