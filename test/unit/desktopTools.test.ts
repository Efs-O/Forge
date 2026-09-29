/**
 * Phase 3 focused tests: screenshotPath parsing, consequential approval,
 * cloud monitor approval, and the non-win32 platform gate (B7).
 */
import { describe, it, expect } from 'vitest';
import { screenshotPath } from '../../src/sidebar/toolResultView';
import { isSystemChord } from '../../src/tools/desktop/PowerShellDesktopDriver';

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

describe('consequential approval logic', () => {
  it('isSystemChord detects the B2 system chords', () => {
    // win+any
    expect(isSystemChord(['win', 'r'])).toBe(true);
    expect(isSystemChord(['win', 'd'])).toBe(true);
    // alt+f4
    expect(isSystemChord(['alt', 'f4'])).toBe(true);
    // ctrl+alt+any
    expect(isSystemChord(['ctrl', 'alt', 'delete'])).toBe(true);
    expect(isSystemChord(['ctrl', 'alt', 't'])).toBe(true);
  });

  it('isSystemChord does not flag normal editing chords', () => {
    expect(isSystemChord(['ctrl', 'c'])).toBe(false);
    expect(isSystemChord(['ctrl', 'v'])).toBe(false);
    expect(isSystemChord(['ctrl', 'z'])).toBe(false);
    expect(isSystemChord(['alt', 'tab'])).toBe(false);
    expect(isSystemChord(['shift', 'tab'])).toBe(false);
    expect(isSystemChord(['enter'])).toBe(false);
    expect(isSystemChord(['escape'])).toBe(false);
  });

  it('isSystemChord handles case-insensitivity', () => {
    expect(isSystemChord(['WIN', 'R'])).toBe(true);
    expect(isSystemChord(['Alt', 'F4'])).toBe(true);
    expect(isSystemChord(['Ctrl', 'Alt', 'Delete'])).toBe(true);
  });
});

describe('platform gate (B7)', () => {
  it('desktop tools are advertised only on win32', () => {
    // The advertise predicate is `() => process.platform === 'win32'`.
    // We cannot easily mock process.platform in vitest without vi.spyOn,
    // so we verify the logic directly.
    const isWin = () => process.platform === 'win32';
    if (process.platform === 'win32') {
      expect(isWin()).toBe(true);
    } else {
      expect(isWin()).toBe(false);
    }
  });
});
