import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signalWindowsTree } from '../../src/agents/cliProcess';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { BackgroundRegistry } from '../../src/tools/backgroundRegistry';
import {
  beginTreeStop,
  finishStoppedTree,
  protectProcessTree,
  protectedPids,
  releaseProtectedTree,
  shutdownJobKeeper,
  sweepProtectedTree,
} from '../../src/util/windowsJobKeeper';

/**
 * The protocol that makes `stop_execution` take a command's whole tree on
 * Windows (lab BUG-27). The keeper itself is PowerShell speaking Win32, so the
 * OS half is proved in `WindowsJobObjectKill.test.ts`; what lives here is the
 * ordering the fix depends on, which has to hold on every OS.
 */

let keeperDir = '';
let keeperLog = '';

function keeperLines(): string[] {
  try {
    return fs.readFileSync(keeperLog, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForLine(match: RegExp, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = keeperLines().find((line) => match.test(line));
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no keeper line matching ${match}; got: ${JSON.stringify(keeperLines())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A child that stays alive until the test ends it. */
function liveChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
}

async function stopChild(child: ChildProcess): Promise<void> {
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await gone;
}

beforeAll(() => {
  keeperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-job-keeper-'));
  keeperLog = path.join(keeperDir, 'commands.log');
  process.env.FORGE_JOB_KEEPER_CMD = path.join(
    process.cwd(),
    'test',
    'support',
    'fakeJobKeeper.cjs',
  );
  process.env.FORGE_JOB_KEEPER_LOG = keeperLog;
});

afterAll(() => {
  shutdownJobKeeper();
  delete process.env.FORGE_JOB_KEEPER_CMD;
  delete process.env.FORGE_JOB_KEEPER_LOG;
  fs.rmSync(keeperDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const pid of protectedPids()) sweepProtectedTree(pid);
  fs.rmSync(keeperLog, { force: true });
});

describe('the job keeper protocol', () => {
  it('asks for a job the moment a child is protected', async () => {
    const child = liveChild();
    try {
      protectProcessTree(child);
      expect(protectedPids()).toContain(child.pid);
      expect(await tokenFor(child.pid!)).toMatch(/^\d+$/u);
    } finally {
      await stopChild(child);
    }
  });

  it('releases the job when the command exits on its own, so its children live', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60)'], { stdio: 'ignore' });
    protectProcessTree(child);
    const token = await tokenFor(child.pid!);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const released = await waitForLine(new RegExp(`^release ${token}$`, 'u'));
    expect(released).toBe(`release ${token}`);
    expect(keeperLines().some((line) => line === `kill ${token}`)).toBe(false);
  });

  it('sweeps with kill semantics, and a later exit does not undo it', async () => {
    const child = liveChild();
    try {
      protectProcessTree(child);
      const token = await tokenFor(child.pid!);
      expect(sweepProtectedTree(child.pid)).toBe(true);
      expect(await waitForLine(new RegExp(`^kill ${token}$`, 'u'))).toBe(`kill ${token}`);
      // The child's own exit event fires the release path; the token is already
      // spent, so nothing must arrive that would undo the kill.
      await stopChild(child);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(keeperLines().some((line) => line === `release ${token}`)).toBe(false);
    } finally {
      if (!child.killed) child.kill();
    }
  });

  it('holds the job open between the begin and the finish, so the walk has a parent', async () => {
    const child = liveChild();
    try {
      protectProcessTree(child);
      const token = await tokenFor(child.pid!);
      expect(beginTreeStop(child.pid)).toBe(true);
      // Nothing is closed yet, so the keeper must not have been told to kill:
      // a kill here would take down the parent `taskkill /T` is about to walk.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(keeperLines().some((line) => line === `kill ${token}`)).toBe(false);
      expect(protectedPids()).toContain(child.pid as number);
      expect(finishStoppedTree(child.pid)).toBe(true);
      expect(await waitForLine(new RegExp(`^kill ${token}$`, 'u'))).toBe(`kill ${token}`);
      expect(finishStoppedTree(child.pid)).toBe(false);
      // The child's own exit event still reaches the release path; the token is
      // spent, so it must not arrive and undo the kill.
      await stopChild(child);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(keeperLines().some((line) => line === `release ${token}`)).toBe(false);
    } finally {
      if (!child.killed) child.kill();
    }
  });

  it('releases nothing twice for the same pid', async () => {
    const child = liveChild();
    try {
      protectProcessTree(child);
      protectProcessTree(child);
      const token = await tokenFor(child.pid!);
      expect(keeperLines().filter((line) => line.startsWith('job '))).toHaveLength(1);
      releaseProtectedTree(child.pid);
      releaseProtectedTree(child.pid);
      await waitForLine(new RegExp(`^release ${token}$`, 'u'));
      expect(keeperLines().filter((line) => line === `release ${token}`)).toHaveLength(1);
    } finally {
      await stopChild(child);
    }
  });

  it('retires the keeper once nothing is left protected, so an idle window pays nothing', async () => {
    const savedIdle = process.env.FORGE_JOB_KEEPER_IDLE_MS;
    process.env.FORGE_JOB_KEEPER_IDLE_MS = '40';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60)'], { stdio: 'ignore' });
    try {
      protectProcessTree(child);
      const token = await tokenFor(child.pid!);
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await waitForLine(new RegExp(`^release ${token}$`, 'u'));
      expect(await waitForLine(/^quit$/u, 5_000)).toBe('quit');
      expect(protectedPids()).toHaveLength(0);
    } finally {
      if (savedIdle === undefined) delete process.env.FORGE_JOB_KEEPER_IDLE_MS;
      else process.env.FORGE_JOB_KEEPER_IDLE_MS = savedIdle;
      child.kill();
    }
  });

  it('skips a child whose pid is not there, instead of starting a keeper for it', () => {
    // A stubbed spawn reports a pid that never existed. Asking the keeper to
    // protect it costs a PowerShell and a Win32 error for nothing.
    const stub = { pid: 2_100_000, once: () => stub } as unknown as ChildProcess;
    protectProcessTree(stub);
    expect(protectedPids()).not.toContain(2_100_000);
  });

  it('leaves the pid unprotected when there is no keeper to talk to', () => {
    if (process.platform === 'win32') return; // Windows always has PowerShell.
    const saved = process.env.FORGE_JOB_KEEPER_CMD;
    delete process.env.FORGE_JOB_KEEPER_CMD;
    const child = liveChild();
    try {
      protectProcessTree(child);
      expect(protectedPids()).not.toContain(child.pid);
    } finally {
      if (saved !== undefined) process.env.FORGE_JOB_KEEPER_CMD = saved;
      child.kill();
    }
  });
});

/** A `taskkill` child that answers with this exit code on the next tick. */
function fakeTaskkill(exitCode: number): ChildProcess {
  return {
    once: (event: string, fn: (arg?: unknown) => void) => {
      if (event === 'exit') setTimeout(() => fn(exitCode), 0);
      return fakeTaskkill(exitCode) as unknown as ChildProcess;
    },
  } as unknown as ChildProcess;
}

describe('the Windows stop path', () => {
  it('spends the job before taskkill and closes it only after taskkill returns', () => {
    const order: string[] = [];
    const killer = fakeTaskkill(0);
    const proc = {
      pid: 4242,
      kill: () => {
        order.push('proc.kill');
        return true;
      },
    } as unknown as ChildProcess;

    signalWindowsTree(proc, () => order.push('done'), {
      beginStop: (pid) => {
        order.push(`begin ${String(pid)}`);
        return true;
      },
      finishStop: (pid) => {
        order.push(`kill ${String(pid)}`);
        return true;
      },
      spawnTaskkill: (pid) => {
        order.push(`taskkill ${String(pid)}`);
        return killer;
      },
      settle: (done) =>
        setTimeout(() => {
          order.push('settle');
          done();
        }, 0),
    });

    // Closing the job before the walk is the bug: the kernel takes the recorded
    // parent with it, and the MSYS2 grandchild whose forker had already exited
    // is unreachable by parent link (lab BUG-27, caught by StopExecutionTree).
    expect(order).toEqual(['begin 4242', 'taskkill 4242']);
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(order).toEqual(['begin 4242', 'taskkill 4242', 'kill 4242', 'settle', 'done']);
        resolve();
      }, 50),
    );
  });

  it('still closes the job when taskkill reports failure', async () => {
    const killed: string[] = [];
    const killer = fakeTaskkill(1);
    const proc = {
      pid: 7,
      kill: () => {
        killed.push('proc.kill');
        return true;
      },
    } as unknown as ChildProcess;

    await new Promise<void>((resolve) =>
      signalWindowsTree(proc, resolve, {
        beginStop: vi.fn(),
        finishStop: vi.fn(),
        spawnTaskkill: () => killer,
        settle: (done) => setTimeout(done, 0),
      }),
    );
    expect(killed).toEqual(['proc.kill']);
  });

  it('closes the job when taskkill cannot start at all', async () => {
    const closed: Array<number | undefined> = [];
    const killer = {
      once: (event: string, fn: (arg?: unknown) => void) => {
        if (event === 'error') setTimeout(() => fn(new Error('ENOENT')), 0);
        return killer as unknown as ChildProcess;
      },
    } as unknown as ChildProcess;
    const proc = { pid: 9, kill: () => true } as unknown as ChildProcess;

    await new Promise<void>((resolve) =>
      signalWindowsTree(proc, resolve, {
        beginStop: vi.fn(),
        finishStop: (pid) => {
          closed.push(pid);
          return true;
        },
        spawnTaskkill: () => killer,
        settle: (done) => setTimeout(done, 0),
      }),
    );
    expect(closed).toEqual([9]);
  });
});

describe('a background execution', () => {
  it('is protected while it runs and swept when it is stopped', async () => {
    const root = path.join(process.cwd(), '.test-tmp', 'job-guard');
    fs.mkdirSync(root, { recursive: true });
    const registry = new BackgroundRegistry(root, {
      isAlive: () => true,
      processStartMsAsync: async () => 1234,
      killTree: async () => {},
      owner: { pid: process.pid, startedAt: 1234 },
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    });
    const manager = new BackgroundExecutionManager(registry);
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      cwd: process.cwd(),
    });
    try {
      expect(protectedPids()).toContain(started.pid);
      const token = await tokenFor(started.pid!);
      await manager.stop(started.id);
      expect(await waitForLine(new RegExp(`^kill ${token}$`, 'u'))).toBe(`kill ${token}`);
    } finally {
      await manager.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

/** The token the module gave this pid, recovered from the recorded `job` line. */
async function tokenFor(pid: number): Promise<string> {
  const line = await waitForLine(new RegExp(`^job \\d+ ${String(pid)}$`, 'u'));
  return line.split(' ')[1]!;
}
