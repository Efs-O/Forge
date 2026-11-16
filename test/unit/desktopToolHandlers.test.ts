/**
 * U18-02: the focus approval names the window the call will bind, and the
 * handler focuses exactly that HWND. The model's query used to be shown as is,
 * while the driver took the first window whose title merely contained it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { FoundWindow } from '../../src/tools/desktop/DesktopDriver';
import driverScript from '../../src/tools/desktop/desktopDriver.ps1';

const h = vi.hoisted(() => ({
  findWindow: vi.fn(),
  focusWindow: vi.fn(),
  click: vi.fn(),
}));

vi.mock('../../src/tools/desktop/PowerShellDesktopDriver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/desktop/PowerShellDesktopDriver')>();
  return {
    ...actual,
    getDesktopDriver: () => ({
      coversTitle: () => true,
      findWindow: h.findWindow,
      focusWindow: h.focusWindow,
      click: h.click,
      approvedTarget: () => undefined,
      captureTarget: () => undefined,
    }),
  };
});

const { focusApproval } = await import('../../src/tools/desktop/desktopApprovals');
const { makeDesktopTools } = await import('../../src/tools/desktop/desktopTools');

const notepad: FoundWindow = {
  id: '0x1234',
  title: 'notes.txt - Notepad',
  pid: 4242,
  processName: 'notepad',
};

function desktopTool(name: string) {
  const config = { permissions: { desktop: { enabled: true } } } as unknown as ForgeConfig;
  const tool = makeDesktopTools(() => config).find((t) => t.definition.function.name === name);
  if (!tool) throw new Error(`${name} is not registered`);
  return tool;
}
const focusTool = () => desktopTool('desktop_focus_window');

describe('desktop_focus_window approval (U18-02)', () => {
  it('names the resolved window, not the query', async () => {
    const { approval } = focusApproval({ findWindow: async () => notepad });
    const detail = (await approval({ window_title: 'notepad' }))?.detail;
    expect(detail).toContain('"notes.txt - Notepad"');
    expect(detail).toContain('notepad (pid 4242, HWND 0x1234)');
  });

  it('resolves once per call: the handler binds the HWND the prompt named', async () => {
    h.findWindow.mockReset().mockResolvedValue(notepad);
    h.focusWindow.mockReset().mockResolvedValue({ ...notepad, rect: {} });
    const tool = focusTool();
    const args = { window_title: 'notepad' };
    await tool.approval?.(args);
    await tool.handler(args, {} as never).catch(() => undefined);
    expect(h.findWindow).toHaveBeenCalledOnce();
    expect(h.focusWindow).toHaveBeenCalledWith({ kind: 'windowId', id: '0x1234' });
  });

  it('a target that does not resolve gets no prompt and focuses nothing', async () => {
    h.findWindow.mockReset().mockRejectedValue(new Error('2 windows match "Code"'));
    h.focusWindow.mockReset();
    const tool = focusTool();
    const args = { window_title: 'Code' };
    expect(await tool.approval?.(args)).toBeUndefined();
    await expect(tool.handler(args, {} as never)).rejects.toThrow('2 windows match');
    expect(h.findWindow).toHaveBeenCalledOnce();
    expect(h.focusWindow).not.toHaveBeenCalled();
  });

  it('the driver matches titles literally and refuses an ambiguous one', () => {
    const body = driverScript.match(
      /function Find-Window\(\$title, \$id\) \{([\s\S]*?)\r?\n\}/,
    )?.[1];
    expect(body).toBeDefined();
    expect(body).not.toMatch(/\$_\.title -like/);
    expect(body).toContain('IndexOf($title, [StringComparison]::OrdinalIgnoreCase)');
    expect(body).toMatch(/if \(\$hits\.Count -gt 1\) \{[\s\S]*throw/);
  });

  it('a numeric window_id — the way desktop_windows prints it — names the same HWND', async () => {
    h.findWindow.mockReset().mockResolvedValue({ ...notepad, id: '1312420' });
    h.focusWindow.mockReset().mockResolvedValue({ id: '1312420', title: 'x', rect: {} });
    await focusTool().handler({ window_id: 1312420 }, {} as never);
    expect(h.focusWindow).toHaveBeenCalledWith({ kind: 'windowId', id: '1312420' });
  });

  it('a window_id that is neither text nor a number still asks for one', async () => {
    h.findWindow.mockReset();
    h.focusWindow.mockReset();
    await expect(focusTool().handler({ window_id: true }, {} as never)).rejects.toThrow(
      'window_title or window_id is required',
    );
  });
});

describe('desktop_click clicks (U18-03)', () => {
  it('accepts 1 or 2 only; the driver never loops a model-chosen count', async () => {
    h.click.mockReset().mockResolvedValue(undefined);
    const tool = desktopTool('desktop_click');
    const schema = tool.definition.function.parameters as {
      properties: { clicks: { type: string; enum: number[] } };
    };
    expect(schema.properties.clicks).toMatchObject({ type: 'integer', enum: [1, 2] });
    const args = { x: 1, y: 1, capture_id: 'c1', clicks: 500 };
    await expect(tool.handler(args, {} as never)).rejects.toThrow('clicks must be 1 or 2');
    expect(h.click).not.toHaveBeenCalled();
  });

  it('says exactly what the click did to keyboard focus — the text the model acts on', async () => {
    // Measured 2026-11-16 on Word 2010's Find and Replace: the click reported
    // `Clicked` and left the caret in the field above, so the next type landed
    // there. Every branch is pinned in full, because this text is what the model
    // acts on, not prose it skims.
    const tool = desktopTool('desktop_click');
    const args = { x: 300, y: 118, capture_id: 'cap-1' };
    const ctx = { isVisionModel: true } as never;
    const head = 'Clicked (left, 1×) at (300,118) in image_px.';
    h.click.mockReset();

    h.click.mockResolvedValue({ focusBefore: 'Edit', focusAfter: 'Edit' });
    expect(await tool.handler(args, ctx)).toBe(
      `${head}\nKeyboard focus did not move (still Edit) — a click on a label or a ` +
        "control's border does not focus a field. Press tab, or re-capture and click the field.",
    );

    h.click.mockResolvedValue({ focusBefore: 'Edit', focusAfter: 'ComboBox' });
    expect(await tool.handler(args, ctx)).toBe(`${head}\nKeyboard focus moved: Edit → ComboBox.`);

    // The case that started this: Word's two fields are BOTH `Edit`, so the class
    // alone would call a moved caret "did not move". The HWND is what decides.
    h.click.mockResolvedValue({
      focusBefore: 'Edit',
      focusAfter: 'Edit',
      focusBeforeHwnd: '262154',
      focusAfterHwnd: '262154',
    });
    expect(await tool.handler(args, ctx)).toContain('Keyboard focus did not move (still Edit)');
    h.click.mockResolvedValue({
      focusBefore: 'Edit',
      focusAfter: 'Edit',
      focusBeforeHwnd: '262154',
      focusAfterHwnd: '262402',
    });
    expect(await tool.handler(args, ctx)).toBe(
      `${head}\nKeyboard focus moved to another control of the same kind (still Edit).`,
    );

    // A dialog with nothing focused before the first click: the before-read fails,
    // the after-read succeeds. Saying "did not move" there would be a lie.
    h.click.mockResolvedValue({ focusBefore: '', focusAfter: 'Edit' });
    expect(await tool.handler(args, ctx)).toBe(
      `${head}\nKeyboard focus is now Edit (it could not be read before the click).`,
    );

    h.click.mockResolvedValue({
      focusBefore: '',
      focusAfter: '',
      focusReason: 'target has no keyboard focus',
    });
    expect(await tool.handler(args, ctx)).toContain(
      'Keyboard focus could not be read (target has no keyboard focus)',
    );

    h.click.mockResolvedValue({
      focusBefore: 'Edit',
      focusAfter: 'Button',
      cursor: { x: 999, y: 999 },
      cursorOk: false,
    });
    expect(await tool.handler(args, ctx)).toContain(
      'The cursor is at (999,999), not where this click aimed — the capture is stale',
    );

    // GetCursorPos failed in the driver, so the cursor fields are absent. The tool
    // must stay silent about the cursor: claiming staleness on an unread position
    // would send the model to re-capture for nothing.
    h.click.mockResolvedValue({ focusBefore: 'Edit', focusAfter: 'Button' });
    const unread = await tool.handler(args, ctx);
    expect(unread).toBe(`${head}\nKeyboard focus moved: Edit → Button.`);
    expect(unread).not.toContain('cursor');
  });

  it('refuses a coordinate action on a model that cannot see the capture', async () => {
    const tool = desktopTool('desktop_click');
    h.click.mockReset();
    await expect(
      tool.handler({ x: 1, y: 1, capture_id: 'c1' }, { isVisionModel: false } as never),
    ).rejects.toThrow('desktop_click requires a vision model');
    expect(h.click).not.toHaveBeenCalled();
  });
});
