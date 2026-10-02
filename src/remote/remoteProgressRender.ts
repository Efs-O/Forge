export interface RemoteProgressRenderState {
  headline: string;
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

function keepTailWithPrefix(value: string, maximum: number, prefix: string): string {
  if (value.length <= maximum) return value;
  const room = Math.max(1, maximum - prefix.length);
  return `${prefix}…${value.slice(-(room - 1))}`;
}
