/**
 * `4.2 s` for a span worth reporting, and `undefined` for one that is not.
 *
 * Sub-`floorMs` spans are dropped rather than rendered as `0.0 s`: at that
 * scale the figure is dominated by the measurement itself - a React commit, a
 * webview message hop - and claims a precision it does not have. A caller that
 * needs a stricter floor (a backend-start notice only exists at all once the
 * wait was long enough to announce) raises it.
 *
 * One owner, because there were two: the reasoning label formatted `4.2s` and
 * the backend-ready notice formatted `2.1 s`, from copies of the same three
 * lines, and the two disagreed about the space.
 */
export function formatDuration(ms: number | undefined, floorMs = 100): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < floorMs) return undefined;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}
