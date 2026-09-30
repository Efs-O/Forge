import { formatAthensDateTime, parseResult } from './agentTaskPrompt';

/** The parsed outcome of an agent turn's final message. */
export interface AgentTaskOutcome {
  /** ok | no_change | failed | timeout. */
  kind: 'ok' | 'no_change' | 'failed' | 'timeout';
  /** The RESULT sentence (after the `RESULT:` line), or a fallback. */
  sentence: string;
  /** Whether the final message asked for a backend restart. */
  restart: boolean;
  /** The final assistant text of the turn. */
  finalText: string;
}

/**
 * Step 8: map a request outcome + timeout flag to the report outcome. A cap
 * hit is always a timeout; a failed/cancelled/interrupted turn is a failure;
 * otherwise the RESULT line in the final text decides (ok / no_change).
 */
export function outcomeOf(
  result:
    | { kind: 'completed'; finalText: string }
    | { kind: 'failed'; error: string; finalText?: string }
    | { kind: 'cancelled'; finalText?: string }
    | { kind: 'interrupted'; finalText?: string },
  timedOut: boolean,
): AgentTaskOutcome {
  const finalText = result.finalText ?? '';
  if (timedOut)
    return {
      kind: 'timeout',
      sentence: 'timed out after the max_minutes cap',
      restart: false,
      finalText,
    };
  if (result.kind === 'failed') {
    return { kind: 'failed', sentence: result.error, restart: false, finalText };
  }
  if (result.kind === 'cancelled' || result.kind === 'interrupted') {
    return { kind: 'failed', sentence: `the turn was ${result.kind}`, restart: false, finalText };
  }
  const parsed = parseResult(finalText);
  return {
    kind: parsed.kind,
    sentence: parsed.sentence,
    restart: parsed.restart,
    finalText,
  };
}

/** Build the human report for a finished agent-task run. */
export function reportMessage(
  outcome: AgentTaskOutcome,
  startedAt: number,
  durationMs: number,
  conversationId: string | null,
): string {
  const tail = outcome.finalText.slice(-800);
  return (
    `Date/time (Europe/Athens, 24-hour): ${formatAthensDateTime(startedAt)}\n` +
    `${outcome.kind}: ${outcome.sentence} ` +
    `(${formatDuration(durationMs)})` +
    (conversationId ? ` — conversation ${conversationId}` : '') +
    (tail ? `\n\n${tail}` : '')
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
