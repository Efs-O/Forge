import { describe, expect, it, vi } from 'vitest';
import { makeAskAgentTool } from '../../src/tools/askAgentTool';
import type { ForgeConfig } from '../../src/config/types';

describe('ask_agent request boundary', () => {
  const tool = makeAskAgentTool({
    getConfig: () => ({ agent_bus: { enabled: true } } as ForgeConfig),
    workspaceRoot: () => 'C:/repo',
    runtime: {
      openPanel: vi.fn(async () => 'unavailable'),
      isLive: vi.fn(async () => false),
      sendLive: vi.fn(async () => ({ status: 'failed', finalText: '' })),
      runHeadless: vi.fn(async () => ({ status: 'failed', finalText: '' })),
    },
  });

  it('rejects unknown agent kinds', async () => {
    await expect(tool.handler({ agent: 'local', message: 'review' })).rejects.toThrow();
  });

  it('rejects undeclared fields', async () => {
    await expect(
      tool.handler({ agent: 'claude', message: 'review', target: 'codex' }),
    ).rejects.toThrow();
  });
});
