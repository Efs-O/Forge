export interface RemoteProgressRenderState {
  headline: string;
  /**
   * The model's words as they stream. Only a draft preview carries any (see
   * `RemoteDraftLane`); a plain edited bubble is permanent, and streaming into
   * it showed every thought twice.
   */
  stream?: string;
  warnings: string[];
  milestone?: string;
  startedAt: number;
  lastActivityAt: number;
  toolCalls: number;
}

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

export function renderRemoteProgress(
  state: RemoteProgressRenderState,
  maximum: number,
  now: number,
): string {
  const sections = [state.headline];
  const stream = state.stream?.trim();
  if (stream) sections.push(stream);
  // Warnings sit below the headline and above the live milestone: they are
  // the part of the message the reader most needs and the part most likely to
  // be trimmed, so they are never the first thing the tail cut reaches. The
  // clock goes last for the same reason in reverse: the tail cut keeps it.
  if (state.warnings.length) {
    sections.push(state.warnings.map((warning) => `⚠ ${warning}`).join('\n'));
  }
  if (state.milestone) sections.push(state.milestone);
  const calls = state.toolCalls === 1 ? '1 tool call' : `${state.toolCalls} tool calls`;
  sections.push(
    `⏱ ${formatElapsed(now - state.startedAt)} · ${calls} · last activity ${formatLastActivity(
      now - state.lastActivityAt,
    )} ago`,
  );
  return keepTailWithPrefix(sections.join('\n\n'), maximum, `${state.headline}\n\n`);
}

/**
 * A draft preview's text: the turn's append-only log (`RemoteDraftLane`).
 * Telegram re-types a draft from the first character that changed, so a
 * status that is rewritten in place (the clock line's "last activity N s ago",
 * a tool name replacing the previous one) restarts the animation on every
 * update and the reader never sees past "Forge:". The log only grows: the
 * headline it opened with, then tool lines and the model's words as they come.
 */
export function renderRemoteDraft(state: RemoteProgressRenderState, maximum: number): string {
  return (state.stream?.trim() || state.headline).slice(0, maximum);
}

function keepTailWithPrefix(value: string, maximum: number, prefix: string): string {
  if (value.length <= maximum) return value;
  const room = Math.max(1, maximum - prefix.length);
  return `${prefix}…${value.slice(-(room - 1))}`;
}
