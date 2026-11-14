import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { terminateProcessTree } from '../../src/agents/cliProcess';
import { runShellInForeground } from '../../src/tools/execHelpers';
import { ShellOutputCollector } from '../../src/tools/shellOutput';
import {
  keeperIsReady,
  protectProcessTree,
  shutdownJobKeeper,
} from '../../src/util/windowsJobKeeper';
import { removeTreeWhenFree } from '../support/removeTempTree';

/**
 * The end-to-end proof for lab BUG-27, on Windows only: a background command's
 * own child survives `taskkill /PID <pid> /T /F` when its creator exited first
 * (Git Bash's `fork()` runs a forker that creates the child and dies, so the
 * kernel's parent link points at a dead pid), and a job object does not care.
 *
 * The control arm asserts the defect is still observable. Without it, an arm
 * that passes because the OS behaved differently would certify nothing.
 */

const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const runsHere = process.platform === 'win32' && fs.existsSync(bash);
const maybe = runsHere ? describe : describe.skip;

/** Sleep durations this file owns, so the survivor is findable by its argument. */
const CONTROL_SLEEP = 47;
const GUARDED_SLEEP = 48;
const FIRST_COMMAND_SLEEP = 49;
const leftovers: number[] = [];

/** The `sleep.exe` processes this test started, as `pid ppid` lines. */
function descendants(sleepSeconds: number): string[] {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" ` +
    `| Where-Object { $_.CommandLine -like '* ${String(sleepSeconds)}' } ` +
    '| ForEach-Object { "{0} ppid={1}" -f $_.ProcessId, $_.ParentProcessId }';
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function startCommand(sleepSeconds: number): ChildProcess {
  // `&& echo late` matters: a bare `sleep N` as the whole `-c` string is exec'd
  // in place, so sleep becomes the bash process itself instead of a child of
  // the forker, and the escape BUG-27 is about disappears from the test.
  return spawn(
    bash,
    ['--noprofile', '--norc', '-c', `sleep ${String(sleepSeconds)} && echo late`],
    { stdio: 'ignore', windowsHide: true },
  );
}

async function waitForDescendant(sleepSeconds: number, timeoutMs = 8_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = descendants(sleepSeconds);
    if (found.length > 0) return found;
    if (Date.now() > deadline) {
      throw new Error(`the command never produced a grandchild (sleep ${String(sleepSeconds)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForGone(sleepSeconds: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (descendants(sleepSeconds).length === 0) return;
    if (Date.now() > deadline) return; // the caller asserts
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

afterAll(() => {
  shutdownJobKeeper();
  for (const pid of leftovers) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      /* Already gone. */
    }
  }
});

maybe('a stopped command and its whole tree', () => {
  it('control: taskkill alone leaves the grandchild running (the defect)', async () => {
    const child = startCommand(CONTROL_SLEEP);
    const found = await waitForDescendant(CONTROL_SLEEP);
    leftovers.push(...found.map((line) => Number(line.split(' ')[0])));
    expect(found.length).toBeGreaterThan(0);

    await terminateProcessTree(child);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const still = descendants(CONTROL_SLEEP);
    // BUG-27: this is the survivor. If the OS ever fixes the parent walk, this
    // assertion is the signal that the control no longer proves anything.
    expect(still.length, `expected ${JSON.stringify(found)} to survive taskkill`).toBeGreaterThan(
      0,
    );
  }, 90_000);

  it('job object: the same stop terminates the grandchild too', async () => {
    // The keeper starts lazily and costs about 270 ms cold, while Git Bash
    // reaches its first fork about 140 ms after the spawn, so the first
    // protected command in a window is not covered. Warm it up for this arm.
    const warmup = spawn('ping.exe', ['-n', '3', '127.0.0.1'], { stdio: 'ignore' });
    protectProcessTree(warmup);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const child = startCommand(GUARDED_SLEEP);
    protectProcessTree(child);
    const found = await waitForDescendant(GUARDED_SLEEP);
    leftovers.push(...found.map((line) => Number(line.split(' ')[0])));

    await terminateProcessTree(child);
    await waitForGone(GUARDED_SLEEP);
    expect(
      descendants(GUARDED_SLEEP),
      'the job object must take the survivor with it',
    ).toHaveLength(0);
  }, 90_000);

  /**
   * The case a user hits first: the very first command a window protects. The
   * keeper is cold and costs about 270 ms, while Git Bash forks 141 ms after a
   * spawn, so a command spawned into that window joins nothing and its child
   * outlives the stop. Measured live on 2026-11-14 in a freshly opened window:
   * the first `sleep 150 && echo late` leaked, the second did not. The spawn
   * path now warms the keeper before it spawns, so this arm has to be clean.
   */
  it('the first command a window protects is covered too', async () => {
    shutdownJobKeeper();
    await vi.waitFor(() => expect(keeperIsReady()).toBe(false), { timeout: 5_000 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-first-cmd-'));
    const collector = new ShellOutputCollector(
      'first-cmd',
      'call-1',
      500,
      path.join(root, 'spill'),
    );
    try {
      // A short timeout, so the foreground path has to kill the tree itself.
      const finished = await runShellInForeground(
        bash,
        ['--noprofile', '--norc', '-c', `sleep ${String(FIRST_COMMAND_SLEEP)} && echo late`],
        process.cwd(),
        1_200,
        {},
        undefined,
        collector,
      );
      expect(finished.timedOut).toBe(true);
      leftovers.push(...descendants(FIRST_COMMAND_SLEEP).map((line) => Number(line.split(' ')[0])));
      await waitForGone(FIRST_COMMAND_SLEEP);
      expect(
        descendants(FIRST_COMMAND_SLEEP),
        'the first protected command left its child running',
      ).toHaveLength(0);
    } finally {
      await removeTreeWhenFree(root);
    }
  }, 90_000);
});
