import * as fs from 'fs';

/**
 * Host-side wait (AGENT_MESH_PLAN §2b cost guard, M7).
 *
 * The *preferred* wait is host-side — a Forge-owned blocking read with a
 * deadline and cancellation — **not** an agent shell sleep loop (a promised
 * `bash` loop is a Windows portability dependency). This waits for a condition
 * (usually a verdict file, or a session reaching a state) without spending a
 * single model token, and stops on deadline or abort.
 *
 * The **cost guard** is the belt-and-braces rule for the *fallback* (a wait
 * loop that does spend model turns): after more than `maxEmptyTurns` turns with
 * no progress, stop and tell the user. The host-side wait below never trips it
 * (it makes zero model turns); the guard is exported so a fallback loop can
 * enforce the same bound.
 */

export interface WaitResult {
  satisfied: boolean;
  /** Resolved value when satisfied, else undefined. */
  value?: string;
  reason: 'satisfied' | 'timeout' | 'aborted';
}

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Wait until `probe()` returns a non-undefined value, or the deadline/abort.
 * The probe is called immediately, then every `pollMs`. A local file stat costs
 * nothing, so polling is the right tool here.
 */
export function waitHostSide(
  probe: () => string | undefined,
  options: WaitOptions,
): Promise<WaitResult> {
  const pollMs = options.pollMs ?? 1_000;
  const deadline = Date.now() + options.timeoutMs;
  return new Promise<WaitResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      resolve({ satisfied: false, reason: 'aborted' });
    };
    const step = (): void => {
      const value = probe();
      if (value !== undefined) {
        if (options.signal?.removeEventListener)
          options.signal.removeEventListener('abort', onAbort);
        resolve({ satisfied: true, value, reason: 'satisfied' });
        return;
      }
      if (options.signal?.aborted) {
        resolve({ satisfied: false, reason: 'aborted' });
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (options.signal?.removeEventListener)
          options.signal.removeEventListener('abort', onAbort);
        resolve({ satisfied: false, reason: 'timeout' });
        return;
      }
      timer = setTimeout(step, Math.min(pollMs, remaining));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    step();
  });
}

/**
 * Wait for a file to appear and return its contents (the verdict-file wait).
 * A file that exists is complete (writers rename a finished .tmp into place),
 * so the first read is the value.
 */
export function waitForFile(file: string, options: WaitOptions): Promise<WaitResult> {
  return waitHostSide(() => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }, options);
}

export const DEFAULT_MAX_EMPTY_TURNS = 5;

/**
 * The cost guard for a model-turn wait loop (the documented fallback for a
 * user-opened session with no host-side owner). Returns true when the loop has
 * done more than `maxEmptyTurns` empty turns and must stop and tell the user.
 */
export function exceededCostGuard(
  emptyTurns: number,
  maxEmptyTurns = DEFAULT_MAX_EMPTY_TURNS,
): boolean {
  return emptyTurns > maxEmptyTurns;
}
