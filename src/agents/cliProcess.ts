import { spawn, type ChildProcess } from 'child_process';
import { buildWindowsCmdShellInvocation, needsWindowsCmdShellWrap } from './windowsCmdShim';

export interface SpawnCliProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  stdin?: 'ignore' | 'pipe';
  /** Variables layered over the inherited environment. */
  env?: Readonly<Record<string, string>>;
}

export interface CliProcessExit {
  code: number | null;
  error?: Error;
}

/**
 * Spawns an already-resolved CLI executable. npm-installed CLI `.cmd` shims
 * require an explicit cmd.exe invocation on Windows; real executables are
 * spawned directly.
 */
export function spawnCliProcess(options: SpawnCliProcessOptions): ChildProcess {
  const wrap = process.platform === 'win32' && needsWindowsCmdShellWrap(options.executable);
  const invocation = wrap
    ? buildWindowsCmdShellInvocation(options.executable, [...options.args])
    : { file: options.executable, args: [...options.args] };
  return spawn(invocation.file, invocation.args, {
    cwd: options.cwd,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: make the child a process-group leader so terminateProcessTree can
    // signal the whole tree with process.kill(-pid). Without this, a CLI agent
    // that forks its own subprocesses leaves them running after the direct
    // child is killed. Windows kills via a taskkill /T job instead, so detached
    // is irrelevant there.
    ...(process.platform !== 'win32' ? { detached: true } : {}),
    ...(wrap ? { windowsVerbatimArguments: true } : {}),
  });
}

/** Resolves on the first process exit or spawn error. */
export function waitForCliProcessExit(proc: ChildProcess): Promise<CliProcessExit> {
  return new Promise<CliProcessExit>((resolve) => {
    proc.once('exit', (code) => resolve({ code }));
    proc.once('error', (error) => resolve({ code: null, error }));
  });
}

/**
 * Terminates a Forge-owned CLI process tree. Windows uses best-effort kill()
 * followed by taskkill; POSIX sends SIGTERM then SIGKILL after a grace period.
 * Cleanup never waits longer than six seconds.
 */
export function terminateProcessTree(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.once('exit', finish);
    proc.once('error', finish);

    if (process.platform === 'win32' && proc.pid) {
      try {
        proc.kill();
      } catch {
        // Continue to taskkill, which may still be able to clean up children.
      }
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', () => setTimeout(finish, 250));
      killer.once('error', () => setTimeout(finish, 250));
    } else {
      // POSIX: signal the whole process group, not just the direct child. The
      // child is a group leader (spawned detached), so -pid reaches every
      // descendant it forked. If it is not a group leader (e.g. a child from
      // spawnAndWait, which does not detach), -pid matches no group and we fall
      // back to signalling the direct child, preserving the old behaviour.
      const pid = proc.pid;
      const signalTree = (sig: NodeJS.Signals): boolean => {
        if (pid !== undefined) {
          try {
            process.kill(-pid, sig);
            return true;
          } catch {
            // Not a group leader, or the group is already gone — fall through.
          }
        }
        try {
          proc.kill(sig);
          return true;
        } catch {
          // The process (and its group) already exited.
          return false;
        }
      };
      if (!signalTree('SIGTERM')) {
        finish();
        return;
      }
      setTimeout(() => signalTree('SIGKILL'), 5000);
    }
    setTimeout(finish, 6000);
  });
}

/** Backward-compatible name for CLI adapters. */
export const terminateCliProcessTree = terminateProcessTree;
