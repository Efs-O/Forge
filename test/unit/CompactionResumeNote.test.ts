import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import {
  formatCompactionResumeNote,
  type CompactionState,
} from '../../src/sidebar/compactionTypes';
import { RESUME_PROMPT, runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import { compactMidTurn, MID_TURN_RESUME_NUDGE } from '../../src/sidebar/midTurnCompaction';
import {
  freezeTurnContextAndConsumeResumeNote,
  freezeTurnContext,
  injectTurnContext,
  type TurnContextState,
} from '../../src/sidebar/turnContext';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

const firstNote = { generation: 3, usedTokens: 1_234, maxTokens: 8_192 };
const summary =
  `Goal: finish the request.\nState: recorded. ${'detail. '.repeat(50)}\n` +
  'Next: continue from the current request.\nFiles: src/a.ts.\n' +
  'Constraints: none.\nErrors: none.\nReference: none recorded.';

function conversation(): ConversationRuntime {
  return {
    id: 'c1',
    title: 'Resume',
    createdAt: 1,
    updatedAt: 1,
    last_input_tokens: 900,
    last_output_tokens: 100,
    messages: [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'current request' },
      { role: 'assistant', content: 'work in progress' },
    ],
  };
}

function compactionDeps(conv: ConversationRuntime, max: () => number): CompactionDeps {
  return {
    post: vi.fn(),
    getConversation: (id) => (id === conv.id ? conv : undefined),
    persistSession: vi.fn(),
    postSessionSync: vi.fn(),
    invalidateExactTokenBudget: vi.fn(),
    postTokenBudget: vi.fn(),
    isStreaming: () => false,
    beginCompaction: () => () => undefined,
    runPromptToMarkdown: async () => summary,
    currentLocalTime: () => 'test time',
    compactionMetrics: () => ({ max: max() }),
  };
}

describe('one-shot compaction resume note', () => {
  it('adds the plan refresh note only for an open plan', async () => {
    const finished = conversation();
    finished.plan = {
      items: [
        { text: 'finish the code', status: 'done' },
        { text: 'add regression coverage', status: 'done' },
      ],
      updatedAt: 2,
    };
    const open = conversation();
    open.plan = {
      items: [
        { text: 'finish the code', status: 'done' },
        { text: 'add regression coverage', status: 'active' },
      ],
      updatedAt: 2,
    };
    const planRefreshNote =
      'If a plan is shown, check it against the State section and update it with `update_plan` before continuing.';

    await expect(
      runCompaction(compactionDeps(finished, () => 32_000), finished.id, { auto: true }),
    ).resolves.toBe('compacted');
    await expect(
      runCompaction(compactionDeps(open, () => 32_000), open.id, { auto: true }),
    ).resolves.toBe('compacted');

    expect(finished.compaction?.summary).not.toContain(planRefreshNote);
    expect(open.compaction?.summary).toContain(planRefreshNote);
  });

  it('records exact usage on success and replaces it with the next generation', async () => {
    const conv = conversation();
    let max = 32_000;
    const deps = compactionDeps(conv, () => max);
    await expect(runCompaction(deps, conv.id, { auto: true })).resolves.toBe('compacted');
    expect(conv.compaction?.resumeNote).toEqual({
      generation: 1,
      usedTokens: 1_000,
      maxTokens: 32_000,
    });

    conv.messages.push(
      { role: 'assistant', content: 'second response' },
      { role: 'user', content: 'next request' },
      { role: 'assistant', content: 'more work' },
    );
    conv.last_input_tokens = 2_500;
    conv.last_output_tokens = 500;
    max = 64_000;
    await expect(runCompaction(deps, conv.id, { auto: true })).resolves.toBe('compacted');
    expect(conv.compaction?.resumeNote).toEqual({
      generation: 2,
      usedTokens: 3_000,
      maxTokens: 64_000,
    });
  });

  it('leaves the window out of the note when the model has none configured', async () => {
    const conv = conversation();
    await expect(runCompaction(compactionDeps(conv, () => 0), conv.id, { auto: true })).resolves.toBe(
      'compacted',
    );
    const note = conv.compaction?.resumeNote;
    expect(note).toEqual({ generation: 1, usedTokens: 1_000 });
    expect(formatCompactionResumeNote(note)).toContain('(compaction 1, at 1,000 tokens)');
  });

  it('does not write a resume note when compaction fails', async () => {
    const conv = conversation();
    const deps = compactionDeps(conv, () => 32_000);
    deps.runPromptToMarkdown = async () => {
      throw new Error('summary request failed');
    };

    await expect(runCompaction(deps, conv.id, { auto: true })).resolves.toBe('failed');
    expect(conv.compaction?.resumeNote).toBeUndefined();
  });

  it.each([false, true])(
    'freezes the note once on the %s turn-opening user message and consumes it',
    (internal) => {
      const content = internal ? RESUME_PROMPT : 'a user typed the next request';
      const first: ChatMessage = {
        role: 'user',
        content,
        ...(internal ? { internal: true } : {}),
      };
      const messages: ChatMessage[] = [first];
      const compaction: CompactionState = { summary, fromIndex: 0, resumeNote: firstNote };
      const noteText = formatCompactionResumeNote(firstNote);
      const turnState: TurnContextState = { compactionResume: noteText };

      expect(freezeTurnContextAndConsumeResumeNote(messages, turnState, compaction)).toBe(true);
      const frozenBytes = first.turnContext;
      expect(frozenBytes).toContain(noteText);
      expect(frozenBytes?.match(/Context was compacted just now/g)).toHaveLength(1);
      expect(compaction.resumeNote).toBeUndefined();
      expect(injectTurnContext(messages, turnState)[0]?.content).toContain(frozenBytes);

      messages.push({ role: 'user', content: 'the following user turn' });
      expect(freezeTurnContext(messages, { currentDate: '2026-10-21' })).toBe(true);
      expect(messages[1]?.turnContext).not.toContain(noteText);
      expect(first.turnContext).toBe(frozenBytes);
      expect(
        injectTurnContext(messages, { currentDate: '2026-10-21' })[0]?.content,
      ).toContain(frozenBytes);
    },
  );

  it('leaves the note pending when the opening message already has frozen context', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: RESUME_PROMPT, internal: true, turnContext: 'old frozen block' },
    ];
    const compaction: CompactionState = { summary, fromIndex: 0, resumeNote: firstNote };
    expect(
      freezeTurnContextAndConsumeResumeNote(
        messages,
        { compactionResume: formatCompactionResumeNote(firstNote) },
        compaction,
      ),
    ).toBe(false);
    expect(compaction.resumeNote).toEqual(firstNote);
  });

  it('puts the note in the mid-turn nudge and consumes it after insertion', async () => {
    const conv = conversation();
    conv.compaction = { summary, fromIndex: 0, resumeNote: firstNote };
    const result = await compactMidTurn(
      {
        getConfig: () => ({ auto_compact: { enabled: true } }) as never,
        snapshot: () => ({ used: 1, max: 8_192 }),
        compact: async () => 'compacted',
      },
      conv,
      { exhausted: true },
    );
    expect(result).toBe(true);
    expect(conv.messages.at(-1)?.content).toBe(
      `${MID_TURN_RESUME_NUDGE}\n\n${formatCompactionResumeNote(firstNote)}`,
    );
    expect(conv.compaction.resumeNote).toBeUndefined();
  });
});
