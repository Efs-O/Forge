import { CodexDiscovery } from '../agentMesh/codexDiscovery';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';

/** Check that a linked Codex thread is still present before Forge queues work. */
export async function codexThreadIsLive(
  sessionId: string,
  options: { codexCli?: string; cwd: string; timeoutMs?: number },
): Promise<boolean> {
  const executable = await resolveCliExecutable(options.codexCli ?? 'codex', 'codex');
  const discovery = new CodexDiscovery({
    executable,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 8_000,
  });
  const { threads } = await discovery.discover();
  return threads.some((thread) => thread.id === sessionId);
}
