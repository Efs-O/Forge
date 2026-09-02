import { describe, expect, it, vi } from 'vitest';
import {
  RESUME_PROMPT,
  RETAINED_TAIL_MAX_CHARS,
  runCompaction,
  selectCompactionSplit,
  type CompactionDeps,
} from '../../src/sidebar/CompactionService';
import {
  buildSummaryPrompt,
  COMPACTION_SUMMARY_MAX_CHARS,
  isUsableSummary,
} from '../../src/sidebar/compactionPrompt';
import {
  collectWrittenFiles,
  recordedActionsBlock,
  renderRecordedActionsBlock,
} from '../../src/sidebar/compactionLedger';
import { applyCompactionWindow } from '../../src/sidebar/compactionWindow';
import type { ChatMessage } from '../../src/llm/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { CompactionLogEntry } from '../../src/sidebar/SessionLogger';

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
    getConversation: (conversationId) =>
      conversationId === conversation.id ? conversation : undefined,
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

/**
 * A summary long enough to clear `runCompaction`'s plausibility floor.
 *
 * That floor rejects short candidates because a model under the agent persona
 * answered a summarization request with a 117-char tool call, which would then
 * have become the conversation's working context.
 */
const long = (label: string): string =>
  `${label}

State: recorded. Next: continue. Files: src/a.ts. ${'detail. '.repeat(30)}`.trim();

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

  it('retains a complete tool exchange when only the result is oversized', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'did the first task' },
      { role: 'user', content: 'inspect the generated report' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"report.txt"}' },
          },
        ],
      },
      { role: 'tool', content: 'x'.repeat(120_000), tool_call_id: 'read' },
    ];

    const split = selectCompactionSplit(messages);
    expect(split?.tailStart).toBe(2);
    expect(messages.slice(split!.tailStart).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
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

describe('isUsableSummary', () => {
  // Measured: under the agent persona the model answered a summarization
  // request with this exact shape, 117 characters, which capSummary accepted
  // and which would then have BEEN the conversation's working context.
  it('rejects a tool call returned in place of a summary', () => {
    expect(
      isUsableSummary('{ "tool": "read_file", "arguments": { "path": "UPGRADES_PLAN.md" } }'),
    ).toBe(false);
  });

  it('rejects a fenced JSON block and anything too short to be a summary', () => {
    expect(isUsableSummary('```json\n{"a": 1}\n```')).toBe(false);
    expect(isUsableSummary('Goal: ship it.')).toBe(false);
    expect(isUsableSummary('')).toBe(false);
  });

  // Found stored as an 817-message conversation's working context on
  // 2026-08-22, from qwen3.8. Length alone caught that instance; the shape must
  // catch it at any length.
  it('rejects a non-JSON tool call at any length', () => {
    const real =
      '<tool_call>\n<function=git_log>\n<parameter=max_entries>\n5\n</parameter>\n</function>\n</tool_call>';
    expect(isUsableSummary(real)).toBe(false);
    expect(isUsableSummary([real, real, real, real].join('\n'))).toBe(false);
  });

  it('accepts real prose that merely mentions a tool', () => {
    expect(isUsableSummary(long('Goal: finish the read_file fix'))).toBe(true);
  });
});

describe('summary prompt anchoring', () => {
  it('always asks for Next, so RESUME_PROMPT cannot point at a missing section', () => {
    const prompt = buildSummaryPrompt(undefined, [{ role: 'user', content: 'do the thing' }]);

    expect(prompt).toContain('ALWAYS include Next');
    expect(prompt).toContain('nothing pending');
    // The blanket "omit empty sections" is what removed Next from a finished
    // task's summary and sent the resumed agent hunting for it.
    expect(prompt).not.toContain('omit empty sections');
  });

  it('keeps the first user message outside the truncated transcript', () => {
    const goal = 'the animations are broken - dublin is cloudy but shows a sun';
    const messages: ChatMessage[] = [
      { role: 'user', content: goal },
      // Far more than the source cap, so a head/tail slice would cut the goal.
      { role: 'tool', content: 'x'.repeat(60000) },
      { role: 'user', content: 'still broken' },
    ];

    const prompt = buildSummaryPrompt(undefined, messages);

    expect(prompt).toContain('ORIGINAL REQUEST');
    expect(prompt).toContain(goal);
  });

  it('puts host-recorded command evidence ahead of an oversized transcript', () => {
    const prompt = buildSummaryPrompt(
      undefined,
      [{ role: 'tool', content: 'x'.repeat(60000) }],
      '**Commands run (recorded by Forge, not written by the model):**\n- ran `download krea2` → exit 0; output evidence: Downloaded krea2_turbo_fp8_scaled.safetensors',
    );

    expect(prompt).toContain('HOST-RECORDED ACTION OUTCOMES');
    expect(prompt).toContain('Downloaded krea2_turbo_fp8_scaled.safetensors');
  });
});

describe('recorded file facts', () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    id: name,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });

  it("reads every changed file off the tool calls, including edit_file's filepath", () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('edit_file', { filepath: 'js/a.js' })],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('write_file', { path: 'index.html' })],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('move_file', { source: 'old.js', destination: 'new.js' })],
      },
      // Reads must NOT appear - this block is what CHANGED.
      { role: 'assistant', content: null, tool_calls: [call('read_file', { path: 'js/bg.js' })] },
    ];

    expect(collectWrittenFiles(messages)).toEqual(['js/a.js', 'index.html', 'old.js', 'new.js']);
  });

  it('survives a malformed arguments blob instead of losing the whole list', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 'edit_file', arguments: '{ truncated' } },
          call('edit_file', { filepath: 'js/b.js' }),
        ],
      },
    ];

    expect(collectWrittenFiles(messages)).toEqual(['js/b.js']);
  });

  it('emits nothing when the conversation changed no files', () => {
    expect(recordedActionsBlock([{ role: 'user', content: 'hello' }])).toBe('');
  });
});

describe('runCompaction repo snapshot', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: 'did the first task' },
    { role: 'user', content: 'second task' },
  ];

  it('keeps the current working-tree snapshot outside the model summary', async () => {
    const c = conv([...messages]);
    const h = harness(c, async () => long('summary'));
    h.deps.snapshotRepoState = async () => '\n\nWORKING TREE: 2 files changed';

    await expect(runCompaction(h.deps, c.id, { auto: true })).resolves.toBe('compacted');
    expect(c.compaction?.repoState).toContain('WORKING TREE: 2 files changed');
    expect(c.compaction?.summary).not.toContain('WORKING TREE: 2 files changed');
  });

  it('captures the snapshot before the summarization request, not after', async () => {
    const order: string[] = [];
    const c = conv([...messages]);
    const h = harness(c, async () => {
      order.push('summarize');
      return long('summary');
    });
    h.deps.snapshotRepoState = async () => {
      order.push('snapshot');
      return '';
    };

    await runCompaction(h.deps, c.id, { auto: true });
    expect(order).toEqual(['snapshot', 'summarize']);
  });

  it('still compacts when the snapshot is unavailable', async () => {
    const c = conv([...messages]);
    const h = harness(c, async () => long('summary'));
    h.deps.snapshotRepoState = async () => '';

    await expect(runCompaction(h.deps, c.id, { auto: true })).resolves.toBe('compacted');
    expect(c.compaction?.summary).toContain('summary');
  });

  it('treats a rejecting injected snapshot as unavailable', async () => {
    const c = conv([...messages]);
    const h = harness(c, async () => long('summary'));
    h.deps.snapshotRepoState = async () => {
      throw new Error('injected snapshot failed');
    };

    await expect(runCompaction(h.deps, c.id, { auto: true })).resolves.toBe('compacted');
    expect(c.compaction?.summary).toContain('summary');
    expect(h.posted.some((m) => m.type === 'generationStarted')).toBe(true);
  });

  it('compacts unchanged when no snapshot dep is wired at all', async () => {
    const c = conv([...messages]);
    const h = harness(c, async () => long('summary'));
    expect(h.deps.snapshotRepoState).toBeUndefined();

    await expect(runCompaction(h.deps, c.id, { auto: true })).resolves.toBe('compacted');
  });
});

describe('runCompaction', () => {
  it('pins a completed download in both the summary request and compacted context', async () => {
    const c = conv([
      { role: 'user', content: 'install Krea 2' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'download',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ command: 'download krea2' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'Downloaded krea2_turbo_fp8_scaled.safetensors\n[exit code: 0]',
        tool_call_id: 'download',
      },
      { role: 'assistant', content: 'Krea 2 is installed and verified.' },
      { role: 'user', content: 'continue' },
    ]);
    const h = harness(c, async () => long('summary'));
    const runPrompt = vi.fn(async () => long('summary'));
    h.deps.runPromptToMarkdown = runPrompt;

    await expect(runCompaction(h.deps, c.id, { auto: true })).resolves.toBe('compacted');

    expect(runPrompt.mock.calls[0]?.[0]).toContain('Downloaded krea2_turbo_fp8_scaled.safetensors');
    expect(renderRecordedActionsBlock(c.compaction?.recordedActions ?? [])).toContain(
      'Downloaded krea2_turbo_fp8_scaled.safetensors',
    );
    expect(RESUME_PROMPT).toBe('Continue the active task from the compacted context.');
  });

  it('associates its summary request with the compacted conversation', async () => {
    const c = conv([
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'did the first task' },
      { role: 'user', content: 'second task' },
    ]);
    const h = harness(c, async () => long('summary'));
    const runPrompt = vi.fn(async () => long('summary'));
    h.deps.runPromptToMarkdown = runPrompt;

    await runCompaction(h.deps, c.id, { auto: true });

    expect(runPrompt).toHaveBeenCalledWith(
      expect.any(String),
      c.id,
      expect.objectContaining({
        systemPromptTemplate: 'summarize',
        alwaysStripThinking: true,
      }),
    );
  });

  it('preserves user decisions and host facts across repeated compactions', async () => {
    const c = conv([
      { role: 'user', content: 'build the music-video workflow' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'write',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"workflow.json"}' },
          },
        ],
      },
      { role: 'tool', content: 'Wrote workflow.json', tool_call_id: 'write' },
      { role: 'assistant', content: 'Workflow created.' },
      { role: 'user', content: 'keep the walking-toward-camera version' },
      { role: 'assistant', content: 'Decision recorded.' },
    ]);
    const h = harness(c, async () => long('summary'));

    await runCompaction(h.deps, c.id, { auto: true });
    c.messages.push(
      { role: 'user', content: 'do not add a camera push' },
      { role: 'assistant', content: 'I will keep the camera fixed.' },
    );
    await runCompaction(h.deps, c.id, { auto: true });
    c.messages.push(
      { role: 'user', content: 'continue with that exact direction' },
      { role: 'assistant', content: 'Continuing.' },
    );
    await runCompaction(h.deps, c.id, { auto: true });

    expect(c.compaction?.generation).toBe(3);
    expect(c.compaction?.userMessages).toEqual([
      'build the music-video workflow',
      'keep the walking-toward-camera version',
      'do not add a camera push',
    ]);
    expect(renderRecordedActionsBlock(c.compaction?.recordedActions ?? [])).toContain(
      'workflow.json',
    );
    const modelContext = applyCompactionWindow(c.messages, c.compaction)
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    expect(modelContext).toContain('build the music-video workflow');
    expect(modelContext).toContain('keep the walking-toward-camera version');
    expect(modelContext).toContain('do not add a camera push');
    expect(modelContext).toContain('continue with that exact direction');
  });

  const base: ChatMessage[] = [
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: 'did the first task' },
    { role: 'user', content: 'second task' },
    { role: 'assistant', content: 'working on it' },
  ];

  it('refuses to store a tool call as the conversation summary', async () => {
    const c = conv([
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'did the first task' },
      { role: 'user', content: 'second task' },
    ]);
    const h = harness(c, async () => '{ "tool": "read_file", "arguments": { "path": "a.md" } }');

    const outcome = await runCompaction(h.deps, c.id, { auto: true });

    expect(outcome).toBe('failed');
    expect(c.compaction).toBeUndefined();
  });

  it('appends the changed files even when the summarizer never mentions them', async () => {
    const c = conv([
      { role: 'user', content: 'fix the fetch' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'edit_file', arguments: JSON.stringify({ filepath: 'index.html' }) },
          },
        ],
      },
      { role: 'tool', content: 'edited' },
      { role: 'user', content: 'thanks' },
    ]);
    // The summary names nothing - exactly the case where the source cap hid the
    // file from the model. Measured on session 39c9bf42: 2 of 6 changed files.
    const h = harness(c, async () => long('Goal: fix the fetch'));

    await runCompaction(h.deps, c.id, { auto: true });

    const recorded = renderRecordedActionsBlock(c.compaction?.recordedActions ?? []);
    expect(recorded).toContain('index.html');
    expect(recorded).toContain('recorded by Forge');
  });

  it('records the cut point from the pre-await snapshot, not the later length', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => {
      // A turn that lands while the summary is still streaming. Reading
      // messages.length afterwards used to bury it behind the cut.
      c.messages.push({ role: 'user', content: 'raced prompt' });
      c.messages.push({ role: 'assistant', content: 'raced reply' });
      return long('summary of the first task');
    });

    const outcome = await runCompaction(h.deps, c.id, { auto: true });

    expect(outcome).toBe('compacted');
    expect(c.compaction).toMatchObject({
      summary: long('summary of the first task'),
      fromIndex: 2,
      generation: 1,
      userMessages: ['first task'],
    });
    const sent = applyCompactionWindow(c.messages, c.compaction);
    expect(sent.map((m) => m.content)).toContain('raced prompt');
    expect(sent.map((m) => m.content)).toContain('second task');
  });

  it('marks the conversation busy for the summarization and releases it after', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => long('summary'));

    await runCompaction(h.deps, c.id, { auto: true });

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

    const outcome = await runCompaction(h.deps, c.id, { auto: true });

    expect(outcome).toBe('failed');
    expect(c.compaction).toBeUndefined();
    expect(h.released).toBe(true);
    expect(h.posted.some((m) => m.type === 'done')).toBe(true);
    expect(h.posted.some((m) => m.type === 'error')).toBe(true);
  });

  it('caps the persisted checkpoint instead of allowing it to become a second transcript', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => 'x'.repeat(COMPACTION_SUMMARY_MAX_CHARS + 100));

    expect(await runCompaction(h.deps, c.id, { auto: true })).toBe('compacted');
    expect(c.compaction?.summary.length).toBe(COMPACTION_SUMMARY_MAX_CHARS + 13);
    expect(c.compaction?.summary).toContain('…[truncated]');
  });

  it('emits started once and finished(compacted) after validation', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => long('summary'));
    const events: unknown[] = [];
    const deps: CompactionDeps = { ...h.deps, emitCompactionEvent: (event) => events.push(event) };

    expect(await runCompaction(deps, c.id, { auto: true, trigger: 'auto' })).toBe('compacted');
    expect(events).toEqual([
      { conversationId: c.id, phase: 'started', trigger: 'auto' },
      { conversationId: c.id, phase: 'finished', outcome: 'compacted', trigger: 'auto' },
    ]);
  });

  it('logs the compaction with the context measured BEFORE the counters are cleared', async () => {
    const c = conv([...base]);
    c.last_input_tokens = 44_000;
    c.last_output_tokens = 1_200;
    const h = harness(c, async () => long('summary'));
    const rows: CompactionLogEntry[] = [];
    const deps: CompactionDeps = {
      ...h.deps,
      // The real wiring deletes both counters here. Doing the same in the test
      // is the point: reading them after this call would log 0, and the row
      // exists to carry the exact figure the server reported.
      invalidateExactTokenBudget: (target) => {
        delete target.last_input_tokens;
        delete target.last_output_tokens;
      },
      compactionMetrics: () => ({ max: 58_000, threshold: 0.8 }),
      logCompaction: (_target, entry) => rows.push(entry),
    };

    expect(await runCompaction(deps, c.id, { auto: true, trigger: 'auto' })).toBe('compacted');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      generation: 1,
      usedTokens: 45_200,
      maxTokens: 58_000,
      threshold: 0.8,
      trigger: 'auto',
      fromIndex: c.compaction?.fromIndex,
    });
    expect(rows[0]?.summaryChars).toBe(c.compaction?.summary.length);
  });

  it('names the size at the cut in the notice, using the pre-invalidation figure', async () => {
    const c = conv([...base]);
    c.last_input_tokens = 44_000;
    c.last_output_tokens = 1_200;
    const h = harness(c, async () => long('summary'));
    const deps: CompactionDeps = {
      ...h.deps,
      invalidateExactTokenBudget: (target) => {
        delete target.last_input_tokens;
        delete target.last_output_tokens;
      },
      compactionMetrics: () => ({ max: 58_000 }),
    };

    expect(await runCompaction(deps, c.id, { auto: true })).toBe('compacted');
    const notice = h.posted.find(
      (m) => m.type === 'notice' && m.message.startsWith('Conversation compacted'),
    );
    expect(notice).toMatchObject({
      message: `Conversation compacted at ${(45_200).toLocaleString()} / ${(58_000).toLocaleString()}. Chat history is unchanged.`,
    });
  });

  it('omits the size when the model has no configured window', async () => {
    const c = conv([...base]);
    c.last_input_tokens = 44_000;
    const h = harness(c, async () => long('summary'));
    const deps: CompactionDeps = { ...h.deps, compactionMetrics: () => ({ max: 0 }) };

    expect(await runCompaction(deps, c.id, { auto: true })).toBe('compacted');
    expect(
      h.posted.some(
        (m) => m.type === 'notice' && m.message === 'Conversation compacted. Chat history is unchanged.',
      ),
    ).toBe(true);
  });

  it('does not log when the summary is rejected', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => '');
    const rows: CompactionLogEntry[] = [];
    const deps: CompactionDeps = { ...h.deps, logCompaction: (_t, entry) => rows.push(entry) };

    expect(await runCompaction(deps, c.id, { auto: true })).toBe('failed');
    expect(rows).toEqual([]);
  });

  it('compacts normally when nothing is listening for the log row', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => long('summary'));

    expect(await runCompaction(h.deps, c.id, { auto: true })).toBe('compacted');
  });

  it('emits finished(failed) when the summarization throws', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => {
      throw new Error('backend down');
    });
    const events: unknown[] = [];
    const deps: CompactionDeps = { ...h.deps, emitCompactionEvent: (event) => events.push(event) };

    expect(await runCompaction(deps, c.id, { auto: true, trigger: 'auto' })).toBe('failed');
    expect(events).toEqual([
      { conversationId: c.id, phase: 'started', trigger: 'auto' },
      { conversationId: c.id, phase: 'finished', outcome: 'failed', trigger: 'auto' },
    ]);
  });

  it('emits finished(failed) when persisting a usable summary throws', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => long('summary'));
    const events: unknown[] = [];
    const deps: CompactionDeps = {
      ...h.deps,
      persistSession: () => {
        throw new Error('storage unavailable');
      },
      emitCompactionEvent: (event) => events.push(event),
    };

    expect(await runCompaction(deps, c.id, { auto: true, trigger: 'auto' })).toBe('failed');
    expect(events).toEqual([
      { conversationId: c.id, phase: 'started', trigger: 'auto' },
      { conversationId: c.id, phase: 'finished', outcome: 'failed', trigger: 'auto' },
    ]);
    expect(h.released).toBe(true);
  });

  it('emits nothing when there is not enough history to compact', async () => {
    const c = conv([]);
    const h = harness(c, async () => long('summary'));
    const events: unknown[] = [];
    const deps: CompactionDeps = { ...h.deps, emitCompactionEvent: (event) => events.push(event) };

    expect(await runCompaction(deps, c.id, { auto: true, trigger: 'auto' })).toBe('skipped');
    expect(events).toEqual([]);
  });

  it('skips while a turn is streaming', async () => {
    const c = conv([...base]);
    const h = harness(c, async () => long('summary'));
    const deps = { ...h.deps, isStreaming: () => true };

    expect(await runCompaction(deps, c.id, { auto: false })).toBe('skipped');
    expect(c.compaction).toBeUndefined();
  });

  it('re-compacting summarizes only what the previous summary did not cover', async () => {
    const c = conv([...base]);
    c.compaction = { summary: 'earlier summary', fromIndex: 2 };
    c.messages.push({ role: 'user', content: 'third task' });
    c.messages.push({ role: 'assistant', content: 'still working' });
    let prompt = '';
    const h = harness(c, async () => long('newer summary'));
    const deps: CompactionDeps = {
      ...h.deps,
      runPromptToMarkdown: async (text) => {
        prompt = text;
        return long('newer summary');
      },
    };

    await runCompaction(deps, c.id, { auto: true });

    expect(prompt).toContain('EARLIER SUMMARY:\nearlier summary');
    expect(prompt).toContain('second task');
    expect(prompt).not.toContain('third task');
    expect(c.compaction?.fromIndex).toBe(4);
  });
});
