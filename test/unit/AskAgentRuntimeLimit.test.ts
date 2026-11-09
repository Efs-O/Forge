import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAskAgentRuntime } from '../../src/agentLinks/askAgentRuntime';
import { codexThreadIsLive } from '../../src/agentLinks/codexThreadLiveness';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import { AgentLinksConfigSchema } from '../../src/config/agentBusSchema';
import type { ForgeConfig } from '../../src/config/types';
import type { AgentLink } from '../../src/agentLinks/chatAgentLinks';

vi.mock('../../src/agentBus/agentBus', () => ({
  busPaths: () => ({ root: '/bus', inbox: '/bus/inbox', outbox: '/bus/outbox', endpoint: '/bus/endpoint', script: '/bus/forge.sh' }),
  clearExchange: vi.fn(),
  ensureBus: vi.fn(),
  newBusId: () => 'fg-test-exchange',
  replyFile: (_paths: unknown, id: string) => `/bus/outbox/${id}-reply.md`,
  waitForReply: vi.fn(async () => undefined),
  withdrawQuestion: vi.fn(),
  writeQuestion: vi.fn(),
}));
vi.mock('../../src/agentBus/codexDelivery', () => ({
  codexMessage: vi.fn(() => 'message'),
  queueToCodex: vi.fn(async () => undefined),
}));
vi.mock('../../src/agentLinks/codexThreadLiveness', () => ({
  codexThreadIsLive: vi.fn(),
}));

const codexLink: AgentLink = {
  kind: 'codex',
  sessionId: '01a1ab00-0000-4000-8000-000000000000',
  cwd: 'C:/repo',
  title: 'Forge · Codex',
  linkedAt: 1,
  lastUsedAt: 1,
  origin: 'forge-created',
};

function codexConfig(configOverrides: Record<string, unknown> = {}): ForgeConfig {
  return {
    agent_bus: { enabled: true, codex_cli: process.execPath },
    agent_links: AgentLinksConfigSchema.parse(configOverrides),
  } as ForgeConfig;
}

function codexRuntime(config: ForgeConfig) {
  return makeAskAgentRuntime({
    getConfig: () => config,
    driver: { run: vi.fn() } as unknown as CliAgentDriver,
  });
}

beforeEach(() => {
  vi.mocked(codexThreadIsLive).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

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

  it('uses the 15-second default so a stubbed 10-second Codex check counts as live', async () => {
    vi.useFakeTimers();
    vi.mocked(codexThreadIsLive).mockImplementation(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10_000)),
    );
    const runtime = codexRuntime(codexConfig());
    const checking = runtime.isLive('codex', codexLink);
    vi.advanceTimersByTime(10_000);
    await expect(checking).resolves.toBe(true);
    expect(AgentLinksConfigSchema.parse({}).codex_liveness_timeout_ms).toBe(15_000);
    expect(codexThreadIsLive).toHaveBeenCalledWith(
      codexLink.sessionId,
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('passes an agent_links Codex liveness timeout override to discovery', async () => {
    vi.mocked(codexThreadIsLive).mockResolvedValue(true);
    const runtime = codexRuntime(codexConfig({ codex_liveness_timeout_ms: 25_000 }));
    await expect(runtime.isLive('codex', codexLink)).resolves.toBe(true);
    expect(codexThreadIsLive).toHaveBeenCalledWith(
      codexLink.sessionId,
      expect.objectContaining({ timeoutMs: 25_000 }),
    );
  });

  it('names the Codex thread and exchange when a live ask times out', async () => {
    const runtime = makeAskAgentRuntime({
      getConfig: () => codexConfig(),
      driver: { run: vi.fn() } as unknown as CliAgentDriver,
      waitLimitMs: 1,
    });
    const result = await runtime.sendLive(
      'codex',
      codexLink,
      'review',
      new AbortController().signal,
    );
    expect(result.status).toBe('timed_out');
    expect(result.error).toBe(
      'The linked Codex thread 01a1ab00-0000-4000-8000-000000000000 did not reply before the wait limit (exchange fg-test-exchange).',
    );
  });
});
