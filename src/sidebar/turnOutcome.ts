/** Machine-readable completion state for one provider turn. */
export type ForgeTurnOutcome =
  | {
      kind: 'completed';
      finalText: string;
      finishReason: string | null;
      /** The provider returned, but Forge knows the request still needs work. */
      incompleteReason?: string;
    }
  | { kind: 'failed'; error: string; finalText: string }
  | { kind: 'cancelled'; finalText: string }
  | { kind: 'interrupted'; finalText: string };

/** The complete logical request, including any future compact/resume rounds. */
export type ForgeRequestOutcome =
  | { kind: 'completed'; finalText: string }
  | { kind: 'failed'; error: string; finalText?: string }
  | { kind: 'cancelled'; finalText?: string; incompleteReason?: string }
  | { kind: 'interrupted'; finalText?: string; incompleteReason?: string };

export function toRequestOutcome(turn: ForgeTurnOutcome): ForgeRequestOutcome {
  switch (turn.kind) {
    case 'completed':
      return { kind: 'completed', finalText: turn.finalText };
    case 'failed':
      return {
        kind: 'failed',
        error: turn.error,
        ...(turn.finalText ? { finalText: turn.finalText } : {}),
      };
    case 'cancelled':
    case 'interrupted':
      return {
        kind: turn.kind,
        ...(turn.finalText ? { finalText: turn.finalText } : {}),
      };
  }
}

export function abortedTurnOutcome(
  kind: 'cancelled' | 'interrupted' | undefined,
  finalText = '',
): ForgeTurnOutcome {
  return kind === 'interrupted'
    ? { kind: 'interrupted', finalText }
    : { kind: 'cancelled', finalText };
}
