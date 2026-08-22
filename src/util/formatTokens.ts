/**
 * Token-count formatting shared by the sidebar's token bar and the status bar.
 *
 * The two had separate formatters and disagreed above 1M: the header's stopped
 * at `k`, so a 1,048,576-token window rendered as "1048.6k" next to the status
 * bar's "1.0M". Imported by webview code, so this stays dependency-free.
 */

/** Compact form for display: 1234 -> "1.2k", 1048576 -> "1.0M". */
export function formatTokens(value: number | undefined): string {
  if (value === undefined) return '—';
  const n = Math.max(0, Math.floor(value));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimUnit(n / 1_000)}k`;
  if (n < 1_000_000_000) return `${trimUnit(n / 1_000_000)}M`;
  return `${trimUnit(n / 1_000_000_000)}B`;
}

/** Exact form for tooltips, where the precise number is the point. */
export function formatExactTokens(value: number | undefined): string {
  return value === undefined ? 'unavailable' : Math.max(0, Math.floor(value)).toLocaleString();
}

function trimUnit(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
}
