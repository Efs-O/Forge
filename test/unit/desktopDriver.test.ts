/**
 * Unit tests for the PowerShellDesktopDriver (B2/B3 gates) and the
 * desktop tool approval logic. No real mouse, no PowerShell process.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PowerShellDesktopDriver,
  isSystemChord,
  type DesktopTransport,
} from '../../src/tools/desktop/PowerShellDesktopDriver';
import type { ApprovedWindow } from '../../src/tools/desktop/targetWindowGate';
import type { CaptureFrame } from '../../src/tools/desktop/coordinateTransform';

/** A fake transport that records all ops and can simulate responses. */
class FakeTransport implements DesktopTransport {
  sent: Record<string, unknown>[] = [];
  disposed = false;
  private responses: Record<string, Record<string, unknown>> = {};

  /** Register a response for an op name (matched by `op` field). */
  on(op: string, response: Record<string, unknown>): void {
    this.responses[op] = response;
  }

  async send(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push(op);
    const opName = String(op['op'] ?? '');
    return this.responses[opName] ?? { ok: true };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Model the real transport: dispose sends the `dispose` op, which the driver
    // handles as release-all (button-up + key-up for everything, B3).
    this.sent.push({ op: 'dispose' });
  }
}

const approvedWindow: ApprovedWindow = {
  hwnd: '0x1234',
  pid: 9999,
  title: 'Test Window',
  className: 'TestWindowClass',
  processName: 'testapp',
  rect: { x: 100, y: 100, width: 800, height: 600 },
  processStartTime: 1700000000000,
};

const captureFrame: CaptureFrame = {
  captureWidth: 800,
  captureHeight: 600,
  imageWidth: 800,
  imageHeight: 600,
  originX: 100,
  originY: 100,
};

/** Build a driver with a fake transport and a pre-bound capture. */
function makeDriver(transport: FakeTransport): PowerShellDesktopDriver {
  const driver = new PowerShellDesktopDriver(transport);
  // Simulate a window capture by calling the internal method via the public API.
  // We need to set up the capture record; do it via the transport response.
  transport.on('capture', {
    ok: true,
    png_base64: Buffer.from('fake').toString('base64'),
    capture_width: 800,
    capture_height: 600,
    image_width: 800,
    image_height: 600,
    origin: { x: 100, y: 100 },
    dpi_scale: 1.0,
    hwnd: '0x1234',
    pid: 9999,
    title: 'Test Window',
    class: 'TestWindowClass',
    process_name: 'testapp',
    process_start_time: 1700000000000,
    rect: { x: 100, y: 100, width: 800, height: 600 },
  });
  transport.on('foreground', { ok: true, hwnd: '0x1234', pid: 9999, title: 'Test Window' });
  return driver;
}

describe('isSystemChord', () => {
  it('detects win+any', () => {
    expect(isSystemChord(['win', 'r'])).toBe(true);
    expect(isSystemChord(['win'])).toBe(true);
  });

  it('detects alt+f4', () => {
    expect(isSystemChord(['alt', 'f4'])).toBe(true);
  });

  it('detects ctrl+alt+any', () => {
    expect(isSystemChord(['ctrl', 'alt', 'delete'])).toBe(true);
  });

  it('does not flag normal chords', () => {
    expect(isSystemChord(['ctrl', 'c'])).toBe(false);
    expect(isSystemChord(['ctrl', 'v'])).toBe(false);
    expect(isSystemChord(['alt', 'tab'])).toBe(false);
    expect(isSystemChord(['enter'])).toBe(false);
  });
});

describe('PowerShellDesktopDriver B2 gate', () => {
  it('refuses input when the foreground window is not the approved target', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);

    // Bind a capture (this approves the window).
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });

    // Now simulate the foreground changing to a different window.
    transport.on('foreground', { ok: true, hwnd: '0x9999', pid: 1111, title: 'Other Window' });

    // A click should be refused by the gate.
    await expect(
      driver.click(10, 10, {}, 'cap-1'),
    ).rejects.toThrow(/foreground window is not the approved target/);
  });

  it('refuses input when the point is outside the approved rect', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });

    // The window rect is (100,100,800,600) → valid range x:[100,900) y:[100,700).
    // A point at physical (50, 50) is outside.
    // In image_px with 1:1 mapping, image (0,0) → physical (100,100) which is inside.
    // To get outside, use a large coordinate: image (900, 0) → physical (1000, 100) which is outside x.
    await expect(
      driver.click(900, 0, {}, 'cap-1'),
    ).rejects.toThrow(/outside the approved window/);
  });

  it('refuses coordinate actions on a monitor capture', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    transport.on('capture', {
      ok: true,
      png_base64: Buffer.from('fake').toString('base64'),
      capture_width: 1920,
      capture_height: 1080,
      image_width: 1920,
      image_height: 1080,
      origin: { x: 0, y: 0 },
      dpi_scale: 1.0,
      hwnd: null,
      pid: null,
      title: 'monitor',
      class: '',
      process_name: '',
      process_start_time: null,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      monitor_index: 0, monitor_count: 1, monitor_device: '\\\\.\\DISPLAY1',
    });
    await driver.capture({ kind: 'monitor', index: 0 });

    // Coordinate actions require a window capture.
    await expect(
      driver.click(100, 100, {}, 'cap-1'),
    ).rejects.toThrow(/coordinate actions require a window capture/);
  });
});

describe('PowerShellDesktopDriver B3 abort/release', () => {
  it('dispose() sends the release-all (dispose) op to the transport (B3)', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });

    await driver.dispose();

    expect(transport.disposed).toBe(true);
    // The release-all is the `dispose` op the real transport sends on teardown —
    // the driver must actually send it, not merely call transport.dispose().
    expect(transport.sent.some((o) => o['op'] === 'dispose')).toBe(true);
  });

  it('dispose() is idempotent', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.dispose();
    await driver.dispose(); // Should not throw.
    expect(transport.disposed).toBe(true);
  });

  it('after dispose, input calls throw', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.dispose();

    // After dispose, the capture map is cleared, so any coordinate action fails.
    await expect(
      driver.click(10, 10, {}, 'cap-1'),
    ).rejects.toThrow(/unknown capture_id/);
  });
});

describe('PowerShellDesktopDriver coordinate transform', () => {
  it('maps image_px correctly with a non-zero origin', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });

    // Image (0,0) → physical (100,100) (the origin).
    await driver.moveMouse(0, 0, 'cap-1', 'image_px');
    const moveOp = transport.sent.find((o) => o['op'] === 'move');
    expect(moveOp).toBeDefined();
    expect(moveOp!['x']).toBe(100);
    expect(moveOp!['y']).toBe(100);
  });

  it('maps norm_1000 correctly', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });

    // norm_1000 (500,500) → image (400,300) → physical (500,400).
    await driver.moveMouse(500, 500, 'cap-1', 'norm_1000');
    const moveOp = transport.sent.find((o) => o['op'] === 'move');
    expect(moveOp).toBeDefined();
    // image_x = (500/1000)*800 = 400; physical_x = 400*(800/800)+100 = 500
    // image_y = (500/1000)*600 = 300; physical_y = 300*(600/600)+100 = 400
    expect(moveOp!['x']).toBe(500);
    expect(moveOp!['y']).toBe(400);
  });

  it('maps a downscaled image correctly', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    // Override the capture to simulate a downscaled image.
    transport.on('capture', {
      ok: true,
      png_base64: Buffer.from('fake').toString('base64'),
      capture_width: 1600,
      capture_height: 1200,
      image_width: 800,
      image_height: 600,
      origin: { x: 200, y: 150 },
      dpi_scale: 1.5,
      hwnd: '0x1234',
      pid: 9999,
      title: 'Test Window',
      class: 'TestWindowClass',
      process_name: 'testapp',
      process_start_time: 1700000000000,
      rect: { x: 200, y: 150, width: 1600, height: 1200 },
    });
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });

    // Image (400,300) in a 800×600 image of a 1600×1200 capture at origin (200,150).
    // image_x = 400; physical_x = 400*(1600/800)+200 = 1000
    // image_y = 300; physical_y = 300*(1200/600)+150 = 750
    await driver.moveMouse(400, 300, 'cap-1', 'image_px');
    const moveOp = transport.sent.find((o) => o['op'] === 'move');
    expect(moveOp).toBeDefined();
    expect(moveOp!['x']).toBe(1000);
    expect(moveOp!['y']).toBe(750);
  });
});

describe('PowerShellDesktopDriver identity binding', () => {
  it('sends expected_hwnd, expected_pid, expected_start_time with input ops', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });

    await driver.click(10, 10, {}, 'cap-1');
    const clickOp = transport.sent.find((o) => o['op'] === 'click');
    expect(clickOp).toBeDefined();
    expect(clickOp!['expected_hwnd']).toBe('0x1234');
    expect(clickOp!['expected_pid']).toBe(9999);
    expect(clickOp!['expected_start_time']).toBe(1700000000000);
  });
});

describe('PowerShellDesktopDriver pid-reuse binding (approve-time)', () => {
  it('refuses to approve a window whose process start time is unreadable (-1)', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ok: true,
      png_base64: Buffer.from('fake').toString('base64'),
      capture_width: 800, capture_height: 600, image_width: 800, image_height: 600,
      origin: { x: 100, y: 100 }, dpi_scale: 1.0,
      hwnd: '0x1234', pid: 9999, title: 'Elevated Window', class: 'TestWindowClass',
      process_name: 'testapp', process_start_time: -1,
      rect: { x: 100, y: 100, width: 800, height: 600 },
    });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(
      driver.capture({ kind: 'window', title: 'Elevated Window' }, { allowNewApproval: true }),
    ).rejects.toThrow(/cannot verify the process start time/);
  });

  it('refuses to approve a window whose process start time is missing', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ok: true,
      png_base64: Buffer.from('fake').toString('base64'),
      capture_width: 800, capture_height: 600, image_width: 800, image_height: 600,
      origin: { x: 100, y: 100 }, dpi_scale: 1.0,
      hwnd: '0x1234', pid: 9999, title: 'System Window', class: 'TestWindowClass',
      process_name: 'testapp',
      // process_start_time intentionally omitted (Get-Process returned nothing)
      rect: { x: 100, y: 100, width: 800, height: 600 },
    });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(
      driver.capture({ kind: 'window', title: 'System Window' }, { allowNewApproval: true }),
    ).rejects.toThrow(/cannot verify the process start time/);
  });
});

describe('PowerShellDesktopDriver capture approval binding', () => {
  it('refuses to bind a NEW window from a capture without a user approval', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    // No focus/approval yet: a plain capture must not approve the window for input.
    await expect(driver.capture({ kind: 'window', title: 'Test Window' })).rejects.toThrow(
      /not the approved target window/,
    );
    await expect(driver.typeText('hi')).rejects.toThrow(/no approved target window/);
  });

  it('allows re-capturing the already-approved window without a new approval', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });
    expect(driver.coversTitle('test win')).toBe(true);
    expect(driver.coversTitle('Other')).toBe(false);
    const cap = await driver.capture({ kind: 'window', title: 'Test Window' });
    expect(cap.approvedHwnd).toBe('0x1234');
  });

  it('refuses a covered title that resolves to a DIFFERENT hwnd', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    await driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true });
    transport.on('capture', {
      ok: true, png_base64: '', capture_width: 10, capture_height: 10, image_width: 10,
      image_height: 10, origin: { x: 0, y: 0 }, dpi_scale: 1, hwnd: '0x9999', pid: 1,
      title: 'Test Window (2)', class: 'X', process_name: 'other', process_start_time: 5,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    await expect(driver.capture({ kind: 'window', title: 'Test Window' })).rejects.toThrow(
      /not the approved target window/,
    );
  });

  it('refuses VS Code forks as a control target', async () => {
    for (const name of ['Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium']) {
      const transport = new FakeTransport();
      const driver = makeDriver(transport);
      transport.on('capture', {
        ok: true, png_base64: '', capture_width: 10, capture_height: 10, image_width: 10,
        image_height: 10, origin: { x: 0, y: 0 }, dpi_scale: 1, hwnd: '0x1', pid: 1,
        title: 'editor', class: 'Chrome_WidgetWin_1', process_name: name, process_start_time: 5,
        rect: { x: 0, y: 0, width: 10, height: 10 },
      });
      await expect(
        driver.capture({ kind: 'window', title: 'editor' }, { allowNewApproval: true }),
      ).rejects.toThrow(/VS Code window/);
    }
  });

  it('scroll forwards negative deltas unchanged (the PS driver negates WHEEL)', async () => {
    const transport = new FakeTransport();
    const driver = makeDriver(transport);
    const cap = await driver.capture(
      { kind: 'window', title: 'Test Window' },
      { allowNewApproval: true },
    );
    await driver.scroll(10, 10, { x: -2, y: -3 }, cap.captureId);
    const op = transport.sent.find((o) => o['op'] === 'scroll');
    expect(op).toMatchObject({ delta_x: -2, delta_y: -3 });
  });
});

/**
 * Report §3.1: `Get-WindowInfo` emits geometry nested under `rect`, but the old
 * TS reader looked for top-level `x`/`y`/`width`/`height` and `num()` defaulted
 * every missing field to `0` — so `desktop_windows` listed every window as
 * `(0,0 0×0)`. These tests pin the nested mapping and the validation that turns
 * a malformed item into a named skip instead of a plausible zero.
 */
describe('PowerShellDesktopDriver list_windows rect mapping (report §3.1)', () => {
  function driverWithWindows(windows: unknown[]): PowerShellDesktopDriver {
    const transport = new FakeTransport();
    transport.on('list_windows', { ok: true, windows });
    return new PowerShellDesktopDriver(transport);
  }

  it('maps the nested rect, keeping a valid negative origin', async () => {
    const driver = driverWithWindows([
      { id: '0x1', title: 'Left monitor app', rect: { x: -1920, y: 0, width: 800, height: 600 } },
      { id: '0x2', title: 'Maximized app', rect: { x: -8, y: -8, width: 3856, height: 1616 } },
    ]);
    const listing = await driver.listWindows();
    expect(listing.windows).toEqual([
      { id: '0x1', title: 'Left monitor app', rect: { x: -1920, y: 0, width: 800, height: 600 } },
      { id: '0x2', title: 'Maximized app', rect: { x: -8, y: -8, width: 3856, height: 1616 } },
    ]);
    expect(listing.skipped).toEqual([]);
  });

  it('skips a malformed rect instead of reporting a 0×0 row, and says so', async () => {
    const driver = driverWithWindows([
      // The old shape the TS reader expected: no nested rect at all.
      { id: '0x1', title: 'Old-shape window', x: 10, y: 20, width: 300, height: 200 },
      // Zero/negative size is never real geometry.
      { id: '0x2', title: 'Zero size', rect: { x: 0, y: 0, width: 0, height: 0 } },
      { id: '0x3', title: 'Negative size', rect: { x: 0, y: 0, width: -5, height: 10 } },
      // Non-finite values from a corrupted protocol line.
      { id: '0x4', title: 'NaN size', rect: { x: 0, y: 0, width: NaN, height: 10 } },
      // Strings are not numbers — a JSON/encoding break must not pass.
      { id: '0x5', title: 'String rect', rect: { x: '0', y: '0', width: '10', height: '10' } },
      // Valid, so the skips above cannot be mistaken for "everything is dropped".
      { id: '0x6', title: 'Good window', rect: { x: 5, y: 6, width: 7, height: 8 } },
    ]);
    const listing = await driver.listWindows();
    expect(listing.windows).toEqual([
      { id: '0x6', title: 'Good window', rect: { x: 5, y: 6, width: 7, height: 8 } },
    ]);
    // Every skip is NAMED IN THE RESULT. A list that quietly lost a window is a
    // quieter version of the 0×0 row it replaces, and the model never sees the
    // log channel — so the reason has to travel with the data.
    expect(listing.skipped.length).toBe(5);
    for (const title of ['Old-shape window', 'Zero size', 'Negative size', 'NaN size', 'String rect']) {
      expect(listing.skipped.join('\n')).toContain(title);
    }
  });

  it('raises a named protocol error when the window list itself is missing', async () => {
    const transport = new FakeTransport();
    transport.on('list_windows', { ok: true, wins: [] }); // renamed field
    const driver = new PowerShellDesktopDriver(transport);
    await expect(driver.listWindows()).rejects.toThrow(/no window list \(protocol mismatch\)/);
  });

  it('binds focus_window to the nested rect, never a defaulted 0×0', async () => {
    const transport = new FakeTransport();
    transport.on('focus_window', {
      ok: true,
      window: { id: '0x1', title: 'Test Window', pid: 1, class: 'C', process_name: 'p',
        process_start_time: 1700000000000, rect: { x: 0, y: 0, width: 0, height: 0 } },
    });
    const driver = new PowerShellDesktopDriver(transport);
    // Pre-fix, this resolved successfully with rect {0,0,0,0}: `inRect` then
    // refused EVERY point (x >= 0 && x < 0 is never true), so the user saw a
    // misleading "point is outside the approved window's rect" for a window the
    // driver had never described. A bound-but-wrong rect is refused outright.
    await expect(driver.focusWindow({ kind: 'windowId', id: '0x1' })).rejects.toThrow(
      /malformed geometry.*cannot bind a target whose rect is unknown/s,
    );
  });

  it('refuses to bind a control target from a capture with malformed geometry', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ok: true, png_base64: Buffer.from('fake').toString('base64'),
      capture_width: 800, capture_height: 600, image_width: 800, image_height: 600,
      origin: { x: 100, y: 100 }, dpi_scale: 1, hwnd: '0x1', pid: 1, title: 'Test Window',
      class: 'C', process_name: 'p', process_start_time: 1700000000000,
      rect: { x: 100, y: 100 }, // width/height missing
    });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(
      driver.capture({ kind: 'window', title: 'Test Window' }, { allowNewApproval: true }),
    ).rejects.toThrow(/malformed geometry.*cannot bind a control target/s);
  });
});

describe('PowerShellDesktopDriver capture frame validation', () => {
  const baseCapture = {
    ok: true, png_base64: Buffer.from('fake').toString('base64'),
    capture_width: 1920, capture_height: 1080, image_width: 1920, image_height: 1080,
    origin: { x: 0, y: 0 }, dpi_scale: 1,
  };

  it('reports capture size separately from the downscaled PNG size', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ...baseCapture, kind: 'monitor',
      capture_width: 3840, capture_height: 1600, image_width: 1344, image_height: 560,
      origin: { x: 0, y: 0 }, monitor_index: 0, monitor_count: 1, monitor_device: '\\\\.\\DISPLAY9',
    });
    const driver = new PowerShellDesktopDriver(transport);
    const cap = await driver.capture({ kind: 'monitor', index: 0 });
    expect(cap.width).toBe(1344);
    expect(cap.height).toBe(560);
    expect(cap.captureWidth).toBe(3840);
    expect(cap.captureHeight).toBe(1600);
    expect(cap.origin).toEqual({ x: 0, y: 0 });
    expect(cap.monitorIndex).toBe(0);
    expect(cap.monitorCount).toBe(1);
    expect(cap.monitorDevice).toBe('\\\\.\\DISPLAY9');
    // The request carries the index, so the driver cannot substitute another display.
    expect(transport.sent.find((o) => o['op'] === 'capture')).toMatchObject({ index: 0 });
  });

  it('refuses a monitor capture whose response omits the monitor metadata', async () => {
    // The old driver shape (no monitor_index/count/device) used to resolve with
    // the fields absent, so the tool rendered "monitor ? of ?" and reported a
    // successful capture of a display nobody could identify. A monitor capture
    // that cannot say WHICH display it took is now a protocol refusal.
    const transport = new FakeTransport();
    transport.on('capture', { ...baseCapture });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(driver.capture({ kind: 'monitor', index: 0 })).rejects.toThrow(
      /unusable monitor metadata \(monitor_index missing or not a whole number\)/,
    );
  });

  it('refuses a monitor capture that names a different display than requested', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ...baseCapture,
      monitor_index: 1, monitor_count: 2, monitor_device: '\\\\.\\DISPLAY2',
    });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(driver.capture({ kind: 'monitor', index: 0 })).rejects.toThrow(
      /monitor_index 1 is not the requested display 0/,
    );
  });

  it('refuses monitor metadata whose count does not contain the index', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ...baseCapture,
      monitor_index: 2, monitor_count: 2, monitor_device: '\\\\.\\DISPLAY3',
    });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(driver.capture({ kind: 'monitor', index: 2 })).rejects.toThrow(
      /monitor_index 2 is outside the reported range of 2 display\(s\)/,
    );
  });

  it('refuses monitor metadata with an empty device name', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ...baseCapture,
      monitor_index: 0, monitor_count: 1, monitor_device: '',
    });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(driver.capture({ kind: 'monitor', index: 0 })).rejects.toThrow(
      /monitor_device is empty/,
    );
  });

  it('refuses a fractional, negative, or non-finite monitor index before any request', async () => {
    // The schema declares integer/minimum 0, but schema validation is offline
    // only — a model can still send 0.5. PowerShell casts request values to
    // [int], so an unvalidated 0.5 would capture monitor 0 after the user
    // approved "a monitor", and -1 would wrap to an unintended display. The
    // refusal must happen BEFORE the transport sees anything.
    for (const bad of [0.5, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const transport = new FakeTransport();
      transport.on('capture', { ...baseCapture, monitor_index: 0, monitor_count: 1, monitor_device: '\\\\.\\DISPLAY1' });
      const driver = new PowerShellDesktopDriver(transport);
      await expect(driver.capture({ kind: 'monitor', index: bad })).rejects.toThrow(
        /monitor must be a whole number 0 or greater/,
      );
      expect(transport.sent.filter((o) => o['op'] === 'capture')).toEqual([]);
    }
  });

  it('refuses a capture whose frame size or origin is missing', async () => {
    for (const broken of [
      { capture_width: undefined },
      { image_height: 0 },
      { origin: { x: 0 } },
      { origin: undefined },
    ]) {
      const transport = new FakeTransport();
      transport.on('capture', { ...baseCapture, ...broken });
      const driver = new PowerShellDesktopDriver(transport);
      await expect(driver.capture({ kind: 'monitor', index: 0 })).rejects.toThrow(
        /incomplete capture frame/,
      );
    }
  });

  it('refuses an empty PNG rather than reporting a successful capture', async () => {
    const transport = new FakeTransport();
    transport.on('capture', {
      ...baseCapture, png_base64: '',
      monitor_index: 0, monitor_count: 1, monitor_device: '\\\\.\\DISPLAY1',
    });
    const driver = new PowerShellDesktopDriver(transport);
    await expect(driver.capture({ kind: 'monitor', index: 0 })).rejects.toThrow(/empty image/);
  });
});
