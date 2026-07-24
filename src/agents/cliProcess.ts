import { spawn, type ChildProcess } from 'child_process';
import { buildWindowsCmdShellInvocation, needsWindowsCmdShellWrap } from './windowsCmdShim';

export interface SpawnCliProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  stdin?: 'ignore' | 'pipe';
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
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
export function terminateCliProcessTree(proc: ChildProcess): Promise<void> {
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
      try {
        proc.kill('SIGTERM');
      } catch {
        finish();
        return;
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // The process likely exited during the grace period.
        }
      }, 5000);
    }
    setTimeout(finish, 6000);
  });
}
