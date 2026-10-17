/**
 * Phase 3 focused tests: screenshotPath parsing, consequential approval,
 * cloud monitor approval, and the non-win32 platform gate (B7).
 */
import { describe, it, expect } from 'vitest';
import { screenshotPath } from '../../src/sidebar/toolResultView';
import { makeDesktopTools } from '../../src/tools/desktop/desktopTools';
import type { ForgeConfig } from '../../src/config/types';

describe('screenshotPath (webview thumbnail parsing)', () => {
  it('parses the saved path from a browser_screenshot result', () => {
    const result =
      'Screenshot of tab t1 ("Example"), 1280×720 px, coord_space=image_px. ' +
      'Saved to C:\\Users\\test\\.forge\\screenshots\\conv1\\abc123.png.';
    expect(screenshotPath('browser_screenshot', result)).toBe(
      'C:\\Users\\test\\.forge\\screenshots\\conv1\\abc123.png',
    );
  });

  it('parses the saved path from a desktop_capture result', () => {
    const result =
      'Desktop capture: window "Notepad" approved, 800×600 px, dpi_scale=1.5, ' +
      'origin=(100,200), coord_space=image_px. capture_id=cap-1. ' +
      'Saved to /home/user/.forge/screenshots/conv2/def456.png.';
    expect(screenshotPath('desktop_capture', result)).toBe(
      '/home/user/.forge/screenshots/conv2/def456.png',
    );
  });

  it('returns undefined for other tool names', () => {
    const result = 'Saved to /some/path.png.';
    expect(screenshotPath('view_image', result)).toBeUndefined();
    expect(screenshotPath('read_file', result)).toBeUndefined();
  });

  it('returns undefined for a failure result', () => {
    const result = 'Error: no approved target window; call desktop_focus_window first';
    expect(screenshotPath('desktop_capture', result)).toBeUndefined();
  });

  it('returns undefined when no saved path is present', () => {
    expect(screenshotPath('browser_screenshot', 'Browser not launched.')).toBeUndefined();
  });
});

describe('platform gate (B7)', () => {
  it('advertises the actual desktop tools only on win32', () => {
    const tools = makeDesktopTools(
      () => ({ permissions: { desktop: { allow_vscode: false } } }) as ForgeConfig,
    );
    const names = tools.map((tool) => tool.definition.function.name);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatform?.configurable) throw new Error('process.platform cannot be stubbed');

    try {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
      expect(tools.filter((tool) => tool.advertise?.()).map((tool) => tool.definition.function.name)).toEqual(names);

      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
      expect(tools.filter((tool) => tool.advertise?.())).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});
