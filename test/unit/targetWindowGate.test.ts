import { describe, expect, it } from 'vitest';
import { TargetWindowGate, type ApprovedWindow } from '../../src/tools/desktop/targetWindowGate';

/**
 * Gate test B2 (plan §5 Phase 3): the target-window foreground + in-rect
 * refusals, driven directly against the pure gate (no mouse, no driver).
 * These are the evidence the desktop input path is signed against.
 */
const notepad: ApprovedWindow = {
  hwnd: '0x1234',
  pid: 4242,
  title: 'Untitled - Notepad',
  className: 'Notepad',
  processName: 'notepad',
  rect: { x: 100, y: 50, width: 800, height: 600 },
};

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
