/**
 * The target-window gate (plan §4.2, B2). Pure and process-free so the Phase 3
 * gate tests can drive the refusals directly without a real mouse or a driver.
 *
 * Two responsibilities:
 *  1. **Approval** — `approve()` binds the control target to a window's HWND +
 *     process id, and ALWAYS refuses any VS Code window, the secure desktop /
 *     UAC, and the taskbar. This is what stops the model from being pointed at
 *     its own editor or a privilege prompt.
 *  2. **Per-input check** — `check()` runs before every input call: the
 *     foreground window must be the approved HWND, and (for a coordinate
 *     action) the physical point must be inside the approved rect. Otherwise it
 *     refuses and names the fix (re-focus the target, or re-capture).
 *
 * The gate does NOT do the Windows calls — the driver supplies the foreground
 * HWND and the point; the gate only decides allow/refuse.
 */
import { inRect, type DesktopRect } from './coordinateTransform';

export interface ApprovedWindow {
  hwnd: string;
  pid: number;
  title: string;
  className: string;
  processName: string;
  rect: DesktopRect;
  /**
   * The target process's start time (ms since epoch), recorded at approve time.
   * The driver re-checks it before input to close the pid-reuse gap (a recycled
   * pid with a different start time is a different process). Optional so the
   * pure gate tests can omit it.
   */
  processStartTime?: number;
}

export type GateResult = { ok: true } | { ok: false; reason: string };

/** Process names that are never a valid control target (VS Code + forks). */
const REFUSED_PROCESS_NAMES = new Set([
  'code',
  'code - insiders',
  'codium',
  'vscodium',
  'cursor',
  'windsurf',
  'devenv',
]);

function isRefusedWindow(win: ApprovedWindow): boolean {
  const name = win.processName.toLowerCase().replace(/\.exe$/, '');
  if (REFUSED_PROCESS_NAMES.has(name)) return true;
  if (/user account control|secure desktop/i.test(win.title)) return true;
  if (win.className.toLowerCase() === 'shell_traywnd') return true;
  return false;
}

function refusedReason(win: ApprovedWindow): string {
  const name = win.processName.toLowerCase().replace(/\.exe$/, '');
  if (REFUSED_PROCESS_NAMES.has(name)) {
    return `refusing to control a VS Code window ("${win.title}"); pick a different target`;
  }
  if (/user account control|secure desktop/i.test(win.title)) {
    return 'refusing to control the secure desktop / UAC prompt';
  }
  return 'refusing to control the taskbar';
}

export class TargetWindowGate {
  private approved: ApprovedWindow | null = null;

  get hasApproved(): boolean {
    return this.approved !== null;
  }

  get approvedHwnd(): string | undefined {
    return this.approved?.hwnd;
  }

  get approvedTitle(): string | undefined {
    return this.approved?.title;
  }

  /** Bind the control target. Refuses VS Code / UAC / taskbar (B2). */
  approve(win: ApprovedWindow): GateResult {
    if (isRefusedWindow(win)) {
      return { ok: false, reason: refusedReason(win) };
    }
    this.approved = win;
    return { ok: true };
  }

  /**
   * Check an input against a SPECIFIC approved window (pure — no internal
   * state). The driver uses this so a coordinate action is checked against the
   * window its own capture bound, not merely the last-approved one. `foregroundHwnd`
   * is the current foreground window (from the driver); `point` (physical px) is
   * required for coordinate actions and checked against the approved rect.
   */
  checkAgainst(
    approved: ApprovedWindow,
    foregroundHwnd: string,
    point?: { x: number; y: number },
  ): GateResult {
    if (foregroundHwnd !== approved.hwnd) {
      return {
        ok: false,
        reason: `foreground window is not the approved target "${approved.title}"; re-focus it before acting`,
      };
    }
    if (point && !inRect(approved.rect, point.x, point.y)) {
      return {
        ok: false,
        reason: `point ${point.x},${point.y} is outside the approved window's rect; re-capture the target`,
      };
    }
    return { ok: true };
  }

  /**
   * Check whether an input is allowed now, against the gate's current approval.
   * `foregroundHwnd` is the current foreground window (from the driver); `point`
   * (physical px) is required for coordinate actions and checked against the
   * approved rect.
   */
  check(foregroundHwnd: string, point?: { x: number; y: number }): GateResult {
    if (!this.approved) {
      return { ok: false, reason: 'no approved target window; call desktop_focus_window first' };
    }
    return this.checkAgainst(this.approved, foregroundHwnd, point);
  }

  /** Drop the approval (e.g. on dispose or when the window is gone). */
  clear(): void {
    this.approved = null;
  }
}
