/**
 * The summarizer's request shape.
 *
 * Every assertion here is a measured decision, not a preference: the minimal
 * system prompt scored 1.00 written-file recall against the agent persona's
 * 0.81 with zero fabricated paths, and `max_tokens` must clear the reasoning
 * reserve because thinking spends from the same budget as the prose.
 * See COMPACTION_SUMMARIZER_REQUEST_PLAN.md.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatCompletionRequest } from '../../src/llm/types';
import type { ForgeConfig } from '../../src/config/types';
import type { IBackendPool } from '../../src/backend/BackendPool';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runPromptToMarkdown, type PromptRunContext } from '../../src/sidebar/PromptRun';

const config = (): ForgeConfig =>
  ({
    active_model: 'picker-default',
    models: [
      {
        name: 'picker-default',
        provider: 'llama.cpp',
        extra_llama_server_args: ['--reasoning-budget', '3072'],
      },
      { name: 'pinned', provider: 'llama.cpp', extra_llama_server_args: ['--reasoning-budget', '1024'] },
    ],
  }) as unknown as ForgeConfig;

let sent: ChatCompletionRequest;
let reply: string;

const pool = {
  acquire: async () => ({
    isReady: () => true,
    start: async () => undefined,
    loadedModel: () => 'm',
    baseUrl: () => 'http://127.0.0.1:8080',
  }),
} as unknown as IBackendPool;

const ctx = (): PromptRunContext => ({
  getConfig: config,
  pool,
  events: {},
  templateEngine: {
    render: (name: string) =>
      name === 'summarize' ? '  You compress a conversation.  ' : 'You are Forge, an agent.',
  } as unknown as PromptRunContext['templateEngine'],
  setController: () => undefined,
  releaseController: () => undefined,
});

beforeEach(() => {
  reply = 'ok';
  streamModelChatCompletion.mockImplementation(
    (_url: string, request: ChatCompletionRequest, _model: unknown, handlers: any) => {
      sent = request;
      handlers.onToken(reply);
      handlers.onDone();
    },
  );
});

describe('runPromptToMarkdown options', () => {
  it('leaves existing callers untouched: default model, persona, 4096 max_tokens', async () => {
    await runPromptToMarkdown(ctx(), 'review this');

    expect(sent.model).toBe('picker-default');
    expect(sent.max_tokens).toBe(4096);
    expect(sent.messages[0]?.content).toContain('You are Forge');
  });

  it('adds the reasoning reserve on top of the requested output room', async () => {
    await runPromptToMarkdown(ctx(), 'summarize', 'c1', { outputTokens: 2048 });

    // 3072 reserve + 2048 prose. Subtracting instead would shrink the answer
    // twice and is what produced empty summaries on thinking models.
    expect(sent.max_tokens).toBe(5120);
  });

  it('serves the run from the requested model, not the picker default', async () => {
    await runPromptToMarkdown(ctx(), 'summarize', 'c1', {
      modelName: 'pinned',
      outputTokens: 2048,
    });

    expect(sent.model).toBe('pinned');
    expect(sent.max_tokens).toBe(3072); // 1024 reserve + 2048
  });

  it('sends the rendered template as the only system message', async () => {
    await runPromptToMarkdown(ctx(), 'summarize', 'c1', { systemPromptTemplate: 'summarize' });

    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You compress a conversation.' });
    expect(sent.messages).toHaveLength(2);
  });

  it('fails loudly rather than silently reinstating the agent persona', async () => {
    const bare = { ...ctx(), templateEngine: undefined };

    await expect(
      runPromptToMarkdown(bare, 'summarize', 'c1', { systemPromptTemplate: 'summarize' }),
    ).rejects.toThrow(/summarize/);
  });

  it('strips an inline think block even when the model does not opt in', async () => {
    reply = '<think>weighing it up</think>Goal: ship it';

    const out = await runPromptToMarkdown(ctx(), 'summarize', 'c1', { alwaysStripThinking: true });

    expect(out).not.toContain('weighing it up');
    expect(out).toContain('Goal: ship it');
  });
});
