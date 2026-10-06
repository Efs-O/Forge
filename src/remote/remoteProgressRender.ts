export interface RemoteProgressRenderState {
  /** Set only while the turn is stuck on something that is not the model. */
  phase?: string;
  warnings: string[];
  milestone?: string;
  startedAt: number;
  lastActivityAt: number;
  toolCalls: number;
}

/** What the footer says when nothing more specific is happening. */
export const DEFAULT_STATUS = 'Forge: working…';

/** Pure formatting keeps the clock stable under fake time and reusable in tests. */
export function formatElapsed(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatLastActivity(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/**
 * The status footer under the turn's newest bubble.
 *
 * One status line, with the turn's latched warnings above it: the warnings are
 * the part the reader most needs, so when the footer is cut to its budget the
 * head is what goes, never the line that says what the turn is doing now.
 */
export function renderProgressFooter(
  state: RemoteProgressRenderState,
  maximum: number,
  now: number,
): string {
  const doing = [state.phase, state.milestone].filter(Boolean).join(' · ') || DEFAULT_STATUS;
  const calls = state.toolCalls === 1 ? '1 tool call' : `${state.toolCalls} tool calls`;
  const line = `⏳ ${doing} · ${formatElapsed(now - state.startedAt)} · ${calls} · last activity ${formatLastActivity(
    now - state.lastActivityAt,
  )} ago`;
  const lines = [...state.warnings.map((warning) => `⚠ ${warning}`), line].join('\n');
  if (lines.length <= maximum) return lines;
  return `…${lines.slice(-Math.max(1, maximum - 1))}`;
}
