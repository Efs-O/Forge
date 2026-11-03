import { describe, expect, it, vi } from 'vitest';
import { makeAskAgentRuntime } from '../../src/agentLinks/askAgentRuntime';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import type { ForgeConfig } from '../../src/config/types';

function headlessRun(waitLimitMs?: number) {
  const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'ok' }));
  const runtime = makeAskAgentRuntime({
    // An existing absolute path, so the CLI resolver accepts it as is.
    getConfig: () =>
      ({ agent_bus: { enabled: true, claude_cli: process.execPath } }) as ForgeConfig,
    driver: { run } as unknown as CliAgentDriver,
    ...(waitLimitMs ? { waitLimitMs } : {}),
  });
  return { run, runtime };
}

describe('ask_agent runtime wait limit', () => {
  const request = {
    agent: 'claude' as const,
    link: {
      kind: 'claude' as const,
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: 'C:/repo',
      title: 'Forge · claude',
      linkedAt: 1,
      lastUsedAt: 1,
      origin: 'forge-created' as const,
    },
    prompt: 'review',
    sessionTitle: 'Forge · claude',
    signal: new AbortController().signal,
    onSessionId: vi.fn(),
  };

  it('passes the limit to the headless CLI run', async () => {
    const { run, runtime } = headlessRun(30 * 60_000);
    expect(await runtime.runHeadless(request)).toEqual({ status: 'completed', finalText: 'ok' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30 * 60_000 }));
  });

  it('leaves the CLI driver its own default when no limit is set', async () => {
    const { run, runtime } = headlessRun();
    await runtime.runHeadless(request);
    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({ timeoutMs: expect.anything() }));
  });
});
