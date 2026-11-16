import { formatAthensDateTime, parseResult } from './agentTaskPrompt';

/**
 * The two sentences a stopped turn reports, exported so the resumed-run
 * reconciler (`resumedRun.ts`) matches the row it was written from instead of
 * retyping the string and drifting from it.
 */
export const CANCELLED_TURN_ERROR = 'the turn was cancelled';
export const INTERRUPTED_TURN_ERROR = 'the turn was interrupted';

/** The parsed outcome of an agent turn's final message. */
export interface AgentTaskOutcome {
  /** ok | no_change | skipped | failed | timeout. */
  kind: 'ok' | 'no_change' | 'skipped' | 'failed' | 'timeout';
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
 * otherwise the RESULT line in the final text decides; `parseResult` in
 * `agentTaskPrompt.ts` lists the words it takes and what each one means.
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
    return {
      kind: 'failed',
      sentence: result.kind === 'cancelled' ? CANCELLED_TURN_ERROR : INTERRUPTED_TURN_ERROR,
      restart: false,
      finalText,
    };
  }
  const parsed = parseResult(finalText);
  return {
    kind: parsed.kind,
    sentence: parsed.sentence,
    restart: parsed.restart,
    finalText,
  };
}

/**
 * How much of the turn's final text the report carries. The whole text, not a
 * tail: the model writes the findings first and the `RESULT:` boilerplate
 * last, so a tail cut dropped the body and started the message mid-word
 * (seen 2026-11-16 on llama-updates and strata-engine update, both ~1.3k).
 * The ceiling is generous because the Telegram transport splits what it
 * cannot fit into follow-on messages; the old 800-char tail was protecting
 * nothing.
 */
const REPORT_BODY_CHARS = 4_000;

/** Build the human report for a finished agent-task run. */
export function reportMessage(
  outcome: AgentTaskOutcome,
  startedAt: number,
  durationMs: number,
  conversationId: string | null,
): string {
  const body =
    outcome.finalText.length > REPORT_BODY_CHARS
      ? `${outcome.finalText.slice(0, REPORT_BODY_CHARS).trimEnd()}\n…(report clipped)`
      : outcome.finalText;
  return (
    `Date/time (Europe/Athens, 24-hour): ${formatAthensDateTime(startedAt)}\n` +
    `${outcome.kind}: ${outcome.sentence} ` +
    `(${formatDuration(durationMs)})` +
    (conversationId ? ` — conversation ${conversationId}` : '') +
    (body ? `\n\n${body}` : '')
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
