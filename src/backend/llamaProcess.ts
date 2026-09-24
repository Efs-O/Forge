import { spawn, type ChildProcess } from 'child_process';

/** taskkill's exit code for "no such process". */
const TASKKILL_NOT_FOUND = 128;

/** Teardown failed: the caller must retain the process and its reserved port. */
export class LlamaTerminationError extends Error {}

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
 * - Windows: taskkill /T /F while the parent still identifies its process tree.
 * - POSIX: `SIGTERM`, then `SIGKILL` after a 5 s grace period.
 * Rejects on failed termination or deadline expiry; callers retain ownership.
 */
export function killLlamaProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let killer: ChildProcess | undefined;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      proc.removeListener('exit', onExit);
      proc.removeListener('error', onError);
      if (err) reject(new LlamaTerminationError(err.message));
      else resolve();
    };
    let parentExited = false;
    let notFound = false;
    const onExit = (): void => {
      parentExited = true;
      // On Windows the parent exiting alone does not confirm tree teardown —
      // unless taskkill already reported the PID gone (see TASKKILL_NOT_FOUND).
      if (!killer || notFound) finish();
    };
    const onError = (err: Error): void => finish(err);
    const deadline = setTimeout(
      () => finish(new Error(`llama-server ${proc.pid ?? '?'} did not stop within 6 seconds.`)),
      6000,
    );
    proc.once('exit', onExit);
    proc.once('error', onError);

    if (process.platform === 'win32' && proc.pid) {
      try {
        killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      killer.once('exit', (code) => {
        // A server that exited on its own (a crash) between the check above and
        // taskkill is "not found". That is a stopped server, not a failed
        // teardown — but only once its own exit is seen, so a reused PID or a
        // parent still running is never mistaken for one.
        if (code === TASKKILL_NOT_FOUND) {
          notFound = true;
          if (parentExited) finish();
          return;
        }
        finish(
          code === 0
            ? undefined
            : new Error(`taskkill failed for llama-server ${proc.pid}: exit ${code}.`),
        );
      });
      killer.once('error', onError);
    } else {
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (settled) return;
      escalation = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }, 5000);
    }
  });
}
