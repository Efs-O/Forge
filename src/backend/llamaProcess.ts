import { spawn, type ChildProcess } from 'child_process';

/**
 * Single launch point for a `llama-server` child process. Both `DirectBackend`
 * (chat) and `EmbeddingBackend` (semantic search) go through here so the spawn
 * and teardown logic lives in one place rather than being duplicated per backend
 * (CLAUDE.md: `llama-server` lifecycle is owned in one spot).
 */
export function spawnLlamaServer(binary: string, args: string[]): ChildProcess {
  return spawn(binary, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Gracefully terminate a spawned `llama-server` process.
 * - Windows: best-effort `proc.kill()`, then `taskkill /T /F` to take down the
 *   whole process tree.
 * - POSIX: `SIGTERM`, then `SIGKILL` after a 5 s grace period.
 * Resolves once the process exits or an overall 6 s deadline elapses, so callers
 * never hang on a wedged process.
 */
export function killLlamaProcess(proc: ChildProcess): Promise<void> {
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
        // ignore and fall through to taskkill
      }

      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
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
          // process likely already exited
        }
      }, 5000);
    }

    setTimeout(finish, 6000);
  });
}
