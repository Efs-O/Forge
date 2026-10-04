import { describe, expect, it, vi } from 'vitest';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import { PromptIncompleteError } from '../../src/sidebar/PromptRun';
import { compactionRefusalNotice } from '../../src/sidebar/compactionRefusal';
import type { CompactionAttemptLogEntry } from '../../src/sidebar/SessionLogger';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';

const SECRET = 'SECRET-SOURCE-TEXT-DO-NOT-LOG';

function setup(runPrompt: CompactionDeps['runPromptToMarkdown'], tokens = 2_000) {
  const messages: ChatMessage[] = [
    { role: 'user', content: `${SECRET} first` },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second' },
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
    last_input_tokens: tokens,
  };
  const rows: CompactionAttemptLogEntry[] = [];
  const posted: Array<{ type: string; message?: string }> = [];
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
    logCompactionAttempt: (_c, entry) => rows.push(entry),
  };
  return { conv, deps, rows, posted };
}

const good = async (): Promise<string> =>
  `Goal: complete the request.\n\nState: recorded. Next: continue. ${'detail. '.repeat(40)}`;

describe('compaction attempt rows (A48)', () => {
  it('start and terminal rows share one attempt id and carry the call count', async () => {
    const h = setup(good);
    await expect(runCompaction(h.deps, 'c1', { auto: true, trigger: 'auto' })).resolves.toBe(
      'compacted',
    );
    expect(h.rows.map((r) => r.phase)).toEqual(['start', 'finished']);
    expect(h.rows[0]!.attemptId).toBe(h.rows[1]!.attemptId);
    expect(h.rows[1]).toMatchObject({ outcome: 'compacted', calls: 1, trigger: 'auto' });
  });

  it('a length stop is logged with its category and finish reason', async () => {
    const h = setup(async () => {
      throw new PromptIncompleteError('length');
    });
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('failed');
    expect(h.rows[1]).toMatchObject({
      phase: 'finished',
      outcome: 'failed',
      finishReason: 'length',
    });
    expect(h.rows[1]!.category).toBeDefined();
    expect(h.rows[1]!.calls).toBeGreaterThanOrEqual(1);
  });

  it('a suppressed automatic attempt is a distinct row with the held category', async () => {
    const h = setup(async () => {
      throw new PromptIncompleteError('length');
    });
    await runCompaction(h.deps, 'c1', { auto: true });
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('skipped');
    const suppressed = h.rows.filter((r) => r.phase === 'suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.category).toBeDefined();
    expect(new Set(h.rows.map((r) => r.attemptId)).size).toBe(h.rows.length - 1);
  });

  it('never contains source or summary text', async () => {
    const h = setup(good);
    await runCompaction(h.deps, 'c1', { auto: false });
    expect(JSON.stringify(h.rows)).not.toContain(SECRET);
    expect(JSON.stringify(h.rows)).not.toContain('detail.');
  });

  it('a throwing log sink does not break compaction', async () => {
    const h = setup(good);
    h.deps.logCompactionAttempt = () => {
      throw new Error('disk full');
    };
    await expect(runCompaction(h.deps, 'c1', { auto: false })).resolves.toBe('compacted');
    expect(h.conv.compaction).toBeDefined();
  });
});

describe('refusal notice (A50)', () => {
  it('manual and post-turn advice may suggest a new chat', () => {
    expect(compactionRefusalNotice(10, 5)).toMatch(/Start a new chat/u);
  });

  it('a live mid-turn refusal says the turn continues and gives no new-chat advice', () => {
    const notice = compactionRefusalNotice(10, 5, true);
    expect(notice).not.toMatch(/new chat/iu);
    expect(notice).toMatch(/turn continues/u);
  });
});
