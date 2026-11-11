import { CodexDiscovery } from '../agentMesh/codexDiscovery';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';

/**
 * Check that a linked Codex thread is still present before Forge queues work.
 *
 * A check launches one throwaway app-server and reads only the requested
 * thread. Concurrent asks for the same (executable, cwd, sessionId) share that
 * read, and a positive result is reused for 30 seconds. Negative answers and
 * errors are checked again on the next ask.
 */
export async function codexThreadIsLive(
  sessionId: string,
  options: { codexCli?: string; cwd: string; timeoutMs?: number },
): Promise<boolean> {
  const executable = await resolveCliExecutable(options.codexCli ?? 'codex', 'codex');
  const key = `${executable}\u0000${options.cwd}\u0000${sessionId}`;
  if (hasCachedPositive(key)) return true;
  const running = inFlight.get(key);
  if (running) return running;
  const started = startReadThread(executable, options.cwd, sessionId, options.timeoutMs ?? 8_000);
  inFlight.set(key, started);
  try {
    const live = await started;
    if (live) positiveThreadCache.set(key, Date.now() + POSITIVE_CACHE_MS);
    return live;
  } finally {
    if (inFlight.get(key) === started) inFlight.delete(key);
  }
}

const POSITIVE_CACHE_MS = 30_000;

/** Positive thread observations are short-lived and scoped to one thread check. */
const positiveThreadCache = new Map<string, number>();

/** One thread read at a time per executable, folder and session. */
const inFlight = new Map<string, Promise<boolean>>();

function hasCachedPositive(key: string): boolean {
  const expiresAt = positiveThreadCache.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    positiveThreadCache.delete(key);
    return false;
  }
  return true;
}

function startReadThread(
  executable: string,
  cwd: string,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const discovery = new CodexDiscovery({ executable, cwd, timeoutMs });
  return discovery.readThread(sessionId);
}
