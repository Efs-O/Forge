/**
 * The Windows window count: what the probe answers, and what it does when
 * PowerShell does not answer.
 *
 * No test here spawns a real `pwsh`: every case injects the spawn-and-collect
 * function `RemoteWindowsProbe` calls (`spawnAndWait` in production, where the
 * timeout and the abort signal already terminate the process tree — see
 * `test/unit/ProcessSpawn*` and the `src/util/processSpawn.ts` owner row). What
 * these tests prove is that the probe hands the child a timeout **and** an abort
 * signal, that it clears both on `dispose()`, and that a probe which cannot
 * answer degrades to the window files instead of failing the switch that asked.
 *
 * The records the fake returns are real-shaped — pid, image name, class, title —
 * and carry **the same pid for every window**, because that is what the real
 * probe returns: every top-level window of one VS Code instance belongs to the
 * same main process, so the count cannot be joined to the window files by pid.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecCommandError } from '../../src/util/processSpawn';
import type { SpawnResult } from '../../src/util/processSpawn';
import {
  RemoteWindowsProbe,
  VSCODE_IMAGE_NAMES,
  WINDOWS_PROBE_SCRIPT,
  parseWindowLines,
  type ProbeSpawn,
} from '../../src/remote/RemoteWindowsProbe';
import { countOpenWindows, windowIdFor } from '../../src/remote/RemoteWindowRegistry';
import type { RemoteWindowRecord } from '../../src/remote/RemoteWindowRegistry';

const CALLS: Array<{ command: string; signal: AbortSignal; timeoutMs: number }> = [];

afterEach(() => {
  CALLS.length = 0;
});

/** A child that prints the lines the script prints and exits 0. */
function printed(...lines: string[]): ProbeSpawn {
  return async (command, _args, _cwd, timeoutMs, _env, signal) => {
    CALLS.push({ command, signal, timeoutMs });
    return {
      stdout: `${lines.join('\n')}\n`,
      stderr: '',
      stdoutDropped: 0,
      stderrDropped: 0,
      exitCode: 0,
    };
  };
}

/** A child that never answers: it ends only when its signal aborts or its own
 *  timeout expires, which is exactly the hang the plan says must be killed. */
function hanging(failOnTimeout = true): ProbeSpawn {
  return (command, _args, _cwd, timeoutMs, _env, signal) =>
    new Promise<SpawnResult>((resolve, reject) => {
      CALLS.push({ command, signal, timeoutMs });
      const timer = setTimeout(() => {
        if (failOnTimeout)
          reject(new ExecCommandError('timeout', command, `timed out after ${timeoutMs}ms`));
        else resolve({ stdout: '', stderr: '', stdoutDropped: 0, stderrDropped: 0, exitCode: 0 });
      }, timeoutMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ExecCommandError('cancelled', command, 'process cancelled'));
        },
        { once: true },
      );
    });
}

function windowLine(pid: number, image: string, title: string): string {
  return JSON.stringify({ pid, image, className: 'Chrome_WidgetWin_1', title });
}

function record(workspaceName: string, pid: number): RemoteWindowRecord {
  const host = { pid, startedAt: 1_700_000_000_000 };
  return {
    windowId: windowIdFor(host),
    host,
    workspaceId: `ws-${workspaceName}`,
    workspaceName,
    workspacePath: `N:\\${workspaceName}`,
    serving: false,
    writtenAt: 1_700_000_000_000,
  };
}

describe('RemoteWindowsProbe', () => {
  it('counts the windows the script printed, and counts an Insiders window too', async () => {
    const probe = new RemoteWindowsProbe({
      platform: 'win32',
      spawn: printed(
        // One pid, three windows: that is what the real probe returns.
        windowLine(27_124, 'Code', 'Forge - Visual Studio Code'),
        windowLine(27_124, 'Code - Insiders', 'Strata - Visual Studio Code - Insiders'),
        windowLine(27_124, 'Code', 'Media - Visual Studio Code'),
      ),
    });
    const outcome = await probe.count();
    expect(outcome.source).toBe('os');
    if (outcome.source !== 'os') return;
    expect(outcome.windows).toHaveLength(3);
    expect(outcome.windows.map((window) => window.pid)).toEqual([27_124, 27_124, 27_124]);
    expect(outcome.windows.map((window) => window.image)).toContain('Code - Insiders');
    expect(outcome.windows[0]).toMatchObject({ className: 'Chrome_WidgetWin_1' });
    // The filter the script applies is re-checked in the parser, so a fake that
    // reported some other program's window would not be counted as VS Code.
    expect(VSCODE_IMAGE_NAMES).toContain('Code - Insiders');
  });

  it('hands the child a timeout and an abort signal, and one probe serves two asks', async () => {
    const probe = new RemoteWindowsProbe({ platform: 'win32', spawn: printed() });
    const [first, second] = await Promise.all([probe.count(), probe.count()]);
    expect(first).toBe(second);
    expect(CALLS).toHaveLength(1);
    expect(CALLS[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(CALLS[0]!.timeoutMs).toBeGreaterThan(0);
    expect(CALLS[0]!.command).toBe('pwsh');
  });

  it('kills a hung pwsh at its timeout and degrades to the window files', async () => {
    const probe = new RemoteWindowsProbe({
      platform: 'win32',
      // Short, so the test measures the timeout path rather than waiting eight
      // seconds for the production value.
      timeoutMs: 40,
      spawn: hanging(),
    });
    const outcome = await probe.count();
    expect(outcome).toMatchObject({ source: 'unavailable' });
    expect(CALLS).toHaveLength(1);
    expect(CALLS[0]!.timeoutMs).toBe(40);
    // The cap check still answers: the count comes from the files, and the
    // message says that is what it counted.
    const count = countOpenWindows({
      read: {
        records: [record('Forge', 4_242_424), record('Strata', 4_141_414)],
        unreadable: 0,
        pruned: 0,
      },
      probe: outcome,
    });
    expect(count.total).toBe(2);
    expect(count.counted).toBe('files');
    expect(count.probeReason).toContain('timed out');
  });

  it('dispose stops a probe still running and refuses to start another', async () => {
    const probe = new RemoteWindowsProbe({ platform: 'win32', timeoutMs: 30_000, spawn: hanging() });
    const running = probe.count();
    // The child is still running when the window goes away: its signal is what
    // `spawnAndWait` uses to terminate the process tree.
    expect(CALLS).toHaveLength(1);
    expect(CALLS[0]!.signal.aborted).toBe(false);
    probe.dispose();
    expect(CALLS[0]!.signal.aborted).toBe(true);
    expect((await running).source).toBe('unavailable');
    // Nothing is spawned after the window is gone, and nothing waits.
    CALLS.length = 0;
    expect((await probe.count()).source).toBe('unavailable');
    expect(CALLS).toHaveLength(0);
    expect(probe.isDisposed()).toBe(true);
  });

  it('never spawns on another OS and says the count came from the files', async () => {
    const probe = new RemoteWindowsProbe({ platform: 'linux', spawn: printed() });
    const outcome = await probe.count();
    expect(outcome).toMatchObject({
      source: 'unavailable',
      reason: expect.stringContaining('cannot enumerate VS Code windows on linux'),
    });
    expect(CALLS).toHaveLength(0);
  });

  it('falls back to Windows PowerShell when pwsh is not on the machine', async () => {
    const probe = new RemoteWindowsProbe({
      platform: 'win32',
      spawn: async (command, _args, _cwd, timeoutMs, _env, signal) => {
        CALLS.push({ command, signal, timeoutMs });
        if (command === 'pwsh')
          throw new ExecCommandError('missing_executable', command, 'no such file');
        return {
          stdout: `${windowLine(1, 'Code', 'Forge')}\n`,
          stderr: '',
          stdoutDropped: 0,
          stderrDropped: 0,
          exitCode: 0,
        };
      },
    });
    const outcome = await probe.count();
    expect(outcome.source).toBe('os');
    if (outcome.source !== 'os') return;
    expect(outcome.windows).toHaveLength(1);
    expect(CALLS.map((call) => call.command)).toEqual(['pwsh', 'powershell']);
  });

  it('reports what PowerShell printed on stderr when it exits non-zero', async () => {
    const probe = new RemoteWindowsProbe({
      platform: 'win32',
      spawn: async (command, _args, _cwd, timeoutMs, _env, signal) => {
        CALLS.push({ command, signal, timeoutMs });
        return {
          stdout: '',
          stderr: 'Add-Type: compiler error CS1056',
          stdoutDropped: 0,
          stderrDropped: 0,
          exitCode: 1,
        };
      },
    });
    expect(await probe.count()).toMatchObject({
      source: 'unavailable',
      reason: expect.stringContaining('CS1056'),
    });
  });

  it('runs the enumeration through Add-Type with both image names and the Electron class', () => {
    // The script is the product here: a filter that silently dropped Insiders,
    // or counted every top-level window on the desktop, would look correct until
    // somebody read a number off it.
    expect(WINDOWS_PROBE_SCRIPT).toContain('Add-Type');
    expect(WINDOWS_PROBE_SCRIPT).toContain('EnumWindows');
    expect(WINDOWS_PROBE_SCRIPT).toContain('GetWindowThreadProcessId');
    expect(WINDOWS_PROBE_SCRIPT).toContain('Chrome_WidgetWin_1');
    expect(WINDOWS_PROBE_SCRIPT).toContain('IsWindowVisible');
    expect(WINDOWS_PROBE_SCRIPT).toContain('"Code - Insiders"');
    expect(WINDOWS_PROBE_SCRIPT).toContain('"Code"');
  });
});

describe('parseWindowLines', () => {
  it('skips anything that is not a window record or not a VS Code window', () => {
    const windows = parseWindowLines(
      [
        'Add-Type compiled.',
        windowLine(1, 'Code', 'Forge'),
        'not json at all',
        '{"pid":"2","image":"Code"}',
        windowLine(3, 'chrome', 'Some other app'),
        windowLine(4, 'Code - Insiders', 'Insiders'),
        '',
      ].join('\n'),
    );
    expect(windows.map((window) => window.title)).toEqual(['Forge', 'Insiders']);
    expect(windows.map((window) => window.pid)).toEqual([1, 4]);
  });

  it('keeps a title that contains quotes and braces, because the script JSON-escapes it', () => {
    const line = JSON.stringify({
      pid: 7,
      image: 'Code',
      className: 'Chrome_WidgetWin_1',
      title: 'say "hi" { } \\ ',
    });
    expect(parseWindowLines(line)[0]!.title).toBe('say "hi" { } \\ ');
  });
});
