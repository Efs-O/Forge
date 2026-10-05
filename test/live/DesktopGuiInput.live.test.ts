/**
 * LIVE desktop text round trip (plan Phase 2 item 2, second half; report §3.10).
 *
 * The integration suite proves the BYTES reach PowerShell intact (`echo`,
 * no OS input). This test closes the remaining gap: those bytes must become the
 * SAME characters in a real window. That needs a real interactive desktop, so it
 * is env-gated and never runs in unattended CI.
 *
 *   FORGE_LIVE_DESKTOP_GUI=1 npx vitest run test/live/DesktopGuiInput.live.test.ts
 *
 * Host-safety rules, each enforced below:
 *  - Every window it touches is one it launched itself, identified ONLY by a
 *    unique fixture filename. It never searches for a generic title, so it
 *    cannot find, focus, or close a window the user opened.
 *  - The clipboard is inspected BEFORE any write. Non-text formats make this
 *    test destructive, so it refuses rather than attempting a partial restore.
 *    Plain text (or an empty clipboard) is saved and restored exactly.
 *  - Both refusals happen BEFORE any clipboard write.
 *  - Cleanup stops the jobs through the SAME manager that started them, then
 *    VERIFIES the test-owned windows and pids are gone, and fails loudly rather
 *    than swallowing a cleanup error.
 *  - No temp directory is created unless the live gate is on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { makeExecCommandTool } from '../../src/tools/execTools';
import { PowerShellDesktopDriver } from '../../src/tools/desktop/PowerShellDesktopDriver';
import { PowerShellTransport } from '../../src/tools/desktop/PowerShellTransport';
import type { DesktopWindow } from '../../src/tools/desktop/DesktopDriver';

const LIVE = process.env['FORGE_LIVE_DESKTOP_GUI'] === '1';
const WIN = process.platform === 'win32';

/**
 * Non-ASCII payloads chosen to exercise the classes §3.10 corrupts: Latin-1
 * range accents, Greek, CJK, and a surrogate pair. A CP437/CP1252 decode turns
 * each into different visible garbage, so an exact match is a real assertion.
 */
const PAYLOAD = 'café Γειά 你好 😀 tail';

const PS = 'powershell.exe';

function ps(script: string, env: Record<string, string> = {}): string {
  return execFileSync(
    PS,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...env },
    },
  );
}

/**
 * `[Console]::OutputEncoding` on Windows PowerShell 5.1 is the OEM code page
 * (this host: ibm737), and a redirected stdout uses it. Reading the clipboard
 * through that pipe turns `café` into `caf?` and every CJK character into a
 * replacement char — corruption in the MEASUREMENT, not in what was typed.
 * Setting UTF8 output encoding first was verified on this host to return the
 * exact code points; the BOM strip covers the same round trip through a file.
 */
function clipRead(): string {
  return ps('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw').replace(
    /^\uFEFF/,
    '',
  );
}

function clipWrite(value: string): void {
  // Passed through the environment rather than interpolated into the script:
  // clipboard content is arbitrary text and must not be able to break quoting.
  ps('Set-Clipboard -Value $env:FORGE_CLIP_VALUE', { FORGE_CLIP_VALUE: value });
}

/** Strip the trailing CR/LF a clipboard text round trip appends. */
function clipText(): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return clipRead().replace(/[\r\n]+$/, '');
    } catch {
      sleepSync(400); // the clipboard can be briefly locked by another process
    }
  }
  throw new Error('could not read the clipboard after 5 attempts');
}

/**
 * `Clipboard.Flush()` exists only on .NET Core / PowerShell 7; Windows
 * PowerShell 5.1 runs .NET Framework, where Set* commits immediately and the
 * method is absent. Calling it unguarded printed a MethodNotFound error on every
 * restore, so it is invoked only when it actually exists.
 */
const FLUSH =
  "if ([Windows.Forms.Clipboard].GetMethod('Flush')) { [Windows.Forms.Clipboard]::Flush() };";

/**
 * Reject every actual clipboard format beyond the standard plain-text formats.
 * A named list of rich formats misses custom formats that a UnicodeText-only
 * restore would silently destroy. GetFormats(false) excludes auto-conversions.
 */
function clipboardBlockedFormats(): string[] {
  const out = ps(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      '$data = [Windows.Forms.Clipboard]::GetDataObject();' +
      '$allowed = @("UnicodeText", "Text", "OEMText", "Locale", "System.String");' +
      '$blocked = if ($data) { @($data.GetFormats($false) | Where-Object { $_ -notin $allowed }) } else { @() };' +
      '"BLOCKED=" + ($blocked -join ",")',
  );
  const m = /BLOCKED=([^\r\n]*)/.exec(out);
  if (!m) throw new Error(`clipboard probe returned no verdict: ${out.trim()}`);
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Snapshot the clipboard's UnicodeText to a file, byte-exact.
 *
 * Deliberately NOT via stdout: `Get-Clipboard` and `Write-Output` each add their
 * own line terminator, so a Node-side comparison of a saved string against a
 * re-read one disagrees on trailing newlines alone (measured: 34 vs 32 chars for
 * a clipboard whose content was 30). The file is the source of truth, and the
 * restore verifies equality INSIDE PowerShell with `-ceq`.
 */
function clipboardSnapshotTo(file: string): 'empty' | 'saved' {
  const out = ps(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      '$u = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText);' +
      'if ([string]::IsNullOrEmpty($u)) { [IO.File]::WriteAllText($env:FORGE_CLIP_FILE, ""); "EMPTY" }' +
      ' else { [IO.File]::WriteAllText($env:FORGE_CLIP_FILE, $u); "SAVED" }',
    { FORGE_CLIP_FILE: file },
  );
  if (out.includes('EMPTY')) return 'empty';
  if (out.includes('SAVED')) return 'saved';
  throw new Error(`clipboard snapshot produced no verdict: ${out.trim()}`);
}

/**
 * Restore from the snapshot file and VERIFY it, returning a problem string when
 * the clipboard did not come back exactly. Empty snapshot restores to an empty
 * clipboard, which is the faithful thing to do for a run that started empty.
 */
function clipboardRestoreFrom(file: string): string | undefined {
  const out = ps(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      '$u = [IO.File]::ReadAllText($env:FORGE_CLIP_FILE);' +
      'if ([string]::IsNullOrEmpty($u)) {' +
      ' [Windows.Forms.Clipboard]::Clear(); ' +
      FLUSH +
      ' $back = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText);' +
      ' "MATCH=$([string]::IsNullOrEmpty($back))" }' +
      ' else {' +
      ' [Windows.Forms.Clipboard]::SetText($u, [Windows.Forms.TextDataFormat]::UnicodeText);' +
      FLUSH +
      ' $back = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText);' +
      ' "MATCH=$($back -ceq $u)" }',
    { FORGE_CLIP_FILE: file },
  );
  const m = /MATCH=(True|False)/.exec(out);
  if (!m) return `clipboard restore returned no verdict: ${out.trim()}`;
  return m[1] === 'True' ? undefined : 'clipboard text did not survive the restore exactly';
}

/** Blocking sleep: this test drives a real GUI and must not spin the loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function notepadProcesses(): number[] {
  return ps('Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }')
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function processAlive(pid: number): boolean {
  return ps(
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { "ALIVE" } else { "GONE" }`,
  ).includes('ALIVE');
}

/** Windows 11 build number, where Notepad became tabbed. */
function osBuild(): number {
  return Number(ps('[Environment]::OSVersion.Version.Build').trim());
}

describe.skipIf(!LIVE || !WIN)('live desktop text round trip (Notepad, manual gate)', () => {
  const driver = new PowerShellDesktopDriver();
  // Created in beforeAll, NOT in the describe callback: the callback runs even
  // when every test is skipped, so a fixture directory made here would be left
  // behind by unattended CI.
  let fixtureDir: string | undefined;
  let fixturePath = '';
  let fixtureName = '';
  let secondPath = '';
  let secondName = '';
  // Each entry is a job THIS test started through the exec_command tool, which
  // runs on the module singleton. Cleanup must go through that same singleton.
  const owned: { id: string; pid: number | undefined; windowName: string }[] = [];
  let fixture: DesktopWindow | undefined;
  let preflightPassed = false;
  // Path holding the pre-run clipboard text, so the restore can be verified
  // byte-exact rather than compared through PowerShell's stdout framing.
  let clipSnapshotFile: string | undefined;
  let clipboardTouched = false;

  async function waitForWindow(
    needle: string,
    timeoutMs: number,
  ): Promise<DesktopWindow | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listing = await driver.listWindows();
      const hit = listing.windows.find((w) => w.title.includes(needle));
      if (hit) return hit;
      sleepSync(500);
    }
    return undefined;
  }

  async function windowGone(needle: string): Promise<boolean> {
    const listing = await driver.listWindows();
    return !listing.windows.some((w) => w.title.includes(needle));
  }

  /**
   * Focus a window and WAIT for its text control to actually hold keyboard
   * focus. A freshly launched Notepad can be the foreground window for a moment
   * with `GUITHREADINFO.hwndFocus` still null, and the driver correctly refuses
   * input then ("target has no keyboard focus"). Pressing End is harmless on an
   * empty document, so retrying it doubles as the probe and the settle.
   */
  async function focusAndSettle(windowId: string): Promise<void> {
    let lastError = 'never attempted';
    for (let attempt = 0; attempt < 12; attempt++) {
      await driver.focusWindow({ kind: 'windowId', id: windowId });
      try {
        await driver.press(['end']);
        return;
      } catch (err) {
        lastError = (err as Error).message;
        sleepSync(300);
      }
    }
    throw new Error(`window ${windowId} never took keyboard focus: ${lastError}`);
  }

  /**
   * Launch a visible GUI through the real tool, then record the execution id AND
   * the pid the manager actually spawned, so cleanup can verify the process is
   * really gone instead of trusting a stop() that returned.
   */
  async function launchVisible(
    filePath: string,
  ): Promise<{ id: string; pid: number | undefined; result: string }> {
    const result = (await makeExecCommandTool().handler({
      command: 'notepad.exe',
      args: [filePath],
      cwd: process.cwd(),
      background: true,
      show_window: true,
    })) as string;
    const id = /exec-[0-9a-f-]+/.exec(result)?.[0];
    if (!id) throw new Error(`no execution id in the tool result: ${result}`);
    const job = { id, pid: undefined as number | undefined, windowName: path.basename(filePath) };
    owned.push(job);
    const observation = await backgroundExecutionManager.observe(id, 0, 0, 0);
    job.pid = observation.pid;
    return { id, pid: observation.pid, result };
  }

  beforeAll(async () => {
    // PREFLIGHT FIRST, before anything is created or overwritten.

    // On Windows 11 Notepad is tabbed: a second `notepad.exe <file>` can join an
    // EXISTING process whose window may belong to the user, which this test can
    // neither close safely nor tell apart. Refuse there. Windows 10 gives every
    // launch its own process and window, so a unique fixture name isolates it.
    if (osBuild() >= 22000) {
      const preexisting = notepadProcesses();
      if (preexisting.length > 0) {
        throw new Error(
          `live GUI test refused BEFORE touching anything: Notepad is tabbed on this OS and ` +
            `${preexisting.length} process(es) are already running (pids ${preexisting.join(', ')}). ` +
            'Close them before running this test.',
        );
      }
    }

    // The clipboard is only safe to overwrite when everything on it is plain
    // text (or nothing): that is the one case this harness can restore exactly.
    // Any other format is a refusal, before a single byte is written.
    const clip = clipboardBlockedFormats();
    if (clip.length > 0) {
      throw new Error(
        `live GUI test refused BEFORE touching anything: the clipboard holds ` +
          `${clip.join(', ')}, which this test cannot restore. Clear those formats ` +
          '(a plain-text or empty clipboard is fine) before running it.',
      );
    }
    // Snapshot the text to a file so the restore can be verified byte-exact.
    clipSnapshotFile = path.join(os.tmpdir(), `forge-gui-live-clip-${Date.now().toString(36)}.txt`);
    clipboardSnapshotTo(clipSnapshotFile);

    // Measure the measurement: prove the clipboard read path is codepage-proof
    // before asserting anything about typed text, so a later failure names the
    // driver rather than the harness.
    clipboardTouched = true;
    clipWrite(PAYLOAD);
    expect(clipText(), 'clipboard harness cannot round-trip the payload').toBe(PAYLOAD);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gui-live-'));
    fixtureDir = dir;
    // Every window this test owns is identified ONLY by a name no other window
    // can have.
    const token = Date.now().toString(36);
    fixtureName = `forge-live-${token}.txt`;
    secondName = `forge-live-${token}-b.txt`;
    fixturePath = path.join(dir, fixtureName);
    secondPath = path.join(dir, secondName);
    fs.writeFileSync(fixturePath, '', 'utf8');
    fs.writeFileSync(secondPath, '', 'utf8');
    preflightPassed = true;
  }, 60_000);

  afterAll(async () => {
    // Runs even when beforeAll threw, so a refused preflight still cleans up
    // whatever exists. Nothing here may touch a window it did not launch.
    const problems: string[] = [];

    for (const job of owned) {
      try {
        // The SAME singleton the tool used. Stopping a different manager would
        // silently no-op and leave the user looking at orphaned Notepads.
        await backgroundExecutionManager.stop(job.id);
      } catch (err) {
        problems.push(`stop(${job.id}) failed: ${(err as Error).message}`);
        continue;
      }
      // Verify the process is actually gone rather than trusting the call.
      if (job.pid !== undefined && processAlive(job.pid)) {
        problems.push(`pid ${job.pid} for ${job.windowName} is still alive after stop()`);
      }
    }
    // And the windows must be gone too: a launcher could in principle leave a
    // child GUI open, and this test must not hand one to the user. This runs
    // BEFORE driver.dispose(), because the check itself goes through the driver.
    for (const job of owned) {
      try {
        if (!(await windowGone(job.windowName))) {
          problems.push(`window for "${job.windowName}" is still on screen after cleanup`);
        }
      } catch (err) {
        problems.push(`could not verify "${job.windowName}" is gone: ${(err as Error).message}`);
      }
    }

    // Release any held key/button and shut the driver down last, so every
    // verification above had a live transport to ask.
    await driver.dispose();

    if (fixtureDir) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      if (fs.existsSync(fixtureDir)) problems.push(`temp dir ${fixtureDir} survived removal`);
    }

    // Restore the clipboard to exactly what the preflight found, and VERIFY it.
    try {
      if (!clipboardTouched) {
        // A refused preflight never changed the clipboard and owes no restore.
      } else if (clipSnapshotFile && fs.existsSync(clipSnapshotFile)) {
        const problem = clipboardRestoreFrom(clipSnapshotFile);
        if (problem) problems.push(problem);
      } else {
        problems.push('no clipboard snapshot file to restore from');
      }
    } catch (err) {
      problems.push(`clipboard restore failed: ${(err as Error).message}`);
    }
    if (clipSnapshotFile) fs.rmSync(clipSnapshotFile, { force: true });

    // A live GUI test that fails to clean up has damaged the owner's desktop;
    // that must be a loud failure, not a swallowed one.
    if (problems.length > 0) {
      throw new Error(
        `live GUI cleanup incomplete${preflightPassed ? '' : ' (preflight had refused)'}:\n  - ` +
          problems.join('\n  - '),
      );
    }
  });

  it('launches a visible GUI through exec_command show_window, and finds it in desktop_windows', async () => {
    const launched = await launchVisible(fixturePath);
    // The launcher/child note must be present on the real route, not just in the
    // unit test: the model has to be told what this id does NOT track.
    expect(launched.result).toMatch(/launched with a visible window/);
    expect(launched.result).toMatch(/tracks the process started here/);
    const observation = await backgroundExecutionManager.observe(launched.id, 0, 0, 0);
    expect(observation.status, 'the launched process should still be running').toBe('running');

    fixture = await waitForWindow(fixtureName, 20_000);
    if (!fixture) {
      throw new Error(
        `the launched Notepad window never appeared in desktop_windows (looked for "${fixtureName}")` +
          ' — either show_window did not make it visible, or this session has no interactive desktop',
      );
    }
    // A visible window has a real rect; a hidden/never-shown process has no row
    // at all, which is the §3.3 symptom this test exists to catch.
    expect(fixture.rect.width).toBeGreaterThan(0);
    expect(fixture.rect.height).toBeGreaterThan(0);
    // The pid the manager tracks must own this window, or cleanup below would be
    // stopping something other than what produced it.
    if (launched.pid !== undefined) {
      const listing = await driver.listWindows();
      expect(listing.windows.some((w) => w.title.includes(fixtureName))).toBe(true);
    }
  }, 90_000);

  it('types non-ASCII text into the real window and reads it back exactly', async () => {
    const w = fixture as DesktopWindow;
    // Focus (approves the target) then capture (binds the frame). Both are the
    // production driver paths, so the approval the input uses is the real one.
    await focusAndSettle(w.id);
    const cap = await driver.capture({ kind: 'window', title: w.title });
    expect(cap.kind).toBe('window');

    await driver.typeText(PAYLOAD);

    await driver.press(['ctrl', 'a']);
    await driver.press(['ctrl', 'c']);
    // Exact equality, not "contains": a single mojibake character fails this.
    expect(clipText()).toBe(PAYLOAD);
  }, 120_000);

  it('sends no input when the approved target has lost focus', async () => {
    const w = fixture as DesktopWindow;
    // Move the foreground away using a SECOND test-owned Notepad.
    const second = await launchVisible(secondPath);
    const other = await waitForWindow(secondName, 20_000);
    if (!other) throw new Error('the second Notepad window never appeared');
    // The window used to steal focus must be a different HWND from the approved
    // one, and must be this test's own fixture.
    expect(other.id).not.toBe(w.id);
    await focusAndSettle(other.id);

    // The driver's own backstop, below the TS approval layer: a request that
    // still names the FIRST window must be refused by Test-Target rather than
    // typed into whatever happens to be foreground. A fresh transport is used
    // precisely because this probe is about the driver, not the wrapper.
    const probe = new PowerShellTransport();
    try {
      await expect(
        probe.send({
          op: 'type',
          text: 'SHOULD-NOT-APPEAR',
          expected_hwnd: w.id,
          expected_pid: 0,
          expected_start_time: 0,
        }),
      ).rejects.toThrow(/target lost focus|foreground is/);
    } finally {
      await probe.dispose();
    }

    // Prove the refusal was real in BOTH directions. A sentinel is planted
    // first, so "nothing was typed" is observable: if leaked text had reached
    // the new foreground window, copying from it would replace the sentinel.
    clipWrite('SENTINEL-UNCHANGED');
    await focusAndSettle(other.id);
    await driver.press(['ctrl', 'a']);
    await driver.press(['ctrl', 'c']);
    expect(clipText()).not.toContain('SHOULD-NOT-APPEAR');

    // And the original fixture is still exactly what was typed.
    await focusAndSettle(w.id);
    await driver.press(['ctrl', 'a']);
    await driver.press(['ctrl', 'c']);
    expect(clipText()).toBe(PAYLOAD);
  }, 120_000);
});
