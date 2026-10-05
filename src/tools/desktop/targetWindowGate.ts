/**
 * The target-window gate (plan §4.2, B2). Pure and process-free so the Phase 3
 * gate tests can drive the refusals directly without a real mouse or a driver.
 *
 * Two responsibilities:
 *  1. **Approval** — `approve()` binds the control target to a window's HWND +
 *     process id, and refuses the secure desktop / UAC, the taskbar, and every
 *     editor whose process name is on the never-allowed list. VS Code's own
 *     `code` process is refused unless the caller's `DesktopPolicy` opts in
 *     (`permissions.desktop.allow_vscode`) — the one policy change plan Phase 3
 *     makes, and it is still not a licence to type: every input to a Code
 *     window carries its own confirmation at the tool layer.
 *  2. **Per-input check** — `check()` / `checkAgainst()` run before every input
 *     call: the policy is re-applied (so revoking the opt-in lands on the next
 *     input, including one through a capture taken earlier), the foreground
 *     window must be the approved HWND, and (for a coordinate action) the
 *     physical point must be inside the approved rect. Otherwise it refuses and
 *     names the fix (re-focus the target, or re-capture).
 *
 * The gate does NOT do the Windows calls — the driver supplies the foreground
 * HWND and the point; the gate only decides allow/refuse. It also never reads
 * config: the policy arrives as an argument from the driver's live getter.
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

/** Process names that are never a valid control target (VS Code forks + editors). */

/**
 * The live desktop policy the gate is evaluated under (plan Phase 3 item 2).
 * Supplied by the caller as a getter, never captured once, so revoking the
 * opt-in takes effect on the next input rather than the next window reload.
 */
export interface DesktopPolicy {
  /** Opt in to the ordinary VS Code `code` process. Default false. */
  allowVsCode: boolean;
}

/** The deny-by-default policy: used when no live config getter is bound. */
export const DENY_VSCODE: DesktopPolicy = { allowVsCode: false };

/**
 * Process names that are NEVER a valid control target, whatever the config
 * says: VS Code forks and other editors. The `allow_vscode` opt-in does not
 * reach these — it is deliberately narrow to the ordinary `code` process.
 */
const ALWAYS_REFUSED_PROCESS_NAMES = new Set([
  'code - insiders',
  'codium',
  'vscodium',
  'cursor',
  'windsurf',
  'devenv',
]);

/**
 * Narrow process-name match for the ordinary VS Code install: `code` or
 * `code.exe`, nothing else. The comparison is on the PROCESS NAME only — never
 * the window title and never the `Chrome_WidgetWin_1` window class — because a
 * title/class match would also catch a fork, a web app installed as an app, or
 * any other Electron window that happens to be named "Visual Studio Code".
 */
function isVsCodeProcessName(processName: string): boolean {
  return processName.toLowerCase().replace(/\.exe$/, '') === 'code';
}

/** True when this window is the ordinary VS Code process (opt-in target). */
export function isVsCodeTarget(win: { processName: string }): boolean {
  return isVsCodeProcessName(win.processName);
}

/**
 * Why this window cannot be controlled under `policy`, or undefined when it
 * can. One implementation for the approve-time refusal and the per-input
 * recheck, so the two cannot drift apart — which is what made a revoked
 * opt-in still drive a window it had approved earlier.
 */
export function policyRefusalFor(
  win: ApprovedWindow,
  policy: DesktopPolicy = DENY_VSCODE,
): string | undefined {
  const name = win.processName.toLowerCase().replace(/\.exe$/, '');
  if (ALWAYS_REFUSED_PROCESS_NAMES.has(name)) {
    // Keeps the "VS Code window" phrase the fork refusal has always used (a
    // fork IS a VS Code-family editor), and adds that the opt-in does not reach
    // it — so the message cannot be misread as "flip the switch and retry".
    return (
      `refusing to control a VS Code window (the editor "${win.title}", process ${name}); ` +
      'permissions.desktop.allow_vscode covers the ordinary code process only — this target is never allowed'
    );
  }
  if (isVsCodeProcessName(win.processName)) {
    if (policy.allowVsCode) return undefined;
    return `refusing to control a VS Code window ("${win.title}"); pick a different target, or set permissions.desktop.allow_vscode: true to allow it with per-action confirmation`;
  }
  if (/user account control|secure desktop/i.test(win.title)) {
    return 'refusing to control the secure desktop / UAC prompt';
  }
  if (win.className.toLowerCase() === 'shell_traywnd') {
    return 'refusing to control the taskbar';
  }
  return undefined;
}

/**
 * Revocation of the editor opt-in, applied to a driver's held state.
 *
 * Narrower than `clear()`: only Code targets the policy now refuses go. Every
 * capture record bound to one is deleted from `captures` in place; an
 * unrelated window's approval and its captures survive, so revoking the
 * editor opt-in cannot silently unlock a Notepad target the user still means
 * to use, and re-enabling does not resurrect a dropped approval, because the
 * capture records that made it addressable are gone too.
 *
 * Every record is scanned, not just the current approval's: a Code window
 * captured earlier, then superseded by another target, still holds records a
 * `capture_id` can reach. `checkAgainst` would refuse input through them, but
 * the plan asks that the records themselves go away.
 *
 * Returns true when `approved` must be dropped: it is a refused Code window,
 * or it shares an hwnd with a refused capture.
 */
export function revokeRefusedCodeTargets(
  approved: ApprovedWindow | undefined,
  captures: Map<string, { approved?: ApprovedWindow }>,
  policy: DesktopPolicy,
): boolean {
  const refused = (win: ApprovedWindow): boolean =>
    isVsCodeTarget(win) && policyRefusalFor(win, policy) !== undefined;
  const refusedHwnds = new Set<string>();
  for (const [id, record] of captures) {
    if (!record.approved || !refused(record.approved)) continue;
    refusedHwnds.add(record.approved.hwnd);
    captures.delete(id);
  }
  if (!approved) return false;
  return refused(approved) || refusedHwnds.has(approved.hwnd);
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

  /** The current approval's process name (read-only, for policy reporting). */
  get approvedProcessName(): string | undefined {
    return this.approved?.processName;
  }

  /**
   * Bind the control target. Refuses the always-refused set (forks, UAC,
   * taskbar) unconditionally, and VS Code unless `policy.allowVsCode`.
   */
  approve(win: ApprovedWindow, policy: DesktopPolicy = DENY_VSCODE): GateResult {
    const reason = policyRefusalFor(win, policy);
    if (reason) return { ok: false, reason };
    this.approved = win;
    return { ok: true };
  }

  /**
   * Check an input against a SPECIFIC approved window (pure — no internal
   * state). The driver uses this so a coordinate action is checked against the
   * window its own capture bound, not merely the last-approved one. `foregroundHwnd`
   * is the current foreground window (from the driver); `point` (physical px) is
   * required for coordinate actions and checked against the approved rect.
   *
   * The policy is re-checked here as well as at approve time: an approval bound
   * while `allow_vscode` was on must not survive its revocation, and a capture
   * made before the change is exactly the stale handle that would otherwise
   * still resolve (plan Phase 3 item 3).
   */
  checkAgainst(
    approved: ApprovedWindow,
    foregroundHwnd: string,
    point?: { x: number; y: number },
    policy: DesktopPolicy = DENY_VSCODE,
  ): GateResult {
    const reason = policyRefusalFor(approved, policy);
    if (reason) return { ok: false, reason };
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
   * approved rect. The policy is re-applied here too (see `checkAgainst`).
   */
  check(
    foregroundHwnd: string,
    point?: { x: number; y: number },
    policy: DesktopPolicy = DENY_VSCODE,
  ): GateResult {
    if (!this.approved) {
      return { ok: false, reason: 'no approved target window; call desktop_focus_window first' };
    }
    return this.checkAgainst(this.approved, foregroundHwnd, point, policy);
  }

  /** Drop the approval (e.g. on dispose or when the window is gone). */
  clear(): void {
    this.approved = null;
  }
}
