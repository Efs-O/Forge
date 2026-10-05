/**
 * Tool-boundary tests for `desktop_capture`'s `monitor` argument and for the
 * `desktop_windows` skip reporting (Phase 1, Codex finding 1 + finding 3).
 *
 * These assert the seam the driver-level tests cannot see: what the TOOL sends
 * to the driver. A fractional/negative/nonfinite index must be refused by the
 * handler BEFORE any capture request leaves, because the PowerShell driver
 * casts its request value to `[int]` — an unvalidated `0.5` would capture
 * monitor 0 after the user approved a capture of "a monitor", and `-1` would
 * select an unintended display. Asserting the throw alone is not enough: the
 * request must never have been made.
 *
 * The driver and the screenshot writer are faked, so no PowerShell process and
 * no real screen is touched.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { MultimodalToolResult } from '../../src/tools/ToolRegistry';

/** Every target the fake driver was actually asked to capture. */
const h = vi.hoisted(() => ({
  captureTargets: [] as unknown[],
  listWindowsResult: { windows: [] as unknown[], skipped: [] as string[] },
}));

const fakeCapture = {
  captureId: 'cap-1',
  kind: 'monitor' as const,
  png: Buffer.from('fake-png'),
  width: 1344,
  height: 560,
  captureWidth: 3840,
  captureHeight: 1600,
  dpiScale: 1,
  origin: { x: 0, y: 0 },
  monitorIndex: 0,
  monitorCount: 1,
  monitorDevice: '\\\\.\\DISPLAY1',
};

const fakeDriver = {
  capture: vi.fn(async (target: unknown) => {
    h.captureTargets.push(target);
    return {
      ...fakeCapture,
      monitorIndex: (target as { index: number }).index,
    };
  }),
  coversTitle: () => true,
  listWindows: vi.fn(async () => h.listWindowsResult),
};

vi.mock('../../src/tools/desktop/PowerShellDesktopDriver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/desktop/PowerShellDesktopDriver')>();
  return { ...actual, getDesktopDriver: () => fakeDriver };
});

vi.mock('../../src/tools/browser/browserTools', () => ({
  saveScreenshot: async () => 'C:\\fake\\forge\\screenshots\\conv\\shot.png',
  visionRefusal: () => undefined,
}));

// Imported after the mocks are registered (vitest hoists vi.mock above imports).
import { makeDesktopTools } from '../../src/tools/desktop/desktopTools';

const noCloudModel = (() => ({ active_model: undefined }) as unknown as ForgeConfig);

function tools() {
  return makeDesktopTools(() => noCloudModel);
}

function tool(name: string) {
  const t = tools().find((x) => x.definition.function.name === name);
  if (!t) throw new Error(`tool "${name}" is not registered`);
  return t;
}

function captureResult(r: string | MultimodalToolResult): string {
  return typeof r === 'string' ? r : r.text;
}

describe('desktop_capture monitor argument (tool boundary)', () => {
  it('declares monitor as a nonnegative integer in the schema', () => {
    const props = tool('desktop_capture').definition.function.parameters?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props['monitor']?.['type']).toBe('integer');
    expect(props['monitor']?.['minimum']).toBe(0);
  });

  it('refuses a fractional, negative, or non-finite index and sends no capture request', async () => {
    for (const bad of [0.5, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '0', true]) {
      h.captureTargets.length = 0;
      await expect(
        tool('desktop_capture').handler({ kind: 'monitor', monitor: bad }),
      ).rejects.toThrow(/monitor must be a whole number 0 or greater/);
      // The refusal must precede the driver: PowerShell's [int] cast would
      // otherwise turn the bad value into a different, unintended display.
      expect(h.captureTargets).toEqual([]);
    }
  });

  it('refuses kind:"monitor" with no monitor index, and sends no capture request', async () => {
    h.captureTargets.length = 0;
    await expect(tool('desktop_capture').handler({ kind: 'monitor' })).rejects.toThrow(
      /monitor index is required for a monitor capture/,
    );
    expect(h.captureTargets).toEqual([]);
  });

  it('passes a valid index through unchanged, including 0', async () => {
    for (const ok of [0, 1, 7]) {
      h.captureTargets.length = 0;
      const r = captureResult(await tool('desktop_capture').handler({ monitor: ok }));
      expect(h.captureTargets).toEqual([{ kind: 'monitor', index: ok }]);
      // `monitor: 0` with no `kind` is a monitor capture, not a window capture
      // that lost its title — and index 0 must not be mistaken for "absent".
      expect(r).toContain('read-only');
    }
  });

  it('renders the monitor the driver named, never a "?" placeholder', async () => {
    h.captureTargets.length = 0;
    fakeDriver.capture.mockImplementationOnce(async (target: unknown) => ({
      ...fakeCapture,
      monitorIndex: (target as { index: number }).index,
      monitorCount: 3,
      monitorDevice: '\\\\.\\DISPLAY9',
    }));
    const r = captureResult(await tool('desktop_capture').handler({ kind: 'monitor', monitor: 2 }));
    expect(r).toContain('monitor 2 of 3');
    expect(r).toContain('\\\\.\\DISPLAY9');
    expect(r).not.toContain('?');
  });
});

describe('desktop_windows malformed-geometry reporting (tool boundary)', () => {
  it('names skipped rows as a desktop_windows protocol error', async () => {
    h.listWindowsResult = {
      windows: [{ id: '0x6', title: 'Good window', rect: { x: 5, y: 6, width: 7, height: 8 } }],
      skipped: ['"Zero size" (HWND 0x2) had malformed geometry and was skipped'],
    };
    const r = await tool('desktop_windows').handler({});
    const text = typeof r === 'string' ? r : r.text;
    expect(text).toContain('0x6: "Good window" (5,6 7×8)');
    // The model must be able to tell "the driver could not describe this window"
    // from "this window has no geometry" — so it is labelled a protocol error
    // for that HWND, not a generic NOTE.
    expect(text).toMatch(/desktop_windows protocol error for 1 window\(s\)/);
    expect(text).toContain('HWND 0x2');
  });

  it('reports an empty desktop without inventing a protocol error', async () => {
    h.listWindowsResult = { windows: [], skipped: [] };
    const r = await tool('desktop_windows').handler({});
    const text = typeof r === 'string' ? r : r.text;
    expect(text).toBe('No visible windows found.');
    expect(text).not.toMatch(/protocol error/);
  });
});
