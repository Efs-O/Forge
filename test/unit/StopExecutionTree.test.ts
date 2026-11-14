import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import {
  BackgroundRegistry,
  type BackgroundRegistryDeps,
} from '../../src/tools/backgroundRegistry';

/**
 * `stop_execution` claims the job is stopped. Tonight (2026-11-14) a stopped CI
 * run reported `terminated` while its `npm`, `ci-lock` and `vitest` children kept
 * running for six more minutes, holding the CI lock and starving the retry. These
 * tests pin what the claim is allowed to mean: after `stop` returns, neither the
 * direct child nor a grandchild it forked is still running.
 */

const root = path.join(process.cwd(), '.test-tmp', 'stop-tree');

function deps(): BackgroundRegistryDeps {
  return {
    isAlive: () => true,
    processStartMsAsync: async () => 1234,
    killTree: async () => {},
    owner: { pid: process.pid, startedAt: 1234 },
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
  };
}

/** Alive means the OS can still open it: signal 0 asks without disturbing it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The direct child forks a grandchild, records its pid, then sits there. Killing
// the child must take the grandchild with it — that is the whole claim.
const PARENT_SCRIPT = [
  'const { spawn } = require("child_process");',
  'const fs = require("fs");',
  'const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 9000)"], { stdio: "ignore" });',
  'fs.writeFileSync(process.env.FORGE_TEST_PIDFILE, String(kid.pid));',
  'setInterval(() => {}, 1000);',
].join('\n');

describe('stop_execution kills the whole tree, not just the child', () => {
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('leaves no descendant running once stop returns', async () => {
    fs.mkdirSync(root, { recursive: true });
    const pidFile = path.join(root, 'grandchild.pid');
    const manager = new BackgroundExecutionManager(new BackgroundRegistry(root, deps()));
    const started = manager.start({
      command: process.execPath,
      args: ['-e', PARENT_SCRIPT],
      cwd: process.cwd(),
      env: { FORGE_TEST_PIDFILE: pidFile },
    });
    const childPid = started.pid;
    expect(typeof childPid).toBe('number');
    expect(alive(childPid as number)).toBe(true);

    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 15_000 });
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(alive(grandchildPid)).toBe(true);

    const stopped = await manager.stop(started.id);
    expect(stopped.status).toBe('terminated');

    // A Windows handle to a dead child can outlive the process, so give the OS a
    // moment to release it before deciding the claim was false.
    await vi.waitFor(() => expect(alive(childPid as number)).toBe(false), {
      timeout: 10_000,
      message: 'the direct child was still running after stop_execution',
    });
    await vi.waitFor(() => expect(alive(grandchildPid)).toBe(false), {
      timeout: 10_000,
      message: 'a grandchild survived stop_execution',
    });
  }, 60_000);

  /**
   * The shape that actually survived tonight: the shell is the direct child, and
   * everything that lived was a descendant of the shell, several levels down.
   * Git Bash is the shell the `shell` tool uses here, so this is the real case.
   */
  it('takes down a tree whose root is the shell itself', async () => {
    const bash =
      process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    if (!fs.existsSync(bash)) return; // no shell on this runner; the case above covers the kill
    fs.mkdirSync(root, { recursive: true });
    const pidFile = path.join(root, 'descendant.pid').replace(/\\/g, '/');
    const inner = [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setInterval(() => {}, 9000);',
    ].join('');
    const manager = new BackgroundExecutionManager(new BackgroundRegistry(root, deps()));
    const started = manager.start({
      command: bash,
      args: ['-c', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(inner)} & sleep 120`],
      cwd: process.cwd(),
    });

    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 20_000 });
    const descendant = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(descendant)).toBe(true);

    const stopped = await manager.stop(started.id);
    expect(stopped.status).toBe('terminated');

    await vi.waitFor(() => expect(alive(descendant)).toBe(false), {
      timeout: 10_000,
      message: `a descendant of the shell survived stop_execution (pid ${descendant})`,
    });
  }, 90_000);
});
