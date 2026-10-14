import { describe, expect, it, vi } from 'vitest';
import { compactionBudget } from '../../src/sidebar/compactionBudget';
import { compactionSummaryAllowance } from '../../src/sidebar/compactionSummaryRunner';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import type { CompactionAttemptLogEntry } from '../../src/sidebar/SessionLogger';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';

describe('stable compaction generations', () => {
  it('keeps the reserved summary share stable across usage and growing host facts', () => {
    const windowTokens = 128_000;
    const ratio = 2.5;
    const usageShares = [0.4, 0.85, 1, 0.4, 0.85, 1, 0.4, 0.85, 1, 0.4];
    const summaryAllowances: number[] = [];

    for (let generation = 0; generation < 10; generation++) {
      const usageTokens = Math.floor(windowTokens * usageShares[generation]!);
      const budget = compactionBudget(
        usageTokens,
        windowTokens * ratio,
        windowTokens,
        0,
        ratio,
        windowTokens,
      );
      const recordedActionCount = Math.min(48, (generation + 1) * 5);
      const memoryKeyCount = Math.min(40, (generation + 1) * 4);
      const hostChars = Math.min(
        budget.hostMaxChars,
        recordedActionCount * 250 + memoryKeyCount * 100,
      );
      const summaryAllowance = compactionSummaryAllowance(budget.summaryCeilingChars, '');
      const fakeSummary = 's'.repeat(Math.floor(summaryAllowance * 0.75));
      const replacementChars = hostChars + budget.tailMaxChars + fakeSummary.length;

      summaryAllowances.push(summaryAllowance);
      expect(replacementChars).toBeLessThanOrEqual(budget.replacementMaxChars);
    }

    expect(new Set(summaryAllowances).size).toBe(1);
  });

  it.each([32_000, 128_000])(
    'runs ten real compactions at a %i-token window with host facts growing past H',
    async (windowTokens) => {
      const usageShares = [0.4, 0.85, 1, 0.4, 0.85, 1, 0.4, 0.85, 1, 0.4];
      const conv: ConversationRuntime = {
        id: 'c1',
        title: 't',
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      };
      const memoryKeys: string[] = [];
      const rows: CompactionAttemptLogEntry[] = [];
      const targets: number[] = [];
      // A summarizer that writes exactly the target it is asked for.
      const runPrompt = vi.fn(async (prompt: string) => {
        const target = Number(/Aim for about (\d+) characters/u.exec(prompt)?.[1]);
        targets.push(target);
        const head =
          'Goal: g\nState: s\nNext: n\nFiles: f\nConstraints: c\nErrors: e\nReference: r\n';
        return head + 'x'.repeat(target - head.length);
      });
      const deps: CompactionDeps = {
        post: vi.fn(),
        getConversation: () => conv,
        persistSession: vi.fn(),
        postSessionSync: vi.fn(),
        invalidateExactTokenBudget: vi.fn(),
        postTokenBudget: vi.fn(),
        isStreaming: () => false,
        beginCompaction: () => () => undefined,
        runPromptToMarkdown: runPrompt,
        currentLocalTime: () => 'test local time',
        compactionMetrics: () => ({ max: windowTokens }),
        logCompactionAttempt: (_conv, entry) => rows.push(entry),
        listMemoryKeys: () => memoryKeys,
        snapshotRepoState: async () => 'r'.repeat(1_500),
      };

      for (let generation = 0; generation < 10; generation++) {
        conv.messages.push(...generationMessages(generation));
        memoryKeys.push(...Array.from({ length: 4 }, (_, i) => `memory-key-${generation}-${i}`));
        conv.last_input_tokens = Math.floor(windowTokens * usageShares[generation]!);
        await expect(runCompaction(deps, 'c1', { auto: true })).resolves.toBe('compacted');
      }

      const finished = rows.filter((row) => row.phase === 'finished');
      expect(finished).toHaveLength(10);
      expect(runPrompt).toHaveBeenCalledTimes(10);
      expect(targets[0]).toBeGreaterThan(1_000);
      expect(new Set(targets).size).toBe(1);
      const replacementMax = compactionBudget(
        1,
        1,
        windowTokens,
        0,
        2.5,
        windowTokens,
      ).replacementMaxChars;
      for (const row of finished) {
        expect(row.candidateChars).toBeLessThanOrEqual(replacementMax);
        expect(row.floorMode).toBeUndefined();
      }
      // Host facts did outgrow H at the small window and were shed, not refused.
      if (windowTokens === 32_000) {
        expect(finished.some((row) => (row.shed ?? []).length > 0)).toBe(true);
      }
    },
  );
});

/** One generation's work: a request, file edits, commands with output, and a long reply. */
function generationMessages(generation: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'user', content: `request ${generation}: ${'u'.repeat(300)}` },
  ];
  for (let i = 0; i < 5; i++) {
    const id = `edit-${generation}-${i}`;
    messages.push(call(id, 'edit_file', { path: `src/module${generation}_${i}.ts` }), {
      role: 'tool',
      content: 'Wrote 42 lines.',
      tool_call_id: id,
    });
  }
  for (let i = 0; i < 3; i++) {
    const id = `shell-${generation}-${i}`;
    messages.push(call(id, 'shell', { command: `npm run check -- step${generation}_${i}` }), {
      role: 'tool',
      content: `exit 0\n${'o'.repeat(2_000)}`,
      tool_call_id: id,
    });
  }
  messages.push({ role: 'assistant', content: `done ${generation}. ${'a'.repeat(20_000)}` });
  return messages;
}

function call(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}
