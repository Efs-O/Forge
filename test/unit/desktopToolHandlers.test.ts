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
});
