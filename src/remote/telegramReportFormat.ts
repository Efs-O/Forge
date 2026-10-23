/** Small formatters shared by Telegram's compact reports. */

/** Used fraction as a fixed-width used/free block bar. */
export function textBar(fraction: number, cells: number): string {
  if (!Number.isInteger(cells) || cells < 1) {
    throw new Error('Telegram report bars need a positive whole number of cells.');
  }
  const bounded = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const used = Math.round(bounded * cells);
  return `${'█'.repeat(used)}${'░'.repeat(cells - used)}`;
}

/** Compact five-step context dial for Telegram status lines. */
export function contextRing(used: number, max: number): string | undefined {
  if (max <= 0) return undefined;
  const ratio = used / max;
  const bounded = Math.max(0, Math.min(1, ratio));
  const glyph =
    bounded < 0.125
      ? '○'
      : bounded < 0.375
        ? '◔'
        : bounded < 0.625
          ? '◑'
          : bounded < 0.875
            ? '◕'
            : '●';
  return `${glyph} ${Math.max(0, Math.round(ratio * 100))}%`;
}

/** Short, rounded token count for phone-sized reports. */
export function formatTokensShort(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
