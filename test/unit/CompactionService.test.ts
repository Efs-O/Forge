import { describe, expect, it, vi } from 'vitest';
import {
  autoCompactAndResume,
  buildSummaryPrompt,
  COMPACTION_SUMMARY_MAX_CHARS,
  MAX_CONSECUTIVE_AUTO_CONTINUES,
  RESUME_PROMPT,
  RETAINED_TAIL_MAX_CHARS,
  runCompaction,
  selectCompactionSplit,
  type AutoCompactDeps,
  type CompactionDeps,
  type CompactionOutcome,
} from '../../src/sidebar/CompactionService';
import { applyCompactionWindow } from '../../src/sidebar/compactionWindow';
import type { ChatMessage } from '../../src/llm/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

function conv(messages: ChatMessage[]): ConversationRuntime {
  return { id: 'c1', title: 't', messages, createdAt: 0, updatedAt: 0 } as ConversationRuntime;
}

interface Harness {
  deps: CompactionDeps;
  posted: HostToWebview[];
  busyDuringSummary: boolean;
  released: boolean;
}

function harness(
  conversation: ConversationRuntime,
  summarize: (deps: { released: () => boolean }) => Promise<string>,
): Harness {
  const state: Harness = {
    posted: [],
    busyDuringSummary: false,
    released: false,
    deps: undefined as unknown as CompactionDeps,
  };
  let busy = false;
  state.deps = {
    post: (msg) => state.posted.push(msg),
    getActiveConv: () => conversation,
    persistSession: () => undefined,
    postSessionSync: () => undefined,
    invalidateExactTokenBudget: () => undefined,
    postTokenBudget: () => undefined,
    isStreaming: () => false,
    beginCompaction: () => {
      busy = true;
      return () => {
        busy = false;
        state.released = true;
      };
    },
    runPromptToMarkdown: async () => {
      state.busyDuringSummary = busy;
      return summarize({ released: () => state.released });
    },
  };
  return state;
}

describe('selectCompactionSplit', () => {
  it('keeps the last user turn verbatim and summarizes only what precedes it', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'did the first task' },
      { role: 'user', content: 'second task' },
      { role: 'assistant', content: 'working on it' },
    ];
    const split = selectCompactionSplit(messages);
    expect(split?.tailStart).toBe(2);
    expect(split?.summarize.map((m) => m.content)).toEqual(['first task', 'did the first task']);
  });

  it('refuses to retain a tail over the char cap', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'did the first task' },
      { role: 'user', content: 'x'.repeat(RETAINED_TAIL_MAX_CHARS + 1) },
    ];
    const split = selectCompactionSplit(messages);
    expect(split?.tailStart).toBe(messages.length);
  });

  it('does not retain so much that nothing is left to summarize', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'only task' },
      { role: 'assistant', content: 'done' },
    ];
    const split = selectCompactionSplit(messages);
    expect(split?.tailStart).toBe(messages.length);
  });

  it('returns null below the minimum summarizable history', () => {
    expect(selectCompactionSplit([{ role: 'user', content: 'hello' }])).toBeNull();
  });

  it('keeps assistant tool-call turns available to the summary', () => {
    const prompt = buildSummaryPrompt(undefined, [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', content: 'file written' },
    ]);

    expect(prompt).toContain('Tool calls: write_file');
    expect(prompt).toContain('file written');
  });
});

describe('runCompaction', () => {
  it('associates its summary request with the compacted conversation', async () => {
    const c = conv([
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'did the first task' },
      { role: 'user', content: 'second task' },
    ]);
    const h = harness(c, async () => 'summary');
    const runPrompt = vi.fn(async () => 'summary');
    h.deps.runPromptToMarkdown = runPrompt;

    await runCompaction(h.deps, { auto: true });

    expect(runPrompt).toHaveBeenCalledWith(expect.any(String), c.id);
  });

  const base: ChatMessage[] = [
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: 'did the first task' },
    { role: 'user', content: 'second task' },
    { role: 'assistant', content: 'working on it' },
  ];

  it('records the cut point from the pre-await snapshot, not the later length', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => {
      // A turn that lands while the summary is still streaming. Reading
      // messages.length afterwards used to bury it behind the cut.
      c.messages.push({ role: 'user', content: 'raced prompt' });
      c.messages.push({ role: 'assistant', content: 'raced reply' });
      return 'summary of the first task';
    });

    const outcome = await runCompaction(h.deps, { auto: true });

    expect(outcome).toBe('compacted');
    expect(c.compaction).toEqual({ summary: 'summary of the first task', fromIndex: 2 });
    const sent = applyCompactionWindow(c.messages, c.compaction);
    expect(sent.map((m) => m.content)).toContain('raced prompt');
    expect(sent.map((m) => m.content)).toContain('second task');
  });

  it('marks the conversation busy for the summarization and releases it after', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => 'summary');

    await runCompaction(h.deps, { auto: true });

    expect(h.busyDuringSummary).toBe(true);
    expect(h.released).toBe(true);
    const types = h.posted.map((m) => m.type);
    expect(types).toContain('generationStarted');
    expect(types).toContain('done');
    expect(types.indexOf('generationStarted')).toBeLessThan(types.indexOf('done'));
  });

  it('reports a failed summarization and leaves the window untouched', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => {
      throw new Error('backend down');
    });

    const outcome = await runCompaction(h.deps, { auto: true });

    expect(outcome).toBe('failed');
    expect(c.compaction).toBeUndefined();
    expect(h.released).toBe(true);
    expect(h.posted.some((m) => m.type === 'done')).toBe(true);
    expect(h.posted.some((m) => m.type === 'error')).toBe(true);
  });

  it('caps the persisted checkpoint instead of allowing it to become a second transcript', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => 'x'.repeat(COMPACTION_SUMMARY_MAX_CHARS + 100));

    expect(await runCompaction(h.deps, { auto: true })).toBe('compacted');
    expect(c.compaction?.summary.length).toBe(COMPACTION_SUMMARY_MAX_CHARS + 13);
    expect(c.compaction?.summary).toContain('…[truncated]');
  });

  it('skips while a turn is streaming', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => 'summary');
    const deps = { ...h.deps, isStreaming: () => true };

    expect(await runCompaction(deps, { auto: false })).toBe('skipped');
    expect(c.compaction).toBeUndefined();
  });

  it('re-compacting summarizes only what the previous summary did not cover', async () => {
    const c = conv([...base]);
    c.compaction = { summary: 'earlier summary', fromIndex: 2 };
    c.messages.push({ role: 'user', content: 'third task' });
    c.messages.push({ role: 'assistant', content: 'still working' });
    let prompt = '';
    const h = harness(c, async () => 'newer summary');
    const deps: CompactionDeps = {
      ...h.deps,
      runPromptToMarkdown: async (text) => {
        prompt = text;
        return 'newer summary';
      },
    };

    await runCompaction(deps, { auto: true });

    expect(prompt).toContain('EARLIER CHECKPOINT:\nearlier summary');
    expect(prompt).toContain('second task');
    expect(prompt).not.toContain('third task');
    expect(c.compaction?.fromIndex).toBe(4);
  });
});

describe('autoCompactAndResume', () => {
  function autoDeps(overrides: Partial<AutoCompactDeps> = {}): {
    deps: AutoCompactDeps;
    sent: string[];
    continues: { count: number };
  } {
    const sent: string[] = [];
    const posted: HostToWebview[] = [];
    const continues = { count: 0 };
    const deps: AutoCompactDeps = {
      convId: 'c1',
      post: (msg) => {
        posted.push(msg);
      },
      compact: async (): Promise<CompactionOutcome> => 'compacted',
      incompleteTurnReason: () => 'the reply was cut off by the output limit',
      resumeEnabled: true,
      autoContinues: () => continues.count,
      noteAutoContinue: () => {
        continues.count += 1;
      },
      send: async (text) => {
        sent.push(text);
      },
      ...overrides,
    };
    return { deps, sent, continues, posted };
  }

  // `compact()` posts `done` in its finally, which clears the webview's
  // streaming state. The resume is host-initiated, so it produces no USER_SEND
  // either — without an explicit generationStarted the resumed turn generated
  // with the Stop button hidden and no way to cancel it.
  it('re-arms the webview streaming state before resuming', async () => {
    const { deps, sent, posted } = autoDeps();
    await autoCompactAndResume(deps);
    expect(sent).toEqual([RESUME_PROMPT]);
    const started = posted.findIndex(
      (m) => m.type === 'generationStarted' && m.conversationId === 'c1',
    );
    expect(started).toBeGreaterThanOrEqual(0);
  });

  it('does not re-arm streaming when the resume is skipped', async () => {
    const { deps, posted } = autoDeps({ resumeEnabled: false });
    await autoCompactAndResume(deps);
    expect(posted.some((m) => m.type === 'generationStarted')).toBe(false);
  });

  it('resumes a turn that was cut off', async () => {
    const { deps, sent, continues } = autoDeps();
    await autoCompactAndResume(deps);
    expect(sent).toEqual([RESUME_PROMPT]);
    expect(continues.count).toBe(1);
  });

  it('continues after compaction even when the preceding turn finished cleanly', async () => {
    const { deps, sent, continues } = autoDeps({ incompleteTurnReason: () => undefined });
    await autoCompactAndResume(deps);
    expect(sent).toEqual([RESUME_PROMPT]);
    expect(continues.count).toBe(1);
  });

  it('does not resume when the compaction did not happen', async () => {
    const { deps, sent } = autoDeps({ compact: async () => 'failed' });
    await autoCompactAndResume(deps);
    expect(sent).toEqual([]);
  });

  it('honours resume: false', async () => {
    const { deps, sent } = autoDeps({ resumeEnabled: false });
    await autoCompactAndResume(deps);
    expect(sent).toEqual([]);
  });

  it('stops after the consecutive-resume limit', async () => {
    const { deps, sent } = autoDeps({ autoContinues: () => MAX_CONSECUTIVE_AUTO_CONTINUES });
    await autoCompactAndResume(deps);
    expect(sent).toEqual([]);
  });

  it('surfaces a failed resume instead of swallowing it', async () => {
    const posted: string[] = [];
    const { deps } = autoDeps({
      post: (msg) => posted.push(msg.type),
      send: async () => {
        throw new Error('no model selected');
      },
    });
    await autoCompactAndResume(deps);
    expect(posted).toContain('error');
  });
});
