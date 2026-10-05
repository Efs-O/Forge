/**
 * The stateless guards a browser input action runs before and after it acts
 * (docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md Phase 3 item 1, plus the Phase 1
 * coordinate-bound check).
 *
 * These live apart from `BrowserSessionManager` for the same reason
 * `browserPrimitives.ts` does: they hold no session state and no snapshot. The
 * manager remains the sole owner of sessions, tabs, origins, and inspection
 * snapshots; this module only decides whether a point is addressable, how long
 * a locator action may wait, and how a failed action is named. It calls no
 * Playwright transport of its own.
 */

/**
 * The bound on a selector/index locator action: `click`, `fill`, `hover`,
 * `press`, and selector-scoped `scroll`/`evaluate` (Phase 3 item 1).
 *
 * Playwright's own default action timeout is 30 s, which is what made a typo in
 * a selector cost half a minute per attempt (report §3.5). Five seconds is long
 * enough for a valid element on a slow page to become actionable and short
 * enough that a bad selector is a fast, retryable refusal. Navigation keeps its
 * own 30-second budget — a slow page load is a different failure from a missing
 * element, and shortening it would break browsing to fix typing.
 *
 * Adjust this ONLY from measured valid-page evidence, and say so in
 * docs/BROWSER_DESKTOP_TOOLS.md.
 */
export const LOCATOR_ACTION_TIMEOUT_MS = 5000;

/** A viewport the caller has resolved (CSS px, == device px at scale 1). */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Refuse a coordinate the viewport cannot receive, BEFORE dispatching it.
 * `page.mouse` accepts any number and reports success, so an out-of-viewport
 * point used to be a silent no-op with a success message (report §3.8).
 */
export function requireViewportPoint(
  viewport: ViewportSize,
  x: number,
  y: number,
  action: string,
): void {
  const inBounds =
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x < viewport.width &&
    y < viewport.height;
  if (inBounds) return;
  throw new Error(
    `${action}: (${x},${y}) is outside the ${viewport.width}×${viewport.height} viewport ` +
      '(valid x: 0-' +
      (viewport.width - 1) +
      ', y: 0-' +
      (viewport.height - 1) +
      '). Use browser_inspect for an element target, or a point inside a browser_screenshot.',
  );
}

/**
 * Run one locator action under the shared bound and name it when it fails.
 *
 * The Playwright cause is preserved on `cause` AND quoted in the message, and
 * the tool/action/target that produced it is named: a bare
 * `locator.click: Timeout 5000ms exceeded` tells the model nothing about which
 * selector to fix. A timeout is never converted to success and never retried
 * automatically — the plan's pass rule is one clear refusal, not a silent
 * second attempt that doubles the latency.
 */
export async function withLocatorActionTimeout<T>(
  action: string,
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const next = new Error(
      `browser_${action}: ${target} failed within ${LOCATOR_ACTION_TIMEOUT_MS} ms (${cause}). ` +
        'The element may be missing, hidden, or detached — call browser_inspect and use its index.',
      { cause: err },
    );
    throw next;
  }
}
