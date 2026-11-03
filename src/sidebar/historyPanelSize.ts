/**
 * The history panel's size: the shared half — the shape, the bounds, the clamps,
 * and the webview's one message about it.
 *
 * Deliberately dependency-free, because the webview imports it: a value import
 * here pulls its whole import graph into the sidebar bundle, and the store half
 * below needs `zod` and the Forge log channel, which the webview has neither.
 * The host reads this file to validate what it stores; the webview reads it to
 * apply what it stored. Neither invents its own numbers.
 */

/** The key's shape. Pixels, integers, chosen by a person dragging a grip. */
export interface HistoryPanelSize {
  width: number;
  height: number;
}

/** Below these the panel cannot show a search box, a tab strip and a row at once. */
export const PANEL_MIN_WIDTH = 260;
export const PANEL_MIN_HEIGHT = 300;
/**
 * Ceilings the host can enforce without knowing this window's sidebar: the webview
 * clamps to the sidebar's actual width and 90% of the viewport when it applies
 * the size, so these only bound what may be STORED, keeping a hand-edited
 * `globalState` from asking for a 40,000 px panel.
 */
export const PANEL_MAX_WIDTH = 1200;
export const PANEL_MAX_HEIGHT = 4000;

/** Today's capped width, kept as the default rather than as a limit. */
export const DEFAULT_PANEL_WIDTH = 480;
/** The panel may cover this much of the viewport when it is resized. */
export const VIEWPORT_HEIGHT_FRACTION = 0.9;

/**
 * Fit a chosen size into what this window can actually give it.
 *
 * Applied at apply time only — the stored value is what the owner chose, never
 * this result — so a window with a narrow sidebar does not cost them the width
 * they picked in a wide one. When the available space is itself below the floor
 * (a sidebar narrower than 260 px), the space wins: a panel that overflows its
 * own sidebar is the worse failure.
 */
export function clampPanelSize(
  size: HistoryPanelSize,
  availableWidth: number,
  availableHeight: number,
): HistoryPanelSize {
  const widthUpper = Math.min(availableWidth, PANEL_MAX_WIDTH);
  const heightUpper = Math.min(availableHeight, PANEL_MAX_HEIGHT);
  const widthLower = Math.min(PANEL_MIN_WIDTH, widthUpper);
  const heightLower = Math.min(PANEL_MIN_HEIGHT, heightUpper);
  return {
    width: Math.min(Math.max(size.width, widthLower), widthUpper),
    height: Math.min(Math.max(size.height, heightLower), heightUpper),
  };
}

/**
 * The webview's single message about the size: a size to remember after a drag
 * or a grip key press, or `null` after a double-click reset. Sent once per
 * action — never while the grip moves — so one resize is one write.
 */
export interface HistoryPanelSizeMsg {
  type: 'historyPanelSize';
  size: HistoryPanelSize | null;
}
