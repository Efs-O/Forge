/** Small formatters shared by Telegram's compact reports. */

/** Percentage label for phone-sized context summaries. */
export function contextPercent(used: number, max: number): number | undefined {
  if (max <= 0) return undefined;
  return Math.max(0, Math.round((used / max) * 100));
}

/** Numeric replacement for the Telegram-only context bar and ring. */
export function formatContextUsage(used: number, max: number): string | undefined {
  const percent = contextPercent(used, max);
  if (percent === undefined) return undefined;
  const remaining = Math.max(0, max - used);
  return `${percent}% · ${formatTokensShort(used)} of ${formatTokensShort(max)} · ${formatTokensShort(remaining)} left`;
}

/** Short, rounded token count for phone-sized reports. */
export function formatTokensShort(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
