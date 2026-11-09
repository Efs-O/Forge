import { CodexDiscovery } from '../agentMesh/codexDiscovery';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';

/**
 * Check that a linked Codex thread is still present before Forge queues work.
 *
 * Every `ask_agent` to a linked Codex ran its own check, and each check spawns
 * a throwaway `codex app-server` process and lists every thread in it. Two asks
 * in one round therefore paid for the same answer twice, and the second one
 * timed out at 15 s while the first was still answering (lab run U2b,
 * 2026-11-09). One check per (executable, cwd, sessionId) is in flight at a
 * time: a second ask arriving while one runs awaits the same promise and spawns
 * nothing. Nothing is remembered once a check settles — a stale answer about
 * whether a thread is alive is worth less than the spawn it would save.
 */
export async function codexThreadIsLive(
  sessionId: string,
  options: { codexCli?: string; cwd: string; timeoutMs?: number },
): Promise<boolean> {
  const executable = await resolveCliExecutable(options.codexCli ?? 'codex', 'codex');
  const key = `${executable}\u0000${options.cwd}\u0000${sessionId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const started = checkOnce(executable, options.cwd, sessionId, options.timeoutMs ?? 8_000);
  inFlight.set(key, started);
  try {
    return await started;
  } finally {
    // Both the success and the failure path drop it: the next ask re-asks.
    if (inFlight.get(key) === started) inFlight.delete(key);
  }
}

/** The checks running right now, keyed by the executable, folder and thread they ask about. */
const inFlight = new Map<string, Promise<boolean>>();

async function checkOnce(
  executable: string,
  cwd: string,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const discovery = new CodexDiscovery({ executable, cwd, timeoutMs });
  const { threads } = await discovery.discover();
  return threads.some((thread) => thread.id === sessionId);
}
