import { describe, expect, it, vi } from 'vitest';
import { makeAskAgentTool } from '../../src/tools/askAgentTool';
import { MAX_QUESTION_CHARS } from '../../src/agentBus/liveSessionLimit';
import type { ForgeConfig } from '../../src/config/types';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

describe('ask_agent request boundary', () => {
  const start = vi.fn(async () => 'Asked Claude (exchange ab12cd34).');
  const tool = makeAskAgentTool({
    getConfig: () => ({ agent_bus: { enabled: true } }) as ForgeConfig,
    getStarter: () => start,
  });
  const context = { conversation: { id: 'chat-1' } } as unknown as ToolHandlerContext;

  it('rejects unknown agent kinds', async () => {
    await expect(tool.handler({ agent: 'local', message: 'review' })).rejects.toThrow();
  });

  it('rejects undeclared fields', async () => {
    await expect(
      tool.handler({ agent: 'claude', message: 'review', target: 'codex' }),
    ).rejects.toThrow();
  });

  it('hands the ask to the starter and returns its answer without waiting for a reply', async () => {
    const result = await tool.handler(
      { agent: 'claude', message: 'review', subject: 'Plan' },
      context,
    );
    expect(result).toBe('Asked Claude (exchange ab12cd34).');
    expect(start).toHaveBeenCalledWith('chat-1', {
      agent: 'claude',
      message: 'review',
      subject: 'Plan',
    });
  });

  it('accepts a brief of 20,000 characters and refuses one character more', async () => {
    // The old ceiling was 6,000 and the chat c4dabce1 was refused three times in a
    // row under it (7,012 / 6,373 / 6,155 characters) before it shrank a brief
    // that a delegation needs in full. The two places that state the number —
    // this tool's schema and `agentBus/liveSessionLimit.ts` — must agree, or the
    // model pays to write a message the service then throws away.
    const started = vi.fn(async () => 'Asked Claude (exchange ab12cd34).');
    const tool = makeAskAgentTool({
      getConfig: () => ({ agent_bus: { enabled: true } }) as ForgeConfig,
      getStarter: () => started,
    });
    const turn = { conversation: { id: 'chat-1' } } as unknown as ToolHandlerContext;
    expect(await tool.handler({ agent: 'claude', message: 'x'.repeat(20000) }, turn)).toBe(
      'Asked Claude (exchange ab12cd34).',
    );
    await expect(
      tool.handler({ agent: 'claude', message: 'x'.repeat(20001) }, turn),
    ).rejects.toThrow();
    const properties = tool.definition.function.parameters
      ?.properties as Record<string, Record<string, unknown>>;
    expect(properties['message']?.['maxLength']).toBe(20000);
    expect(MAX_QUESTION_CHARS).toBe(20000);
  });

  it('tells the model the reply comes later and not to ask again', () => {
    const description = tool.definition.function.description;
    expect(description).toContain('Returns at once; the reply arrives later as a message here');
    expect(description).toContain('do not ask again');
  });

  it('refuses outside a chat turn and before the sidebar exists', async () => {
    expect(await tool.handler({ agent: 'claude', message: 'review' })).toMatch(/^Error:/u);
    const early = makeAskAgentTool({
      getConfig: () => ({ agent_bus: { enabled: true } }) as ForgeConfig,
      getStarter: () => undefined,
    });
    expect(await early.handler({ agent: 'claude', message: 'review' }, context)).toMatch(
      /^Error: ask_agent: the Forge sidebar is not ready/u,
    );
  });
});
