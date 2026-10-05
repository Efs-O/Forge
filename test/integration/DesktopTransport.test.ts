/**
 * PowerShellTransport against a real PowerShell child (Windows only): the real
 * driver answers, a dead child is respawned on the next request instead of the
 * singleton staying dead until reload, a silent child times out instead of
 * hanging the turn, and an exit carries the stderr tail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PowerShellTransport } from '../../src/tools/desktop/PowerShellTransport';
import { PowerShellDesktopDriver } from '../../src/tools/desktop/PowerShellDesktopDriver';
import type { DesktopMonitorCapture } from '../../src/tools/desktop/DesktopDriver';

describe.skipIf(process.platform !== 'win32')('PowerShellTransport (real child)', () => {
  it('answers list_windows and respawns after the child dies', async () => {
    const t = new PowerShellTransport();
    try {
      const r = await t.send({ op: 'list_windows' });
      expect(Array.isArray(r['windows'])).toBe(true);
      // Kill the child out from under the transport (a crash).
      (t as unknown as { child: { kill(): void } }).child.kill();
      await new Promise((r) => setTimeout(r, 500));
      const again = await t.send({ op: 'list_windows' });
      expect(Array.isArray(again['windows'])).toBe(true);
    } finally {
      await t.dispose();
    }
  }, 30_000);

  it('times out a request the child never answers', async () => {
    const t = new PowerShellTransport('while ($true) { Start-Sleep -Seconds 1 }', 1500);
    try {
      await expect(t.send({ op: 'list_windows' })).rejects.toThrow(/timed out after 1500 ms/);
    } finally {
      await t.dispose();
    }
  }, 30_000);

  it('rejects with the stderr tail when the child exits', async () => {
    const t = new PowerShellTransport("[Console]::Error.WriteLine('driver boom'); exit 3");
    try {
      await expect(t.send({ op: 'list_windows' })).rejects.toThrow(/code 3.*driver boom/s);
    } finally {
      await t.dispose();
    }
  }, 30_000);
});

/**
 * The real driver, read-only, through the real transport (Windows only).
 * These are the live counterparts to the fake-transport unit tests: they prove
 * the bundled `desktopDriver.ps1` actually emits the nested `rect` the TS
 * reader expects (report §3.1) and that `monitor: 0` selects the primary
 * display rather than the virtual desktop (Phase 1 item 6). Nothing here moves
 * a mouse, focuses a window, or types.
 *
 * ONE driver for the whole group: each `PowerShellTransport` spawns a PowerShell
 * child, and this suite already runs every test file in parallel. Four children
 * for one file is load this suite does not need — and a starved Chrome is how
 * the browser integration tests start timing out.
 */
describe.skipIf(process.platform !== 'win32')('desktop driver read-only live path', () => {
  let driver: PowerShellDesktopDriver;
  let primary: DesktopMonitorCapture;

  beforeAll(async () => {
    driver = new PowerShellDesktopDriver();
    // Reused by the index tests, so the capture happens once.
    const cap = await driver.capture({ kind: 'monitor', index: 0 });
    if (cap.kind !== 'monitor') {
      throw new Error('live driver returned a non-monitor capture for a monitor request');
    }
    primary = cap;
  }, 60_000);

  afterAll(async () => {
    await driver.dispose();
  });

  it('every listed window carries real nested geometry, never a 0x0 row', async () => {
    const listing = await driver.listWindows();
    const windows = listing.windows;
    expect(windows.length).toBeGreaterThan(0);
    // Nothing on a real desktop should be silently unreadable; if a row ever
    // is, the model must be told rather than shown a shorter list.
    expect(listing.skipped).toEqual([]);
    for (const w of windows) {
      expect(w.rect.width).toBeGreaterThan(0);
      expect(w.rect.height).toBeGreaterThan(0);
      expect(Number.isFinite(w.rect.x)).toBe(true);
      expect(Number.isFinite(w.rect.y)).toBe(true);
    }
    // A visible (non-minimized) window must have a real on-screen rect.
    // Minimized windows legitimately sit at (-32000,-32000), so only the
    // positive-area invariant is asserted for every row.
    const visible = windows.filter((w) => w.rect.x > -30000);
    expect(visible.length).toBeGreaterThan(0);
  }, 60_000);

  it('captures the primary monitor at its own rect, distinct from the virtual desktop', () => {
    const cap = primary;
    expect(cap.kind).toBe('monitor');
    expect(cap.png.length).toBeGreaterThan(1000);
    // PNG signature + IHDR width/height, read from the bytes themselves.
    expect(cap.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const pngWidth = cap.png.readUInt32BE(16);
    const pngHeight = cap.png.readUInt32BE(20);
    expect(pngWidth).toBe(cap.width);
    expect(pngHeight).toBe(cap.height);
    // Downscaled PNG size is reported separately from the physical capture.
    expect(cap.captureWidth).toBeGreaterThanOrEqual(cap.width);
    expect(cap.captureHeight).toBeGreaterThanOrEqual(cap.height);
    // Index 0 is the primary, so its physical origin is (0, 0) on Windows.
    expect(cap.monitorIndex).toBe(0);
    expect(cap.origin).toEqual({ x: 0, y: 0 });
    expect(cap.monitorCount).toBeGreaterThanOrEqual(1);
    expect(cap.monitorDevice).toMatch(/^\\\\\.\\DISPLAY\d+$/);
  });

  it('names the available range for an out-of-range monitor index', async () => {
    // A valid integer past the last display DOES reach the driver, which knows
    // the count and answers with the available range.
    await expect(driver.capture({ kind: 'monitor', index: 99 })).rejects.toThrow(
      /monitor 99 does not exist.*are available/s,
    );
    // A negative or fractional index is refused at the boundary instead, so it
    // never reaches PowerShell's `[int]` cast and cannot select a display the
    // caller (and the user who approved the capture) did not ask for.
    for (const bad of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      await expect(driver.capture({ kind: 'monitor', index: bad })).rejects.toThrow(
        /monitor must be a whole number 0 or greater/,
      );
    }
  }, 60_000);

  it('captures a second attached monitor when the host has one', async (t) => {
    const count = primary.monitorCount;
    if (count < 2) {
      // A real SKIP, reported as skipped: this host has one display, so the
      // second-monitor path is unverified here — never a passing test.
      t.skip('host reports 1 display; second-monitor capture not exercised');
      return;
    }
    const second = await driver.capture({ kind: 'monitor', index: 1 });
    expect(second.monitorIndex).toBe(1);
    expect(second.monitorDevice).not.toBe(primary.monitorDevice);
    // A non-primary display left of the primary has a negative origin; either
    // way the two captures must not be the same region.
    expect(second.origin).not.toEqual(primary.origin);
  }, 60_000);
});
