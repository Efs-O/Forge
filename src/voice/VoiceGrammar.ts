/**
 * The closed spoken-command grammar and the correlation rule that decides when
 * a matched word may actually authorize something.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §8A, §22A R1-revised.
 */

export type VoiceCommand = 'approve' | 'deny' | 'stop' | 'status';

/**
 * Whole utterances only, English and Greek. Deliberately tiny: closed
 * vocabulary is the easiest thing an STT system does, and every entry added
 * here is a new way to authorize something by accident.
 */
const GRAMMAR: ReadonlyArray<readonly [VoiceCommand, readonly string[]]> = [
  ['approve', ['approve', 'yes', 'ok', 'εγκρίνω', 'ναι', 'εντάξει']],
  ['deny', ['deny', 'no', 'reject', 'απόρριψη', 'όχι']],
  ['stop', ['stop', 'cancel', 'abort', 'σταμάτα', 'ακύρωση']],
  ['status', ['status', 'κατάσταση']],
];

/**
 * Case, trailing punctuation, and Greek diacritics.
 *
 * Diacritic folding is not cosmetic: uppercase Greek is written without
 * accents, so `ΕΝΤΑΞΕΙ`.toLowerCase() is `ενταξει`, which never equals
 * `εντάξει`. Whisper emits Greek both ways depending on casing and confidence,
 * and a user saying "εντάξει" would otherwise be matched or missed at random.
 * Stripping combining marks could merge two distinct words in a large
 * vocabulary; across these six entries it cannot, and the alternative is a
 * grammar that silently fails half the time.
 *
 * Trailing punctuation only -- whisper ends most utterances with a period, so
 * literal equality would never match. Stripping more would start matching
 * phrases, which is the failure this whole module exists to prevent.
 */
function normalizeUtterance(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[.!;:,·]+$/u, '')
    .trim();
}

/**
 * Matches the WHOLE utterance or nothing.
 *
 * Never a substring, prefix, or fuzzy match. "Do not approve that" must not
 * match `approve` -- this is the substring-guard trap from CLAUDE.md, and it is
 * more dangerous here than anywhere else in the codebase because a false match
 * takes an action rather than refusing one.
 */
export function matchVoiceCommand(text: string): VoiceCommand | undefined {
  const probe = normalizeUtterance(text);
  if (!probe) return undefined;
  for (const [command, words] of GRAMMAR) {
    if (words.some((word) => normalizeUtterance(word) === probe)) return command;
  }
  return undefined;
}

/** A gate a spoken command could resolve, with the window it has been open for. */
export interface PendingGate {
  readonly id: string;
  readonly chatId: string;
  /** When the gate opened. */
  readonly openedAt: number;
  /** Set once resolved, so a gate that closed mid-recording is detectable. */
  readonly resolvedAt?: number;
}

export type CorrelationResult =
  | { kind: 'resolve'; gate: PendingGate }
  | { kind: 'refuse'; reason: 'none-open' | 'ambiguous' }
  | { kind: 'not-a-command' };

/**
 * The recording window an utterance was spoken into, derived from Telegram's
 * send timestamp and the client-reported clip duration.
 *
 * This is a RACE-CONDITION GUARD, NOT A SECURITY BOUNDARY. `date` is Telegram's
 * clock and `durationMs` is client-reported; neither is trustworthy against an
 * adversary. That is acceptable only because the sender is already
 * owner-authenticated and TOTP-gated well before this point. What it prevents is
 * a late "approve" landing on a request the user never saw -- not a forged one.
 * Do not let it drift into carrying authentication weight.
 */
export interface RecordingWindow {
  readonly startedAt: number;
  readonly endedAt: number;
}

export function recordingWindow(sentAtMs: number, durationMs: number): RecordingWindow {
  return { startedAt: sentAtMs - Math.max(0, durationMs), endedAt: sentAtMs };
}

/**
 * Decides whether a spoken approve/deny/stop may resolve a gate.
 *
 * The button path in `RemoteApprovalBridge.resolveAction()` correlates three
 * ways -- actionId, chatId and a nonce -- and refuses on any mismatch. A spoken
 * word carries none of them, and `approvals` is a Map, so several gates can be
 * open at once. Requiring an explicit reply would restore correlation but
 * remove the hands-free property that justifies spoken commands at all: the
 * user would already be holding the phone with the message on screen, where the
 * inline button is one tap.
 *
 * So: resolve only when exactly ONE gate was open for the entire recording
 * window and is still unresolved. Anything ambiguous refuses and asks for a
 * reply or a tap, which is where strictness belongs.
 *
 * @param replyToGateId An explicit reply always wins over the timing heuristic.
 */
export function correlateGate(
  gates: readonly PendingGate[],
  chatId: string,
  window: RecordingWindow,
  replyToGateId?: string,
): CorrelationResult {
  const mine = gates.filter((gate) => gate.chatId === chatId);
  if (replyToGateId) {
    const explicit = mine.find(
      (gate) => gate.id === replyToGateId && gate.resolvedAt === undefined,
    );
    return explicit ? { kind: 'resolve', gate: explicit } : { kind: 'refuse', reason: 'none-open' };
  }
  const spanning = mine.filter(
    (gate) => gate.openedAt <= window.startedAt && gate.resolvedAt === undefined,
  );
  // A gate that opened or closed inside the window is precisely the race this
  // guards: the user cannot have been speaking about it for the whole clip.
  const disturbed = mine.some(
    (gate) =>
      (gate.openedAt > window.startedAt && gate.openedAt <= window.endedAt) ||
      (gate.resolvedAt !== undefined &&
        gate.resolvedAt >= window.startedAt &&
        gate.resolvedAt <= window.endedAt),
  );
  if (spanning.length === 0) return { kind: 'refuse', reason: 'none-open' };
  if (spanning.length > 1 || disturbed) return { kind: 'refuse', reason: 'ambiguous' };
  return { kind: 'resolve', gate: spanning[0] };
}
