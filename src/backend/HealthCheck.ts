import type { ChildProcess } from 'child_process';

export interface HealthCheckOptions {
  baseUrl: string;
  intervalMs?: number;
  timeoutMs?: number;
}

export type HealthCheckResult =
  | { ok: true }
  | { ok: false; reason: 'timeout' | 'process_exit' | 'process_error' | 'error'; message: string };

/**
 * Polls GET /v1/models until the server responds 200 or a limit is reached.
 * Watches proc exit so we fail fast instead of waiting out the full timeout.
 */
export async function waitForHealthy(
  opts: HealthCheckOptions,
  proc?: ChildProcess,
  signal?: AbortSignal,
): Promise<HealthCheckResult> {
  const { baseUrl, intervalMs = 1000, timeoutMs = 120_000 } = opts;
  const url = `${baseUrl}/v1/models`;
  const deadline = Date.now() + timeoutMs;

  return new Promise<HealthCheckResult>((resolve) => {
    let settled = false;

    function done(result: HealthCheckResult): void {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      resolve(result);
    }

    // Fail immediately if the process exits before we get healthy.
    if (proc) {
      proc.once('exit', (code) => {
        done({ ok: false, reason: 'process_exit', message: `llama-server exited with code ${code}` });
      });
      proc.once('error', (err) => {
        done({ ok: false, reason: 'process_error', message: err.message });
      });
    }

    if (signal) {
      signal.addEventListener('abort', () => {
        done({ ok: false, reason: 'error', message: 'Aborted' });
      });
    }

    const probe = async (): Promise<void> => {
      if (settled) return;
      if (Date.now() >= deadline) {
        done({ ok: false, reason: 'timeout', message: `No response from ${url} after ${timeoutMs}ms` });
        return;
      }
      try {
        const res = await fetch(url, { signal: signal ?? null });
        if (res.ok) done({ ok: true });
      } catch {
        // not ready yet — keep polling
      }
    };

    const ticker = setInterval(() => {
      void probe();
    }, intervalMs);
    void probe();
  });
}
