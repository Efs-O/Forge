import { describe, expect, it } from 'vitest';
import { PowerShellDesktopDriver } from '../../src/tools/desktop/PowerShellDesktopDriver';
import type { DesktopTransport } from '../../src/tools/desktop/PowerShellTransport';

class FakeTransport implements DesktopTransport {
  sent: Record<string, unknown>[] = [];
  private focusResponse: Record<string, unknown> = {};

  onFocus(response: Record<string, unknown>): void {
    this.focusResponse = response;
  }

  async send(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push(op);
    return op['op'] === 'focus_window' ? this.focusResponse : { ok: true };
  }

  async dispose(): Promise<void> {
    this.sent.push({ op: 'dispose' });
  }
}

const notepadWindow = {
  id: '0x1234',
  title: 'Untitled - Notepad',
  pid: 31752,
  class: 'Notepad',
  process_name: 'notepad',
  process_start_time: 1700000000000,
  rect: { x: 100, y: 100, width: 800, height: 600 },
};

describe('desktop_focus_window foreground movement', () => {
  it('refuses input when an app dialog takes foreground immediately after focus', async () => {
    const transport = new FakeTransport();
    const driver = new PowerShellDesktopDriver(transport);
    transport.onFocus({ ok: true, focus: 'ok', window: notepadWindow });
    await driver.focusWindow({ kind: 'windowId', id: '0x1234' });
    transport.onFocus({
      ok: true,
      focus: 'moved',
      window: notepadWindow,
      foreground: { id: '0x1902', title: 'Notepad' },
    });
    const focusError = await driver
      .focusWindow({ kind: 'windowId', id: '0x1234' })
      .catch((caught: unknown) => caught as Error);
    expect(focusError.message).toBe(
      'desktop_focus_window: "Untitled - Notepad" (HWND 0x1234) was focused, but "Notepad" (HWND 0x1902) took the foreground right after (usually a dialog the app opened). Input would be refused. Act on that window instead: desktop_focus_window with window_id "0x1902", or close it first.',
    );
    await expect(driver.typeText('must not type')).rejects.toThrow(
      'no approved target window; call desktop_focus_window or desktop_capture first',
    );
    expect(transport.sent.some((op) => op['op'] === 'type')).toBe(false);
  });

  it('names the no-window case when the foreground disappears after focus', async () => {
    const transport = new FakeTransport();
    transport.onFocus({
      ok: true,
      focus: 'moved',
      window: { ...notepadWindow, title: 'Program Manager' },
      foreground: { id: '0', title: '' },
    });
    const driver = new PowerShellDesktopDriver(transport);
    const focusError = await driver
      .focusWindow({ kind: 'windowId', id: '0x1234' })
      .catch((caught: unknown) => caught as Error);
    expect(focusError.message).toBe(
      'desktop_focus_window: "Program Manager" (HWND 0x1234) was focused, but lost the foreground right after and no window holds it now. Input would be refused. Pick a normal application window from desktop_windows.',
    );
  });
});
