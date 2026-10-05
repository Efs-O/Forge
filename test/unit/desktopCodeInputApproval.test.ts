/**
 * Phase 3 item 4 at the TOOL layer: every desktop input tool confirms per call
 * when its target is a VS Code window — including the two that are
 * `autoApprove: true` and `desktop_drag`, which no permission rule would catch
 * (`desktop` is not a write permission, so `autoApprove` is the whole story for
 * move/scroll, and drag has neither flag nor approval of its own today).
 *
 * The confirmation is decided by `approval()` metadata: `ToolDispatch` asks when
 * `approval()` returns anything, so these tests assert exactly the signal the
 * dispatcher reads. The driver is faked — these are pure predicate tests, no
 * PowerShell and no mouse.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { ToolApprovalMetadata } from '../../src/tools/ToolRegistry';
import type { ApprovedWindow } from '../../src/tools/desktop/targetWindowGate';

const h = vi.hoisted(() => ({
  /** What the fake driver reports as the current approval / a capture's target. */
  approved: undefined as ApprovedWindow | undefined,
  captureTargets: new Map<string, ApprovedWindow | undefined>(),
  /** Every policy getter makeDesktopTools passed to the driver singleton. */
  policyGetters: [] as (() => { allowVsCode: boolean })[],
}));

const codeWindow: ApprovedWindow = {
  hwnd: '0x9999',
  pid: 7777,
  title: 'Forge - Visual Studio Code',
  className: 'Chrome_WidgetWin_1',
  processName: 'Code',
  rect: { x: 0, y: 0, width: 1200, height: 800 },
};

const notepadWindow: ApprovedWindow = {
  hwnd: '0x1234',
  pid: 4242,
  title: 'Untitled - Notepad',
  className: 'Notepad',
  processName: 'notepad',
  rect: { x: 0, y: 0, width: 800, height: 600 },
};

const fakeDriver = {
  coversTitle: () => true,
  capture: vi.fn(),
  listWindows: vi.fn(async () => ({ windows: [], skipped: [] })),
  approvedTarget: () => h.approved,
  captureTarget: (id: string) => h.captureTargets.get(id),
};

vi.mock('../../src/tools/desktop/PowerShellDesktopDriver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/desktop/PowerShellDesktopDriver')>();
  return {
    ...actual,
    getDesktopDriver: (policy?: () => { allowVsCode: boolean }) => {
      if (policy) h.policyGetters.push(policy);
      return fakeDriver;
    },
  };
});

vi.mock('../../src/tools/browser/browserTools', () => ({
  saveScreenshot: async () => 'C:\\fake\\shot.png',
  visionRefusal: () => undefined,
}));

import { makeDesktopTools } from '../../src/tools/desktop/desktopTools';

const config = (allowVsCode: boolean) =>
  ({
    active_model: undefined,
    permissions: { desktop: { enabled: true, allow_vscode: allowVsCode } },
  }) as unknown as ForgeConfig;

function tool(name: string, allowVsCode = true) {
  const t = makeDesktopTools(() => config(allowVsCode)).find(
    (x) => x.definition.function.name === name,
  );
  if (!t) throw new Error(`tool "${name}" is not registered`);
  return t;
}

/** Run a tool's approval predicate, or undefined when it stays silent. */
function approvalFor(name: string, args: Record<string, unknown>): ToolApprovalMetadata | undefined {
  return tool(name).approval?.(args);
}

const COORD_ARGS = { x: 10, y: 10, capture_id: 'cap-1' };

describe('per-call confirmation for VS Code input (Phase 3 item 4)', () => {
  it('every coordinate input tool confirms against a Code capture_id', () => {
    h.approved = codeWindow;
    h.captureTargets = new Map([['cap-1', codeWindow]]);
    for (const name of ['desktop_move_mouse', 'desktop_click', 'desktop_drag', 'desktop_scroll']) {
      const args =
        name === 'desktop_drag'
          ? { from_x: 1, from_y: 1, to_x: 2, to_y: 2, capture_id: 'cap-1' }
          : COORD_ARGS;
      const meta = approvalFor(name, args);
      expect(meta, `${name} must confirm against a Code target`).toBeDefined();
      expect(meta?.dangerous).toBe(true);
      // Names the Code window AND the action, per the plan.
      expect(meta?.detail).toContain('Forge - Visual Studio Code');
      expect(meta?.detail).toMatch(/0x9999/);
      expect(meta?.detail).toMatch(/allow_vscode/);
    }
  });

  it('type and press confirm against the current approved target', () => {
    h.approved = codeWindow;
    h.captureTargets = new Map();
    for (const [name, args] of [
      ['desktop_type', { text: 'hello' }],
      ['desktop_press', { keys: ['ctrl', 'a'] }],
    ] as const) {
      const meta = approvalFor(name, args);
      expect(meta, `${name} must confirm against a Code target`).toBeDefined();
      expect(meta?.dangerous).toBe(true);
      expect(meta?.detail).toContain('Forge - Visual Studio Code');
    }
  });

  it('the auto-approved tools gain the confirmation without losing autoApprove', () => {
    // autoApprove stays for a NON-Code target; the Code case is decided by the
    // approval predicate, which is what forces the prompt.
    h.approved = notepadWindow;
    h.captureTargets = new Map([['cap-1', notepadWindow]]);
    for (const name of ['desktop_move_mouse', 'desktop_scroll']) {
      const t = tool(name);
      expect(t.autoApprove).toBe(true);
      expect(t.approval?.(COORD_ARGS)).toBeUndefined();
    }
    h.approved = codeWindow;
    h.captureTargets = new Map([['cap-1', codeWindow]]);
    for (const name of ['desktop_move_mouse', 'desktop_scroll']) {
      expect(tool(name).approval?.(COORD_ARGS)?.dangerous).toBe(true);
    }
  });

  it('a non-Code target keeps its existing approval behavior', () => {
    h.approved = notepadWindow;
    h.captureTargets = new Map([['cap-1', notepadWindow]]);
    expect(approvalFor('desktop_move_mouse', COORD_ARGS)).toBeUndefined();
    expect(approvalFor('desktop_scroll', COORD_ARGS)).toBeUndefined();
    expect(
      approvalFor('desktop_drag', { from_x: 1, from_y: 1, to_x: 2, to_y: 2, capture_id: 'cap-1' }),
    ).toBeUndefined();
    expect(approvalFor('desktop_click', COORD_ARGS)).toBeUndefined();
    expect(approvalFor('desktop_type', { text: 'x' })).toBeUndefined();
    expect(approvalFor('desktop_press', { keys: ['ctrl', 'c'] })).toBeUndefined();
    // …and the existing consequential warning still fires on its own.
    expect(approvalFor('desktop_click', { ...COORD_ARGS, consequential: true })?.dangerous).toBe(
      true,
    );
    expect(approvalFor('desktop_press', { keys: ['win', 'r'] })?.dangerous).toBe(true);
  });

  it('composes the Code warning with consequential and system-chord warnings', () => {
    h.approved = codeWindow;
    h.captureTargets = new Map([['cap-1', codeWindow]]);
    const click = approvalFor('desktop_click', { ...COORD_ARGS, consequential: true });
    expect(click?.dangerous).toBe(true);
    // Both reasons are present: neither warning may mask the other.
    expect(click?.detail).toMatch(/Consequential desktop_click/);
    expect(click?.detail).toMatch(/VS Code window/);

    const press = approvalFor('desktop_press', { keys: ['win', 'r'] });
    expect(press?.dangerous).toBe(true);
    expect(press?.detail).toMatch(/System chord \[win\+r\]/);
    expect(press?.detail).toMatch(/VS Code window/);
  });

  it('derives a coordinate target from capture_id, not from the newest approval', () => {
    // The capture is Code; a LATER approval moved to Notepad. The prompt must
    // name the window the call will actually act on.
    h.approved = notepadWindow;
    h.captureTargets = new Map([['cap-1', codeWindow]]);
    const meta = approvalFor('desktop_click', COORD_ARGS);
    expect(meta?.detail).toContain('Forge - Visual Studio Code');
    expect(meta?.detail).not.toContain('Notepad');

    // And the reverse: a Notepad capture with a Code approval must not be
    // warned about as if it were Code.
    h.approved = codeWindow;
    h.captureTargets = new Map([['cap-1', notepadWindow]]);
    expect(approvalFor('desktop_click', COORD_ARGS)).toBeUndefined();
  });

  it('does not invent a target for an unknown capture_id', () => {
    h.approved = codeWindow;
    h.captureTargets = new Map();
    // The handler will refuse the unknown id; the predicate must not claim a
    // Code window it cannot see.
    expect(approvalFor('desktop_click', { x: 1, y: 1, capture_id: 'cap-nope' })).toBeUndefined();
  });

  it('binds a LIVE policy getter to the driver singleton, not a captured Boolean', () => {
    // Phase 3 item 2: the driver must re-read the config per input. A getter
    // that returns a value captured at factory creation would pass every other
    // test here and still let a revoked opt-in drive Code until the next reload.
    let allowVsCode = false;
    const gettersBefore = h.policyGetters.length;
    makeDesktopTools(() => ({
      active_model: undefined,
      permissions: { desktop: { enabled: true, allow_vscode: allowVsCode } },
    }) as unknown as ForgeConfig);
    expect(h.policyGetters.length).toBeGreaterThan(gettersBefore);
    const getter = h.policyGetters[h.policyGetters.length - 1];
    expect(getter()).toEqual({ allowVsCode: false });
    // The same getter, the same registration, a changed config: it must follow.
    allowVsCode = true;
    expect(getter()).toEqual({ allowVsCode: true });
    // And a config with no desktop block at all denies, rather than throwing.
    const bare = makeDesktopTools(() => ({ active_model: undefined }) as unknown as ForgeConfig);
    expect(bare.length).toBeGreaterThan(0);
    const bareGetter = h.policyGetters[h.policyGetters.length - 1];
    expect(bareGetter()).toEqual({ allowVsCode: false });
  });

  it('names the opt-in in the focus/capture descriptions', () => {
    const t = tool('desktop_focus_window', false);
    expect(t.definition.function.description).toMatch(/allow_vscode/);
    expect(t.definition.function.description).toMatch(/each input|input.*confirm/s);
  });
});
