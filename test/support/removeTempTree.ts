// Why this exists: a grep_search call that the caller cancels rejects as soon as
// the abort fires, but the child it spawned is only signalled at that moment. On
// Windows a directory cannot be removed while a process still lists it as its
// working directory, so the teardown that runs right after the assertion loses a
// race against a process exit that has not happened yet. `fs.rmSync`'s own
// `maxRetries` does not cover that error code, so the retries do nothing and the
// suite fails for a reason unrelated to the code under test.
//
// The boundary that actually ends the work is "nothing holds this directory any
// more", so wait for that, then remove it. The budget is bounded: a real leak is
// still reported, just after the child had its chance to exit.
import * as fs from 'fs';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const POLL_MS = 100;
const BUDGET_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Remove `dir` once no process is holding it, or throw after `BUDGET_MS`. */
export async function removeTreeWhenFree(dir: string): Promise<void> {
  const deadline = Date.now() + BUDGET_MS;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || Date.now() >= deadline) throw error;
      await sleep(POLL_MS);
    }
  }
}
