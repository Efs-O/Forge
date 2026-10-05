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
 * UTF-8 stdin boundary (plan Phase 2 item 1; report §3.10). The `echo` op is
 * diagnostic-only: it returns the text the driver actually decoded, so the
 * request path is proven WITHOUT any OS input and without an approved target.
 * Code points are asserted, not just strings — a mojibake round trip can look
 * "the same" to a casual comparison while typing the wrong characters.
 *
 * Both engines are exercised because the corruption was engine-dependent in
 * mechanism: `[Console]::In` decodes a redirected pipe with the console input
 * code page, and the driver set no input decoder at all. The probe on this host
 * showed `café` arriving as U+233C U+03C3 under BOTH pwsh 7.6 and Windows
 * PowerShell 5.1 (a CP437 decode of the UTF-8 bytes), and the explicit
 * strict-UTF8 StreamReader returning exact code points on both.
 */
const ECHO_CASES: ReadonlyArray<[string, string]> = [
  ['ascii', 'hello world'],
  ['accents', 'café'],
  ['greek', 'Γειά σου'],
  ['cjk', '你好'],
  ['emoji', '🚀'],
  ['mixed', 'a€中😀b'],
];

/** UTF-16 code units, the same thing the driver reports via `[int][char]$s[$i]`. */
function utf16Units(s: string): string[] {
  const units: string[] = [];
  for (let i = 0; i < s.length; i++) units.push(String(s.charCodeAt(i)));
  return units;
}

function echoSuite(engine: 'pwsh' | 'powershell' | undefined, label: string): void {
  describe.skipIf(process.platform !== 'win32')(`desktop driver stdin UTF-8 (${label})`, () => {
    let t: PowerShellTransport | undefined;
    let ran = 'unknown';

    beforeAll(async () => {
      t = new PowerShellTransport(undefined, 30_000, engine);
      // Warm the child once so every case shares one process (each spawn is
      // ~1s and this suite already runs many PowerShell children).
      await t.send({ op: 'echo', text: 'warm' });
      ran = t.driverExecutable;
    }, 60_000);

    afterAll(async () => {
      await t?.dispose();
    });

    it(`round-trips every payload exactly through the ${label} child`, async () => {
      const transport = t as PowerShellTransport;
      for (const [name, text] of ECHO_CASES) {
        const r = await transport.send({ op: 'echo', text });
        expect(r['ok'], `${name}: driver refused`).toBe(true);
        // Exact string equality AND exact UTF-16 units, so a decomposition or a
        // replacement character cannot pass as "close enough". The driver
        // reports its own units too, which catches a decode that happened on
        // only one side of the pipe.
        expect(r['text'], `${name}: text`).toBe(text);
        const expectedUnits = utf16Units(text);
        expect(utf16Units(r['text'] as string).join(','), `${name}: UTF-16 units`).toBe(
          expectedUnits.join(','),
        );
        expect(String(r['codepoints']), `${name}: driver-reported code units`).toBe(
          expectedUnits.join(','),
        );
        expect(Number(r['utf16_length']), `${name}: length`).toBe(expectedUnits.length);
      }
    }, 60_000);

    it('keeps decoder state and line framing across sequential requests', async () => {
      // Two requests on ONE child: a per-request decoder would pass this while a
      // stream decoder that loses state after a multi-byte sequence would not.
      const transport = t as PowerShellTransport;
      const a = await transport.send({ op: 'echo', text: 'first café' });
      const b = await transport.send({ op: 'echo', text: 'then 你好 🚀' });
      expect(a['text']).toBe('first café');
      expect(b['text']).toBe('then 你好 🚀');
    }, 60_000);

    it(`ran on the engine it claims (${label})`, () => {
      // Reported, not assumed: the plan requires naming which engine actually ran.
      expect(['pwsh', 'powershell']).toContain(ran);
      if (engine) expect(ran).toBe(engine);
    });
  });
}

echoSuite(undefined, 'default: pwsh with 5.1 fallback');
echoSuite('powershell', 'Windows PowerShell 5.1 fallback pinned');

describe.skipIf(process.platform !== 'win32')('desktop driver strict UTF-8 stdin', () => {
  it('refuses invalid UTF-8 instead of typing replacement characters', async () => {
    // Strict decoding (UTF8Encoding($false, $true)) must THROW on malformed
    // bytes. A lenient decoder would hand the driver U+FFFD and `desktop_type`
    // would happily type garbage into the user's window — the exact class of
    // silent corruption §3.10 reported.
    const t = new PowerShellTransport();
    try {
      await t.send({ op: 'echo', text: 'ok' });
      const child = (t as unknown as { child: { stdin: NodeJS.WritableStream } }).child;
      // `{"op":"sleep","ms":1500}` keeps the driver busy, so it is guaranteed to
      // read the malformed line only while this request is still pending.
      // Without that, the child's exit and the next send race and a freshly
      // respawned child would answer the follow-up happily.
      const pending = t.send({ op: 'sleep', ms: 1500 });
      // `{"text":"<0xC3 0x28>"}` — 0xC3 followed by '(' is an invalid UTF-8
      // sequence (a 2-byte lead byte with a non-continuation second byte).
      child.stdin.write(Buffer.from('7b2274657874223a22c328227d0a', 'hex'));
      // The pending request is rejected by the transport's exit handler, which
      // carries the driver's stderr tail — so the failure is named, not silent.
      await expect(pending).rejects.toThrow(/exited \(code 4\)[\s\S]*not valid UTF-8/i);
    } finally {
      await t.dispose();
    }
  }, 60_000);
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
