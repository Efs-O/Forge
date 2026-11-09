import { describe, expect, it, vi } from 'vitest';
import { makeAskAgentTool } from '../../src/tools/askAgentTool';
import { MAX_QUESTION_CHARS } from '../../src/agentBus/liveSessionLimit';
import type { ForgeConfig } from '../../src/config/types';
import { ToolRegistry, type ToolHandlerContext } from '../../src/tools/ToolRegistry';
import { toolErrorText } from '../../src/tools/toolErrorText';

describe('ask_agent request boundary', () => {
  const start = vi.fn(async () => 'Asked Claude (exchange ab12cd34).');
  const tool = makeAskAgentTool({
    getConfig: () => ({ agent_bus: { enabled: true } }) as ForgeConfig,
    getStarter: () => start,
  });
  const context = { conversation: { id: 'chat-1' } } as unknown as ToolHandlerContext;

  it('formats wrong and missing agent values through toolErrorText', async () => {
    async function refusal(args: Record<string, unknown>): Promise<string> {
      try {
        await tool.handler(args, context);
      } catch (error) {
        return toolErrorText('ask_agent', error, args);
      }
      throw new Error('Expected ask_agent to reject invalid agent arguments.');
    }

    await expect(refusal({ agent: 'local', message: 'review' })).resolves.toBe(
      'Error: ask_agent agent must be one of "claude", "codex", "copilot"; received "local".',
    );
    await expect(refusal({ message: 'review' })).resolves.toBe(
      'Error: ask_agent agent must be one of "claude", "codex", "copilot"; received <missing>.',
    );
  });

  it('names the advertised values when ToolRegistry rejects a missing agent before the handler', () => {
    expect(new ToolRegistry().invalidArgs(tool, { message: 'review' })).toBe(
      'Error: ask_agent is missing required argument "agent" (one of: claude, codex, copilot). ' +
        'Resend the call with it set.',
    );
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
    expect(description).toBe(
      'Ask the Claude, Codex, or Copilot session linked to this chat; a missing link creates one. Returns at once; reply arrives here as a message. Keep working; do not ask again. If blocked, end your turn; reply starts a new one. Do not edit files you asked it to change. For local/cloud models, use ask_local_agent.',
    );
    expect(description).toContain(
      'Ask the Claude, Codex, or Copilot session linked to this chat; a missing link creates one.',
    );
    expect(description).not.toContain('`claude` is Claude Code');
    expect(description).not.toContain('Codex CLI');
    expect(description).not.toContain('Copilot CLI');
    expect(description).toContain('Returns at once; reply arrives here as a message');
    expect(description).toContain('do not ask again');
    const agent = tool.definition.function.parameters?.properties['agent'];
    expect(agent?.enum).toEqual(['claude', 'codex', 'copilot']);
    expect(agent?.description).toContain('`claude` is Claude Code');
    expect(agent?.description).toContain('`codex` is Codex CLI');
    expect(agent?.description).toContain('`copilot` is Copilot CLI');
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
