import { describe, expect, it, vi } from 'vitest';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import type { CompactionAttemptLogEntry } from '../../src/sidebar/SessionLogger';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';

const HEAD = 'Goal: g\nState: s\nNext: n\nFiles: f\nConstraints: c\nErrors: e\nReference: r\n';

/**
 * Four large request/reply pairs and a short tail. At a 16k window the normal
 * stage's summarizer request cannot fit (its newest six entries are the large
 * pairs), while floor mode — no tail, older history condensed up front — fits.
 * At 14k even floor mode cannot.
 */
function harness(modelMax: number, summary = `${HEAD}${'x'.repeat(500)}`) {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'user', content: `request ${i} ${'u'.repeat(3_000)}` });
    messages.push({ role: 'assistant', content: `reply ${i} ${'a'.repeat(8_000)}` });
  }
  messages.push({ role: 'user', content: 'latest' }, { role: 'assistant', content: 'ok' });
  const conv: ConversationRuntime = {
    id: 'c1',
    title: 't',
    messages,
    createdAt: 0,
    updatedAt: 0,
  };
  const rows: CompactionAttemptLogEntry[] = [];
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
    currentLocalTime: () => 'test local time',
    compactionMetrics: () => ({ max: modelMax }),
    logCompactionAttempt: (_conv, entry) => rows.push(entry),
  };
  const shown = () =>
    posted.filter(
      (m) =>
        m.type === 'error' || (m.type === 'notice' && m.message !== 'Compacting conversation…'),
    );
  return { conv, deps, rows, runPrompt, shown };
}

describe('floor-mode retry', () => {
  it('retries a pre-call size refusal once in floor mode, with one notice and one row', async () => {
    const h = harness(16_000);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('compacted');

    expect(h.runPrompt).toHaveBeenCalledTimes(1);
    const shown = h.shown();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.type).toBe('notice');
    expect(shown[0]!.message).toMatch(/^Conversation compacted in reduced mode/u);
    expect(shown[0]!.message).toContain('no recent messages kept verbatim');
    expect(shown[0]!.message).toContain('user requests to floor');
    const finished = h.rows.filter((row) => row.phase === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: 'compacted', floorMode: true, calls: 1 });
    // No retained tail: the cut is the end of the conversation.
    expect(h.conv.compaction?.fromIndex).toBe(h.conv.messages.length);
  });

  it('fails with the floor-mode refusal when floor mode cannot fit either', async () => {
    const h = harness(14_000);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('failed');

    expect(h.runPrompt).not.toHaveBeenCalled();
    expect(h.conv.compaction).toBeUndefined();
    const shown = h.shown();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.type).toBe('error');
    expect(shown[0]!.message).toContain('(floor:');
    expect(h.rows.filter((row) => row.phase === 'finished')[0]).toMatchObject({
      outcome: 'failed',
      category: 'budget-refusal',
      floorMode: true,
    });
  });

  it('does not retry a size refusal raised after a summarizer call', async () => {
    const h = harness(64_000, `${HEAD}${'x'.repeat(40_000)}`);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('failed');

    expect(h.runPrompt).toHaveBeenCalledTimes(1);
    const finished = h.rows.filter((row) => row.phase === 'finished')[0];
    expect(finished).toMatchObject({ category: 'budget-refusal', calls: 1 });
    expect(finished?.floorMode).toBeUndefined();
  });

  it('runs no floor mode when the normal stage fits', async () => {
    const h = harness(20_000);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('compacted');

    expect(h.shown()[0]!.message).toMatch(/^Conversation compacted at/u);
    expect(h.rows.filter((row) => row.phase === 'finished')[0]?.floorMode).toBeUndefined();
    expect(h.conv.compaction?.fromIndex).toBeLessThan(h.conv.messages.length);
  });
});
