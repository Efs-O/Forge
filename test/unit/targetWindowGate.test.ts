import { describe, expect, it } from 'vitest';
import {
  TargetWindowGate,
  isVsCodeTarget,
  policyRefusalFor,
  revokeRefusedCodeTargets,
  type ApprovedWindow,
} from '../../src/tools/desktop/targetWindowGate';

/**
 * Gate test B2 (plan §5 Phase 3): the target-window foreground + in-rect
 * refusals, driven directly against the pure gate (no mouse, no driver).
 * These are the evidence the desktop input path is signed against.
 *
 * Phase 3 adds the `allow_vscode` policy: the gate decides it from a policy
 * ARGUMENT (it never reads config), and re-applies it on every check so a
 * revoked opt-in cannot be bypassed by an approval made earlier.
 */
const notepad: ApprovedWindow = {
  hwnd: '0x1234',
  pid: 4242,
  title: 'Untitled - Notepad',
  className: 'Notepad',
  processName: 'notepad',
  rect: { x: 100, y: 50, width: 800, height: 600 },
};

/** The ordinary VS Code window, shaped the way the driver reports it. */
const vscodeWindow: ApprovedWindow = {
  hwnd: '0x9999',
  pid: 7777,
  title: 'Forge - Visual Studio Code',
  className: 'Chrome_WidgetWin_1',
  processName: 'Code',
  rect: { x: 100, y: 50, width: 800, height: 600 },
};

const ALLOW = { allowVsCode: true };

describe('target-window gate (B2)', () => {
  it('approves an ordinary window and binds its HWND+pid', () => {
    const gate = new TargetWindowGate();
    expect(gate.approve(notepad)).toEqual({ ok: true });
    expect(gate.hasApproved).toBe(true);
    expect(gate.approvedHwnd).toBe('0x1234');
  });

  it('refuses a VS Code window at approval time', () => {
    const gate = new TargetWindowGate();
    const res = gate.approve({
      ...notepad,
      hwnd: '0x9999',
      title: 'Forge - Visual Studio Code',
      className: 'Chrome_WidgetWin_1',
      processName: 'Code',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/VS Code/);
    expect(gate.hasApproved).toBe(false);
  });

  it('refuses the secure desktop / UAC prompt', () => {
    const gate = new TargetWindowGate();
    const res = gate.approve({
      ...notepad,
      title: 'User Account Control',
      className: '#32770',
      processName: 'consent',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/secure desktop|UAC/);
  });

  it('refuses the taskbar', () => {
    const gate = new TargetWindowGate();
    const res = gate.approve({
      ...notepad,
      title: 'Taskbar',
      className: 'Shell_TrayWnd',
      processName: 'explorer',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/taskbar/i);
  });

  it('refuses input when no window is approved', () => {
    const gate = new TargetWindowGate();
    const res = gate.check('0x1234');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no approved target/);
  });

  it('refuses input when the foreground is not the approved window', () => {
    const gate = new TargetWindowGate();
    gate.approve(notepad);
    const res = gate.check('0xAAAA', { x: 200, y: 100 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/foreground window is not the approved/);
  });

  it('allows input when the foreground matches and the point is in-rect', () => {
    const gate = new TargetWindowGate();
    gate.approve(notepad);
    expect(gate.check('0x1234', { x: 200, y: 100 })).toEqual({ ok: true });
    // a non-coordinate action (no point) only needs the foreground match
    expect(gate.check('0x1234')).toEqual({ ok: true });
  });

  it('refuses a coordinate action whose point is outside the approved rect', () => {
    const gate = new TargetWindowGate();
    gate.approve(notepad);
    const res = gate.check('0x1234', { x: 9999, y: 9999 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/outside the approved window/);
  });

  it('clear() drops the approval', () => {
    const gate = new TargetWindowGate();
    gate.approve(notepad);
    gate.clear();
    expect(gate.hasApproved).toBe(false);
    expect(gate.check('0x1234').ok).toBe(false);
  });
});

/**
 * Phase 3 item 2 + 3: the `allow_vscode` opt-in. Narrow to the ordinary
 * `code`/`code.exe` process, re-checked on every input, and never extended to
 * forks, UAC, or the taskbar.
 */
describe('VS Code opt-in policy (Phase 3)', () => {
  it('refuses ordinary Code by default and names the switch', () => {
    const gate = new TargetWindowGate();
    const res = gate.approve(vscodeWindow);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/VS Code/);
      expect(res.reason).toMatch(/allow_vscode/);
    }
    expect(gate.hasApproved).toBe(false);
  });

  it('approves ordinary Code when opted in, and input is then allowed', () => {
    const gate = new TargetWindowGate();
    expect(gate.approve(vscodeWindow, ALLOW)).toEqual({ ok: true });
    expect(gate.check('0x9999', { x: 200, y: 100 }, ALLOW)).toEqual({ ok: true });
  });

  it('accepts the `.exe` spelling of the process name', () => {
    // The driver reports `Get-Process`.ProcessName (`code`), but a response
    // carrying `code.exe` must be the SAME target class, not a new one.
    expect(isVsCodeTarget({ processName: 'code.exe' })).toBe(true);
    expect(isVsCodeTarget({ processName: 'CODE' })).toBe(true);
    expect(isVsCodeTarget({ processName: 'code - insiders' })).toBe(false);
    expect(isVsCodeTarget({ processName: 'notepad' })).toBe(false);
  });

  it('never matches on title or window class', () => {
    // A title/class match would also catch a fork, a PWA, or any Electron app
    // named "Visual Studio Code" — the opt-in is a PROCESS-name rule.
    const lookalike: ApprovedWindow = {
      ...notepad,
      title: 'Visual Studio Code',
      className: 'Chrome_WidgetWin_1',
      processName: 'my-electron-app',
    };
    expect(isVsCodeTarget(lookalike)).toBe(false);
    const gate = new TargetWindowGate();
    expect(gate.approve(lookalike)).toEqual({ ok: true });
  });

  for (const name of ['Code - Insiders', 'Cursor', 'Windsurf', 'Codium', 'VSCodium', 'devenv']) {
    it(`refuses ${name} in both configurations`, () => {
      const win = { ...vscodeWindow, processName: name };
      const denied = policyRefusalFor(win);
      const allowed = policyRefusalFor(win, ALLOW);
      expect(denied).toMatch(/never allowed|editor/);
      // The opt-in must not reach a fork: same refusal reason with it on.
      expect(allowed).toBe(denied);
      const gate = new TargetWindowGate();
      expect(gate.approve(win, ALLOW).ok).toBe(false);
    });
  }

  it('refuses UAC and the taskbar in both configurations', () => {
    const uac: ApprovedWindow = {
      ...notepad,
      title: 'User Account Control',
      className: '#32770',
      processName: 'consent',
    };
    const taskbar: ApprovedWindow = {
      ...notepad,
      title: 'Taskbar',
      className: 'Shell_TrayWnd',
      processName: 'explorer',
    };
    for (const win of [uac, taskbar]) {
      for (const policy of [undefined, ALLOW]) {
        const gate = new TargetWindowGate();
        expect(gate.approve(win, policy).ok).toBe(false);
      }
    }
  });

  it('re-applies the policy on check: a revoked opt-in refuses the next input', () => {
    const gate = new TargetWindowGate();
    // Approved while the opt-in was ON.
    expect(gate.approve(vscodeWindow, ALLOW)).toEqual({ ok: true });
    // Policy turned off afterwards (config edited mid-session). The approval is
    // still held, but the check must refuse — the plan's revocation case.
    const res = gate.check('0x9999', { x: 200, y: 100 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/VS Code/);
    // A non-coordinate input is refused the same way.
    expect(gate.check('0x9999', undefined).ok).toBe(false);
    // Re-enabling does NOT resurrect it through `check` alone: the driver drops
    // the approval and its captures on revocation, so it must be re-approved.
    expect(gate.check('0x9999', { x: 200, y: 100 }, ALLOW)).toEqual({ ok: true });
  });

  it('leaves a non-Code approval unaffected by the policy', () => {
    const gate = new TargetWindowGate();
    gate.approve(notepad);
    expect(gate.check('0x1234', { x: 200, y: 100 }, ALLOW)).toEqual({ ok: true });
    expect(gate.check('0x1234', { x: 200, y: 100 })).toEqual({ ok: true });
  });

  it('keeps the foreground and in-rect refusals in front of an allowed Code target', () => {
    const gate = new TargetWindowGate();
    gate.approve(vscodeWindow, ALLOW);
    expect(gate.check('0xAAAA', { x: 200, y: 100 }, ALLOW).ok).toBe(false);
    const res = gate.check('0x9999', { x: 9999, y: 9999 }, ALLOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/outside the approved window/);
  });
});

describe('revokeRefusedCodeTargets (allow_vscode revoked)', () => {
  function held(): Map<string, { approved?: ApprovedWindow }> {
    return new Map<string, { approved?: ApprovedWindow }>([
      ['cap-code', { approved: vscodeWindow }],
      ['cap-notepad', { approved: notepad }],
      ['cap-monitor', {}],
    ]);
  }

  it('drops only Code captures, and the Code approval, once the opt-in is off', () => {
    const captures = held();
    expect(revokeRefusedCodeTargets(vscodeWindow, captures, { allowVsCode: false })).toBe(true);
    expect([...captures.keys()]).toEqual(['cap-notepad', 'cap-monitor']);
  });

  it('keeps an unrelated approval while still dropping a superseded Code capture', () => {
    const captures = held();
    expect(revokeRefusedCodeTargets(notepad, captures, { allowVsCode: false })).toBe(false);
    expect(captures.has('cap-code')).toBe(false);
  });

  it('changes nothing while the opt-in is on', () => {
    const captures = held();
    expect(revokeRefusedCodeTargets(vscodeWindow, captures, ALLOW)).toBe(false);
    expect(captures.size).toBe(3);
  });
});
