import { describe, expect, it, vi } from 'vitest';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import {
  fitCompactionHostBlock,
  REPO_STATE_SHED_MARKER,
  shedOptionalHostFacts,
  type OptionalHostFacts,
} from '../../src/sidebar/compactionHostFit';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';
import { compactionBudget } from '../../src/sidebar/compactionBudget';
import type { RecordedCompactionAction } from '../../src/sidebar/compactionTypes';
import { renderCompactionHostBlock } from '../../src/sidebar/compactionHostFit';
import { replacementHostMessages } from '../../src/sidebar/compactionWindow';

const summary = `Goal: complete the request.\nState: recorded. ${'detail. '.repeat(40)}\nNext: continue.\nFiles: src/a.ts.\nConstraints: none.\nErrors: none.`;

function setup(userChars: number, repoState: string, lastInputTokens: number) {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'a'.repeat(userChars) },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'b'.repeat(userChars) },
    { role: 'assistant', content: 'second answer' },
    { role: 'user', content: 'current request' },
    { role: 'assistant', content: 'working' },
  ];
  const conv: ConversationRuntime = {
    id: 'c1',
    title: 't',
    messages,
    createdAt: 0,
    updatedAt: 0,
    last_input_tokens: lastInputTokens,
  };
  const posted: Array<{ type: string; message?: string }> = [];
  const runPrompt = vi.fn(async () => summary);
  const deps: CompactionDeps = {
    post: (m) => posted.push(m as never),
    getConversation: () => conv,
    persistSession: vi.fn(),
    postSessionSync: vi.fn(),
    invalidateExactTokenBudget: vi.fn(),
    postTokenBudget: vi.fn(),
    isStreaming: () => false,
    beginCompaction: () => () => undefined,
    runPromptToMarkdown: runPrompt,
    snapshotRepoState: async () => repoState,
  };
  return { conv, deps, posted, runPrompt };
}

describe('host-fact budgeting', () => {
  it('sheds optional repo state before refusing, and the compaction lands', async () => {
    // Required user requests (~4.1k chars) fit the 6k floor budget; +1.9k repo state does not.
    const h = setup(2_000, 'r'.repeat(1_900), 2_000);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('compacted');
    expect(h.conv.compaction?.repoState).toBe(REPO_STATE_SHED_MARKER);
    expect(h.conv.compaction?.userMessages?.length).toBeGreaterThan(0);
  });

  it('keeps user requests whole when repo state must be shed to fit', async () => {
    const h = setup(2_800, 'r'.repeat(2_500), 60_000);
    let shed: string[] = [];
    h.deps.logCompactionAttempt = (_conv, entry) => {
      if (entry.phase === 'finished') shed = entry.shed ?? [];
    };
    (h.deps as CompactionDeps & { countTokens: (text: string) => Promise<number> }).countTokens =
      async (text) => Math.ceil(text.length / 3.5);

    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('compacted');

    expect(h.conv.compaction?.userMessages).toContain('a'.repeat(2_800));
    expect(h.conv.compaction?.userMessages).toContain('b'.repeat(2_800));
    expect(h.conv.compaction?.repoState).toBe(REPO_STATE_SHED_MARKER);
    expect(shed).toContain('repo state');
  });

  it('refuses before any model call when required user requests alone exceed the budget, naming them', async () => {
    const h = setup(3_900, '', 2_000);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('failed');
    expect(h.runPrompt).not.toHaveBeenCalled();
    expect(h.conv.compaction).toBeUndefined();
    expect(h.posted.find((m) => m.type === 'error')?.message).toMatch(
      /largest component: user requests/u,
    );
  });

  it.each([
    [8_000, 'failed'],
    [128_000, 'compacted'],
    [200_000, 'compacted'],
  ] as const)('required 12k user requests at a %i-token window → %s', async (tokens, outcome) => {
    const h = setup(3_000, 'r'.repeat(1_900), tokens);
    h.conv.messages.splice(
      2,
      0,
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'c'.repeat(3_000) },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'd'.repeat(3_000) },
    );
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe(outcome);
    if (outcome === 'failed') expect(h.conv.compaction).toBeUndefined();
  });

  it('keeps optional facts when the actual rendered block fits', async () => {
    const h = setup(100, 'r'.repeat(500), 2_000);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('compacted');
    expect(h.conv.compaction?.repoState).toBe('r'.repeat(500));
  });
});

describe('A24: constructed 200k host block at P=170,000', () => {
  const action = (kind: 'file' | 'command', n: number): RecordedCompactionAction =>
    kind === 'file'
      ? {
          kind,
          key: `src/sidebar/module${n}.ts`,
          outcome: 'ok',
          line: `edit_file n:/vs code apps/Forge/src/sidebar/module${n}.ts (id call_aaa${n})`,
          toolCallId: `call_bbb${n}`,
        }
      : {
          kind,
          key: `rg -n --glob *.ts auto_compact src #${n}`,
          outcome: 'ok',
          line: `- ran \`rg -n -C 8 --glob *.ts compactMidTurn|evaluateAfterTurn src #${n} ${'x'.repeat(n === 0 ? 273 : n === 39 ? 272 : 278)}\` → exit 0`,
          toolCallId: `call_${n}`,
        };

  function heavy(userChars: number) {
    const h = setup(userChars, 'r'.repeat(2_000), 170_000);
    h.conv.messages.splice(
      2,
      0,
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'c'.repeat(userChars) },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'd'.repeat(userChars) },
    );
    const recordedActions = [
      ...Array.from({ length: 60 }, (_, i) => action('file', i)),
      ...Array.from({ length: 40 }, (_, i) => action('command', i)),
    ];
    h.conv.compaction = {
      summary: 'previous summary '.repeat(20),
      fromIndex: 0,
      generation: 1,
      recordedActions,
      memoryKeys: Array.from({ length: 40 }, (_, i) => `audit-memory-key-number-${i}`),
    };
    h.deps.listMemoryKeys = () => h.conv.compaction?.memoryKeys ?? [];
    return h;
  }

  it('admits the 24-request, 40-action session at 85% with the measured ratio', async () => {
    const h = setup(400, '', 170_000);
    h.conv.messages = Array.from({ length: 24 }, (_, i) => [
      { role: 'user' as const, content: `request-${i} ${'u'.repeat(400)}` },
      { role: 'assistant' as const, content: `reply-${i}` },
    ]).flat();
    h.conv.compaction = {
      summary: 'previous summary '.repeat(20),
      fromIndex: 0,
      generation: 1,
      recordedActions: Array.from({ length: 40 }, (_, i) => action(i % 2 ? 'command' : 'file', i)),
      memoryKeys: Array.from({ length: 6 }, (_, i) => `audit-memory-key-${i}`),
    };
    h.deps.listMemoryKeys = () => h.conv.compaction?.memoryKeys ?? [];
    (h.deps as CompactionDeps & { countTokens: (text: string) => Promise<number> }).countTokens =
      async (text) => Math.ceil(text.length / 3.5);

    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('compacted');
  });

  it('refuses when required host facts exceed the 14,875-char budget and leaves state intact', async () => {
    const h = heavy(6_000);
    const hostMax = compactionBudget(170_000, 170_000 * 2.5, 200_000, 0).hostMaxChars;
    expect(hostMax).toBe(14_875);
    const before = structuredClone(h.conv.compaction);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('failed');
    expect(h.runPrompt).not.toHaveBeenCalled();
    expect(h.conv.compaction).toEqual(before);
    expect(h.posted.find((m) => m.type === 'error')?.message).toMatch(
      /need an estimated 16117 characters/u,
    );
  });

  it('positive case: smaller host facts at the same P still compact', async () => {
    const h = setup(200, 'r'.repeat(500), 170_000);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('compacted');
  });
});

describe('shedOptionalHostFacts', () => {
  it('sheds least valuable first and stops as soon as the block fits', () => {
    const optional: OptionalHostFacts = {
      repoState: 'x'.repeat(100),
      memoryKeys: ['k'],
      lastReply: 'reply',
    };
    const measure = (): number =>
      (optional.repoState.length > 99 ? 100 : 10) + optional.memoryKeys.length * 5;
    const shed = shedOptionalHostFacts(optional, measure, 20);
    expect(shed).toEqual(['repo state']);
    expect(optional.memoryKeys).toEqual(['k']);
    expect(optional.lastReply).toBe('reply');
  });

  it('sheds everything optional when still over, never touching required facts', () => {
    const optional: OptionalHostFacts = { repoState: 'x', memoryKeys: ['k'], lastReply: 'r' };
    expect(shedOptionalHostFacts(optional, () => 999, 1)).toEqual([
      'repo state',
      'memory keys',
      'last reply',
    ]);
  });
});

describe('replacement host-block token measurement', () => {
  it('counts the candidate replacement user and assistant context text', async () => {
    const candidate = {
      summary: '',
      fromIndex: 1,
      generation: 2,
      userMessages: ['original request', 'latest correction'],
      repoState: 'repo facts',
    };
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'retained tail' },
    ];
    const expectedText = replacementHostMessages(candidate)
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n\n');
    let countedText = '';
    let measuredRatio = 0;
    const render = () =>
      renderCompactionHostBlock({ messages, candidate, tailChars: 0, components: {} });
    const conv: ConversationRuntime = {
      id: 'host-measurement',
      title: 'test',
      messages,
      createdAt: 0,
      updatedAt: 0,
    };

    await fitCompactionHostBlock({
      optional: { repoState: '', memoryKeys: [], lastReply: undefined },
      budget: compactionBudget(20_000, 10_000, 20_000, 0),
      budgetForCharsPerToken: (ratio) => {
        measuredRatio = ratio;
        return compactionBudget(20_000, 10_000, 20_000, 0);
      },
      render,
      counter: 'count_tokens',
      countTokens: async (text) => {
        countedText = text;
        return 350;
      },
      conv,
    });

    expect(countedText).toBe(expectedText);
    expect(measuredRatio).toBe(Math.max(2, Math.min(5, countedText.length / 350)));
  });

  it('turns a counter timeout into the configured-counter refusal', async () => {
    const conv: ConversationRuntime = {
      id: 'timeout',
      title: 'test',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    };
    await expect(
      fitCompactionHostBlock({
        optional: { repoState: '', memoryKeys: [], lastReply: undefined },
        budget: compactionBudget(20_000, 10_000, 20_000, 0),
        budgetForCharsPerToken: () => compactionBudget(20_000, 10_000, 20_000, 0),
        render: () => ({ hostChars: 1, floorChars: 1, hostBlock: 'host', components: {} }),
        counter: 'count_tokens',
        countTokens: async () => {
          throw new DOMException('The operation timed out', 'TimeoutError');
        },
        endpoint: 'http://127.0.0.1:8090',
        conv,
      }),
    ).rejects.toThrow(
      'Configured count_tokens counter at http://127.0.0.1:8090 failed: The operation timed out; previous context kept.',
    );
  });
});
