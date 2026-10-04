/**
 * Bounded staged compaction: output budgeting through the real PromptRun,
 * length-stop recovery, source coverage, and synthetic 400k / 200k slots.
 * No live 400k model exists for these; they exercise the arithmetic only.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatCompletionRequest, ChatMessage } from '../../src/llm/types';
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
import { compactionBudget, planOutput } from '../../src/sidebar/compactionBudget';
import { summarizeCompaction } from '../../src/sidebar/compactionSummaryRunner';
import { renderStagedSource, summarizeInStages } from '../../src/sidebar/compactionStaging';

const config = (): ForgeConfig =>
  ({
    active_model: 'local',
    models: [
      {
        name: 'local',
        provider: 'llama.cpp',
        extra_llama_server_args: ['--reasoning-budget', '8192'],
        sampling: { max_tokens: 32768 },
      },
      {
        name: 'cloud',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8090',
        api_key_secret: 'k',
        sampling: { max_tokens: 32768 },
      },
    ],
  }) as unknown as ForgeConfig;

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
  secrets: { get: async () => 'key' } as never,
  templateEngine: { render: () => 'You compress a conversation.' } as never,
  setController: () => undefined,
  releaseController: () => undefined,
});

const note = (label: string): string =>
  `Goal: ${label}\nState: recorded\nNext: continue\nFiles: src/a.ts\nConstraints: none\nErrors: none\n${'detail. '.repeat(40)}`;

const requests: ChatCompletionRequest[] = [];
type Step = { reasoning?: number; text?: string; finish: string | null };
let steps: Step[] = [];

beforeEach(() => {
  requests.length = 0;
  steps = [];
  streamModelChatCompletion.mockImplementation(
    (_u: string, request: ChatCompletionRequest, _m: unknown, handlers: any) => {
      requests.push(request);
      const step = steps.shift() ?? { text: note('default'), finish: 'stop' };
      if (step.reasoning) handlers.onReasoning('t'.repeat(step.reasoning));
      if (step.text) handlers.onToken(step.text);
      handlers.onDone(step.finish ?? undefined);
    },
  );
});

const messages = (): ChatMessage[] => [
  { role: 'user', content: 'Fix the importer.' },
  { role: 'assistant', content: 'Found the bug in src/importer.ts.' },
  { role: 'user', content: 'Now add the test.' },
];

function input(model: string, reasoningTokens: number, outputLimitTokens: number) {
  return {
    messages: messages(),
    pinnedFacts: '',
    originalRequest: 'Fix the importer.',
    exactPendingAction: 'Now add the test.',
    modelName: model,
    modelMaxTokens: 200_000,
    outputLimitTokens,
    reasoningTokens,
    maximumSummaryChars: 20_000,
    conversationId: 'c1',
    runPrompt: (text: string, id: string, options: never) =>
      runPromptToMarkdown(ctx(), text, id, options),
  };
}

describe('output planning', () => {
  it('keeps room for thinking AND prose in max_tokens, counted once', () => {
    expect(planOutput(1_000, 8_000, 32_768)).toEqual({ outputTokens: 1_000, requestCap: 9_000 });
    expect(planOutput(30_000, 8_000, 32_768)).toEqual({ outputTokens: 24_768, requestCap: 32_768 });
    expect(planOutput(1_000, 40_000, 32_768)).toBeUndefined();
  });

  it('gives a model with no configured reserve the whole provider cap', () => {
    expect(planOutput(1_000, 0, 32_768)).toEqual({ outputTokens: 32_768, requestCap: 32_768 });
  });
});

describe('thinking-heavy summarization through the real PromptRun', () => {
  it('recovers from a real length stop by staging, with max_tokens above the reserve', async () => {
    // First request: thinking plus truncated prose, finish_reason=length.
    steps = [{ reasoning: 5_000, text: 'Goal: partial', finish: 'length' }];
    const run = await summarizeCompaction({
      ...input('local', 8_192, 32_768),
      previousSummary: undefined,
      recordedFacts: '',
      userContext: '',
      budget: compactionBudget(50_000, 100_000, 200_000, 8_192),
    });

    expect(run.method).toBe('staged');
    expect(run.calls).toBe(2); // the failed one-shot counts too
    for (const request of requests) {
      // Thinking alone can never consume the whole request.
      expect(request.max_tokens ?? 0).toBeGreaterThan(8_192 + 128);
      expect(request.max_tokens ?? 0).toBeLessThanOrEqual(32_768);
    }
  });

  it('never stores a nonempty length-stopped result as the sole evidence', async () => {
    steps = [
      { text: note('first'), finish: 'length' },
      { text: note('staged'), finish: null },
    ];
    await expect(
      summarizeCompaction({
        ...input('local', 8_192, 32_768),
        recordedFacts: '',
        userContext: '',
        budget: compactionBudget(50_000, 100_000, 200_000, 8_192),
      }),
    ).rejects.toThrow(/incomplete|trustworthy|finish/u);
  });

  it('sends a no-reserve model the whole provider cap so thinking cannot starve the note', async () => {
    const result = await summarizeInStages(input('cloud', 0, 32_768));
    expect(result.calls).toBe(1);
    expect(requests[0]?.max_tokens).toBe(32_768);
  });
});

describe('staged evidence manifest', () => {
  it('pins every recorded file identifier and every user request, or refuses', async () => {
    const result = await summarizeInStages({
      ...input('cloud', 0, 32_768),
      pinnedFacts: 'Files changed: src/importer.ts, test/importer.test.ts, package.json',
      runPrompt: async () => note('n'),
    });
    for (const id of ['src/importer.ts', 'test/importer.test.ts', 'package.json']) {
      expect(result.summary).toContain(id);
    }
    expect(result.summary).toContain('User request 1: Fix the importer.');
    expect(result.summary).toContain('User request 2: Now add the test.');

    await expect(
      summarizeInStages({
        ...input('cloud', 0, 32_768),
        maximumSummaryChars: 1_500,
        pinnedFacts: Array.from({ length: 80 }, (_, i) => `src/module${i}/file${i}.ts`).join(' '),
        runPrompt: async () => note('n'),
      }),
    ).rejects.toThrow(/previous context kept/u);
  });
});

describe('synthetic slots', () => {
  const big = (): ChatMessage[] =>
    Array.from({ length: 100 }, (_, i): ChatMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i === 0 ? 'SENTINEL-FIRST ' : i === 50 ? 'SENTINEL-MIDDLE ' : i === 99 ? 'SENTINEL-LAST ' : ''}${'x'.repeat(10_000)}`,
    }));

  it('covers a 1M-char source at a 400k slot with every interval examined exactly once', async () => {
    const prompts: string[] = [];
    const options: Array<{ outputTokens?: number }> = [];
    const messagesIn = big();
    const budget = compactionBudget(340_000, 850_000, 400_000, 8_192);
    expect(budget.policyTokens).toBe(340_000);
    expect(budget.replacementMaxChars).toBe(85_000); // 34k estimated tokens

    const result = await summarizeInStages({
      messages: messagesIn,
      pinnedFacts: '',
      originalRequest: 'orig',
      exactPendingAction: 'do X',
      modelMaxTokens: 400_000,
      outputLimitTokens: 65_536,
      reasoningTokens: 8_192,
      maximumSummaryChars: 80_000,
      conversationId: 'c1',
      runPrompt: async (text, _id, opts) => {
        prompts.push(text);
        options.push(opts);
        return note(`n${prompts.length}`);
      },
    });

    const covered = prompts
      .map((p) => p.slice(p.indexOf('SOURCE BEGIN\n') + 13, p.lastIndexOf('\nSOURCE END')))
      .join('');
    expect(covered).toBe(renderStagedSource(messagesIn));
    expect(covered).toContain('SENTINEL-FIRST');
    expect(covered).toContain('SENTINEL-MIDDLE');
    expect(covered).toContain('SENTINEL-LAST');
    expect(result.sourceChunks).toBeLessThanOrEqual(24);
    expect(result.summary.length).toBeLessThanOrEqual(80_000);
    expect(result.summary).toContain('Next: do X');
    // Allocation comes from the whole summary budget, not a fixed 2,500 chars.
    expect(Math.max(...options.map((o) => o.outputTokens ?? 0))).toBeGreaterThan(1_000);
    expect(result.requestedGenerationTokens).toBeLessThanOrEqual(400_000);
  });

  it('refuses without a call when the source needs more chunks than the bound', async () => {
    const runPrompt = vi.fn();
    await expect(
      summarizeInStages({
        messages: [{ role: 'user', content: 'y'.repeat(6_000_000) }],
        pinnedFacts: '',
        originalRequest: 'orig',
        exactPendingAction: 'do X',
        modelMaxTokens: 400_000,
        outputLimitTokens: 65_536,
        reasoningTokens: 8_192,
        maximumSummaryChars: 80_000,
        conversationId: 'c1',
        runPrompt,
      }),
    ).rejects.toThrow(/call limit/u);
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it('treats a 400k server with two slots as 200k: 170k trigger, <=17k-token replacement', () => {
    const perSlot = 400_000 / 2;
    const budget = compactionBudget(170_000, 400_000, perSlot);
    expect(budget.policyTokens).toBe(170_000);
    expect(budget.replacementMaxChars).toBe(42_500);
  });
});
