/**
 * The text the desktop input tools report, kept out of `desktopTools.ts` so the
 * tool family stays inside the 500-line gate — one implementation per concern,
 * not a second copy of the rules.
 *
 * A click is only honest when the tool can say what it changed. Measured
 * 2026-11-16 on Word 2010's Find and Replace: a click on the "Replace with"
 * combo reported `Clicked (left, 1×)` and left the caret in the field above, so
 * the next `desktop_type` appended there and the model read its own text back as
 * `27/724/12`. The driver now reads which control holds keyboard focus before
 * and after the click, and where the cursor really landed.
 *
 * Focus is compared by HWND, never by class: Word's "Find what" and "Replace
 * with" are both `Edit` controls, so a caret that DID move between them would
 * read as "did not move" if the class were the only signal. The class is what
 * the line calls the control by; the HWND is what decides.
 */
import type { DesktopClickResult } from './DesktopDriver';

/** Whether the caret went to a different control, as far as the driver can tell. */
function focusMoved(result: DesktopClickResult): boolean {
  if (result.focusBeforeHwnd !== undefined && result.focusAfterHwnd !== undefined)
    return result.focusBeforeHwnd !== result.focusAfterHwnd;
  return result.focusBefore !== result.focusAfter;
}

function focusLine(result: DesktopClickResult): string {
  if (!result.focusAfter) {
    const why = result.focusReason ? ` (${result.focusReason})` : '';
    return `Keyboard focus could not be read${why} — do not assume the click focused anything.`;
  }
  if (!result.focusBefore) {
    return `Keyboard focus is now ${result.focusAfter} (it could not be read before the click).`;
  }
  if (!focusMoved(result)) {
    return (
      `Keyboard focus did not move (still ${result.focusAfter}) — a click on a label or a ` +
      "control's border does not focus a field. Press tab, or re-capture and click the field."
    );
  }
  if (result.focusBefore !== result.focusAfter) {
    return `Keyboard focus moved: ${result.focusBefore} → ${result.focusAfter}.`;
  }
  return `Keyboard focus moved to another control of the same kind (still ${result.focusAfter}).`;
}

/**
 * Lines for a click result: what happened, then what the click did NOT do.
 * "Focus did not move" is the normal outcome of clicking a label or a control's
 * border, so it is reported instead of hidden — that silence was the defect.
 */
export function clickResultLines(o: {
  result: DesktopClickResult;
  button: string;
  clicks: number;
  x: number;
  y: number;
  space: string;
}): string[] {
  const { result, button, clicks, x, y, space } = o;
  const lines = [`Clicked (${button}, ${clicks}×) at (${x},${y}) in ${space}.`, focusLine(result)];
  if (result.cursorOk === false && result.cursor) {
    lines.push(
      `The cursor is at (${result.cursor.x},${result.cursor.y}), not where this click aimed — ` +
        'the capture is stale: call desktop_capture again before clicking.',
    );
  }
  return lines;
}
