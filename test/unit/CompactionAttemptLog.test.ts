import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import { PromptIncompleteError } from '../../src/sidebar/PromptRun';
import { compactionRefusalNotice } from '../../src/sidebar/compactionRefusal';
import type { CompactionAttemptLogEntry } from '../../src/sidebar/SessionLogger';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';
import {
  renderCompactionUserMessages,
  USER_CONTEXT_MAX_CHARS,
} from '../../src/sidebar/compactionUserContext';

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
    currentLocalTime: () => 'test local time',
    logCompactionAttempt: (_c, entry) => rows.push(entry),
  };
  return { conv, deps, rows, posted };
}

const good = async (): Promise<string> =>
  `Goal: complete the request.\nState: recorded. ${'detail. '.repeat(40)}\nNext: continue.\nFiles: src/a.ts.\nConstraints: none.\nErrors: none.`;

describe('compaction attempt rows (A48)', () => {
  it('start and terminal rows share one attempt id and carry the call count', async () => {
    const h = setup(good);
    await expect(runCompaction(h.deps, 'c1', { auto: true, trigger: 'auto' })).resolves.toBe(
      'compacted',
    );
    expect(h.rows.map((r) => r.phase)).toEqual(['start', 'finished']);
    expect(h.rows[0]!.attemptId).toBe(h.rows[1]!.attemptId);
    expect(h.rows[1]).toMatchObject({
      outcome: 'compacted',
      calls: 1,
      trigger: 'auto',
      finishReason: 'stop',
    });
    expect(h.rows[0]!.windowChars).toBeGreaterThan(0);
    expect(h.rows[0]!.candidateChars).toBeUndefined();
    expect(h.rows[1]!.candidateChars).toBeGreaterThan(0);
  });

  it('records host measurements, counter mode, components, and shed facts', async () => {
    const h = setup(good);
    (h.deps as CompactionDeps & { countTokens: (text: string) => Promise<number> }).countTokens =
      async (text) => Math.ceil(text.length / 3.5);
    await runCompaction(h.deps, 'c1', { auto: true });
    expect(h.rows[1]).toMatchObject({
      hostChars: expect.any(Number),
      hostMaxChars: expect.any(Number),
      charsPerToken: expect.any(Number),
      counter: 'count_tokens',
      components: expect.any(Object),
      shed: expect.any(Array),
    });
  });

  it('refuses a configured counter error with its endpoint and never asks for a summary', async () => {
    const runPrompt = vi.fn(good);
    const h = setup(runPrompt);
    const deps = h.deps as CompactionDeps & {
      countTokens: (text: string) => Promise<number>;
      tokenCountEndpoint: () => string;
    };
    deps.countTokens = async () => {
      throw new Error('counter unreachable');
    };
    deps.tokenCountEndpoint = () => 'http://127.0.0.1:8090';
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('failed');
    expect(runPrompt).not.toHaveBeenCalled();
    expect(h.posted.find((entry) => entry.type === 'error')?.message).toContain(
      'http://127.0.0.1:8090',
    );
  });

  it('keeps the existing host budget when configured to estimate', async () => {
    const h = setup(good, 170_000);
    (h.deps as CompactionDeps & { tokenCountMode: () => 'estimate' }).tokenCountMode = () =>
      'estimate';
    await runCompaction(h.deps, 'c1', { auto: true });
    expect(h.rows[1]!.hostMaxChars).toBe(14_875);
    expect(h.rows[1]!.counter).toBe('estimate');
  });

  it('admits manual compaction at 60K used and trims the persisted user block to its budget', async () => {
    const h = setup(good, 60_000);
    h.conv.messages = [
      { role: 'user', content: 'first request ' + 'a'.repeat(5_000) },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'latest correction ' + 'b'.repeat(5_000) },
      { role: 'assistant', content: 'working' },
    ] satisfies ChatMessage[];
    (h.deps as CompactionDeps & { countTokens: (text: string) => Promise<number> }).countTokens =
      async (text) => Math.ceil(text.length / 3.5);
    await expect(runCompaction(h.deps, 'c1', { auto: false })).resolves.toBe('compacted');
    const userBlock = renderCompactionUserMessages(h.conv.compaction?.userMessages);
    expect(userBlock.length).toBeLessThan(USER_CONTEXT_MAX_CHARS);
    const terminal = h.rows[1]!;
    const components = terminal.components as Record<string, number>;
    expect(userBlock.length).toBeLessThanOrEqual(
      Math.max(4_000, terminal.hostMaxChars! - components['recorded actions']!),
    );
    expect(userBlock).toContain('latest correction');
    expect(userBlock).toContain('[user message truncated]');
  });

  it('a reloaded conversation is re-admitted: the in-memory hold does not survive', async () => {
    const h = setup(async () => {
      throw new PromptIncompleteError('length');
    });
    await runCompaction(h.deps, 'c1', { auto: true });
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('skipped');
    // A reload rebuilds the conversation object; the hold is keyed by the old one.
    const reloaded = { ...h.conv, messages: [...h.conv.messages] };
    h.deps.getConversation = () => reloaded;
    const before = h.rows.length;
    await runCompaction(h.deps, 'c1', { auto: true });
    expect(h.rows.slice(before).map((r) => r.phase)).toEqual(['start', 'finished']);
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

  it('a throwing log sink does not break compaction but surfaces a warning', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const h = setup(good);
    h.deps.logCompactionAttempt = () => {
      throw new Error('disk full');
    };
    await expect(runCompaction(h.deps, 'c1', { auto: false })).resolves.toBe('compacted');
    expect(h.conv.compaction).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    warn.mockRestore();
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
