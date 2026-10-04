import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import {
  CONTEXT_EXHAUSTED_MESSAGE,
  CONTEXT_INPUT_EXHAUSTED_MESSAGE,
  runToolCallingLoop,
} from '../../src/agent/ToolCallingLoop';
import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import { compactMidTurn, MID_TURN_RESUME_NUDGE } from '../../src/sidebar/midTurnCompaction';
import { prepareToolResultContext } from '../../src/agent/toolResultContext';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

interface Handlers {
  onToken: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
  onError: (err: Error) => void;
}

function runOptions(messages: ChatMessage[], extra: Record<string, unknown> = {}) {
  return {
    resolveBaseUrl: async () => 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    getToolDefinitions: () => [{ type: 'function', function: { name: 'write_file' } }] as never,
    dispatchToolCalls: async (calls: ToolCall[], msgs: ChatMessage[]) => {
      for (const c of calls) {
        msgs.push({ role: 'tool', content: 'ok', tool_call_id: c.id, name: c.function.name });
      }
    },
    signal: new AbortController().signal,
    maxRounds: 8,
    nativeTools: true,
    ...extra,
  };
}

const truncated = (id: string): ToolCallTruncatedError =>
  new ToolCallTruncatedError({
    toolName: 'write_file',
    toolCallId: id,
    approxBytes: 9000,
    finishReason: 'length',
  });

describe('tool loop mid-turn compaction', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('asks between rounds and re-prepares the request after compacting', async () => {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_u: string, req: { messages: ChatMessage[] }, _m: unknown, h: Handlers) => {
        round += 1;
        if (round === 1) {
          h.onToolCalls([
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } },
          ]);
          h.onDone('tool_calls');
          return;
        }
        // The second request must be built from the post-compaction transcript.
        expect(req.messages.at(-1)?.content).toBe('compacted-marker');
        h.onToken('done');
        h.onDone('stop');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const requests: boolean[] = [];
    const compact = vi.fn(async ({ exhausted }: { exhausted: boolean }) => {
      requests.push(exhausted);
      if (requests.length !== 2) return false;
      messages.push({ role: 'user', content: 'compacted-marker', internal: true });
      return true;
    });
    const result = await runToolCallingLoop(runOptions(messages, { compactMidTurn: compact }) as never);
    expect(result.finalText).toBe('done');
    expect(requests).toEqual([false, false]);
  });

  it('compacts instead of failing when truncation retries run out', async () => {
    let round = 0;
    let compacted = false;
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        round += 1;
        if (!compacted) {
          h.onError(truncated(`call_${round}`));
          return;
        }
        h.onToken('fits now');
        h.onDone('stop');
      },
    );
    const exhaustedFlags: boolean[] = [];
    const result = await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        compactMidTurn: async ({ exhausted }: { exhausted: boolean }) => {
          exhaustedFlags.push(exhausted);
          if (!exhausted) return false;
          compacted = true;
          return true;
        },
      }) as never,
    );
    expect(result.finalText).toBe('fits now');
    // Three cut-offs (the original + MAX_TRUNCATION_RECOVERIES), then a forced compaction.
    expect(round).toBe(4);
    expect(exhaustedFlags.at(-1)).toBe(true);
  });

  it('still fails when compaction cannot help', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => h.onError(truncated('x')),
    );
    await expect(
      runToolCallingLoop(
        runOptions([{ role: 'user', content: 'go' }], { compactMidTurn: async () => false }) as never,
      ),
    ).rejects.toThrow(CONTEXT_EXHAUSTED_MESSAGE);
  });

  it('stops compacting after the per-turn cap', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => h.onError(truncated('x')),
    );
    const compact = vi.fn(async ({ exhausted }: { exhausted: boolean }) => exhausted);
    await expect(
      runToolCallingLoop(
        runOptions([{ role: 'user', content: 'go' }], {
          compactMidTurn: compact,
          maxRounds: 40,
        }) as never,
      ),
    ).rejects.toThrow(CONTEXT_EXHAUSTED_MESSAGE);
    expect(compact.mock.results.filter((r) => r.type === 'return').length).toBeGreaterThan(0);
    const forced = compact.mock.calls.filter(([req]) => req.exhausted).length;
    expect(forced).toBe(2);
  });

  it('resets the cap once a compaction has bought a stretch of work', async () => {
    // A long healthy turn: every round is a tool call, and the threshold is
    // crossed again every 12 rounds. The per-turn cap used to stop at 2.
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        round += 1;
        if (round > 40) {
          h.onToken('done');
          h.onDone('stop');
          return;
        }
        h.onToolCalls([
          {
            id: `c${round}`,
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: `f${round}` }) },
          },
        ]);
        h.onDone('tool_calls');
      },
    );
    let calls = 0;
    let compactions = 0;
    const compact = vi.fn(async () => (++calls % 12 === 0 ? ++compactions > 0 : false));
    const result = await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        compactMidTurn: compact,
        maxRounds: 50,
      }) as never,
    );
    expect(result.finalText).toBe('done');
    expect(compactions).toBe(3);
  });

  it('compacts on the server context 400 when a compactor is wired', async () => {
    let compacted = false;
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        if (!compacted) {
          h.onError(new Error('HTTP 400: exceeds the available context size'));
          return;
        }
        h.onToken('ok');
        h.onDone('stop');
      },
    );
    const result = await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        compactMidTurn: async ({ exhausted }: { exhausted: boolean }) =>
          exhausted ? (compacted = true) : false,
      }) as never,
    );
    expect(result.finalText).toBe('ok');
  });

  it('keeps the old refusal when no compactor is wired', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) =>
        h.onError(new Error('HTTP 400: exceeds the available context size')),
    );
    await expect(
      runToolCallingLoop(runOptions([{ role: 'user', content: 'go' }]) as never),
    ).rejects.toThrow(CONTEXT_INPUT_EXHAUSTED_MESSAGE);
  });
});

describe('compactMidTurn policy', () => {
  const conv = (): ConversationRuntime =>
    ({ id: 'c1', title: 't', messages: [], createdAt: 0, updatedAt: 0 }) as ConversationRuntime;
  const deps = (autoCompact: ForgeConfig['auto_compact'], used: number, outcome = 'compacted') => {
    const compact = vi.fn(async () => outcome as 'compacted' | 'skipped' | 'failed');
    return {
      compact,
      deps: {
        getConfig: () => ({ auto_compact: autoCompact }) as ForgeConfig,
        snapshot: () => ({ used, max: 1000 }),
        compact,
      },
    };
  };

  it('does nothing unless auto_compact is enabled with resume', async () => {
    for (const cfg of [undefined, { enabled: false }, { enabled: true, resume: false }]) {
      const h = deps(cfg, 990);
      await expect(compactMidTurn(h.deps, conv(), { exhausted: true })).resolves.toBe(false);
      expect(h.compact).not.toHaveBeenCalled();
    }
  });

  it('waits for the threshold unless the next round cannot fit', async () => {
    const below = deps({ enabled: true, at: 0.8 }, 700);
    await expect(compactMidTurn(below.deps, conv(), { exhausted: false })).resolves.toBe(false);
    expect(below.compact).not.toHaveBeenCalled();

    const c = conv();
    const above = deps({ enabled: true, at: 0.8 }, 850);
    await expect(compactMidTurn(above.deps, c, { exhausted: false })).resolves.toBe(true);
    expect(c.messages.at(-1)).toEqual({
      role: 'user',
      content: MID_TURN_RESUME_NUDGE,
      internal: true,
    });

    const forced = deps({ enabled: true }, 0);
    await expect(compactMidTurn(forced.deps, conv(), { exhausted: true })).resolves.toBe(true);
  });

  it('uses the raw prompt estimate when the reported trimmed count is below threshold', async () => {
    const enabled = deps({ enabled: true, at: 0.9 }, 830);
    await expect(
      compactMidTurn(enabled.deps, conv(), { exhausted: false, rawUsed: 1_050 } as never),
    ).resolves.toBe(true);
    expect(enabled.compact).toHaveBeenCalledOnce();

    const disabled = deps({ enabled: false, at: 0.9 }, 830);
    await expect(
      compactMidTurn(disabled.deps, conv(), { exhausted: false, rawUsed: 1_050 } as never),
    ).resolves.toBe(false);
    expect(disabled.compact).not.toHaveBeenCalled();

    const advanced = deps({ enabled: true, at: 0.9 }, 500);
    await expect(
      compactMidTurn(advanced.deps, conv(), {
        exhausted: false,
        rawUsed: 500,
        trimAdvanced: true,
      } as never),
    ).resolves.toBe(true);
    expect(advanced.compact).toHaveBeenCalledOnce();
  });

  it('passes raw estimate and trim advancement from preparation into the compaction check', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_u: string, _r: unknown, _m: unknown, h: Handlers) => {
        h.onToken('done');
        h.onDone('stop');
      },
    );
    let checked: { exhausted: boolean; rawUsed?: number; trimAdvanced?: boolean } | undefined;
    await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        prepareMessages: () => ({
          messages: [{ role: 'user', content: 'trimmed' }],
          used: 100,
          rawUsed: 1_050,
          inputBudget: 500,
          fits: true,
          excerptedToolCallIds: [],
          trimAdvanced: true,
        }),
        compactMidTurn: async (request: {
          exhausted: boolean;
          rawUsed?: number;
          trimAdvanced?: boolean;
        }) => {
          checked = request;
          return false;
        },
      }) as never,
    );

    expect(checked).toEqual({ exhausted: false, rawUsed: 1_050, trimAdvanced: true });
  });

  it('adds no nudge when compaction did not happen', async () => {
    const c = conv();
    const h = deps({ enabled: true }, 990, 'failed');
    await expect(compactMidTurn(h.deps, c, { exhausted: true })).resolves.toBe(false);
    expect(c.messages).toEqual([]);
  });
});

describe('runCompaction midTurn', () => {
  const summary = `Goal: continue the request.\nState: summary recorded. ${'detail. '.repeat(30)}\nNext: continue.\nFiles: src/a.ts.\nConstraints: none.\nErrors: none.`;

  function harness(streaming: boolean) {
    const posted: HostToWebview[] = [];
    const conversation = {
      id: 'c1',
      title: 't',
      createdAt: 0,
      updatedAt: 0,
      contextTrimState: { reasoningDropped: 1, excerpts: new Map([['stale', 2_000]]) },
      messages: [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'did it' },
        { role: 'user', content: 'second task' },
      ],
    } as ConversationRuntime;
    const beginCompaction = vi.fn(() => () => undefined);
    const deps: CompactionDeps = {
      post: (msg) => posted.push(msg),
      getConversation: () => conversation,
      persistSession: () => undefined,
      postSessionSync: () => undefined,
      invalidateExactTokenBudget: () => undefined,
      postTokenBudget: () => undefined,
      isStreaming: () => streaming,
      beginCompaction,
      runPromptToMarkdown: async () => summary,
    };
    return { deps, posted, beginCompaction, conversation };
  }

  it('runs while the turn streams, without touching its streaming state', async () => {
    const h = harness(true);
    await expect(
      runCompaction(h.deps, 'c1', { auto: true, trigger: 'auto', midTurn: true }),
    ).resolves.toBe('compacted');
    expect(h.beginCompaction).not.toHaveBeenCalled();
    expect(h.posted.some((m) => m.type === 'generationStarted' || m.type === 'done')).toBe(false);
    expect(h.conversation.compaction?.summary).toContain('summary');
    expect(h.conversation.contextTrimState).toEqual({ reasoningDropped: 0, excerpts: new Map() });

    const nextMessages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, reasoning_content: 'keep this reasoning' },
      { role: 'tool', tool_call_id: 'stale', content: 'x'.repeat(20_000) },
    ];
    const model = { name: 'local', num_ctx: 30_000 } as never;
    const afterCompaction = prepareToolResultContext({
      messages: nextMessages,
      toolTokens: 0,
      model,
      state: h.conversation.contextTrimState,
    });
    const fresh = prepareToolResultContext({ messages: nextMessages, toolTokens: 0, model });
    expect(afterCompaction.messages).toEqual(fresh.messages);
  });

  it('still refuses a normal compaction during a turn', async () => {
    const h = harness(true);
    await expect(runCompaction(h.deps, 'c1', { auto: true })).resolves.toBe('skipped');
  });
});
