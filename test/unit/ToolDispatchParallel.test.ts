import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import {
  commitBufferedToolDispatchEffects,
  createBufferedToolDispatchEffects,
  dispatchWithParallelReads,
} from '../../src/sidebar/ToolDispatchParallel';
import type { ToolDispatchRoundContext } from '../../src/sidebar/toolDispatchTypes';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import type { RegisteredTool, ToolHandlerContext, ToolPermission } from '../../src/tools/ToolRegistry';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { clearConversationUntrustedState } from '../../src/tools/exfilTaint';
import { resetLazyToolGroups } from '../../src/tools/lazyToolGroups';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    openTextDocument: vi.fn().mockResolvedValue({}),
    asRelativePath: vi.fn((value: string) => value),
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
  },
  window: {
    showTextDocument: vi.fn().mockResolvedValue(undefined),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  Uri: { file: vi.fn((value: string) => ({ fsPath: value })) },
}));

const allowed = new Set<ToolPermission>(['read', 'write', 'git-read']);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeToolCall(name: string, args: Record<string, unknown>, id: string): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function readTool(
  name: string,
  handler: (args: Record<string, unknown>, context?: ToolHandlerContext) => Promise<string>,
  approval?: RegisteredTool['approval'],
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: 'Test read',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            path: { type: 'string' },
            delay: { type: 'integer' },
          },
          required: [],
          additionalProperties: true,
        },
      },
    },
    permission: 'read',
    ...(approval ? { approval } : {}),
    handler,
  };
}

describe('ToolDispatch parallel read batches', () => {
  let toolRegistry: ToolRegistry;
  let failureTracker: ToolFailureTracker;
  let trackerUpdates: string[];
  let post: ReturnType<typeof vi.fn>;
  let requestApproval: ReturnType<typeof vi.fn>;
  let dispatch: ToolDispatch;
  let messages: ChatMessage[];

  beforeEach(() => {
    resetLazyToolGroups();
    clearConversationUntrustedState();
    toolRegistry = new ToolRegistry();
    trackerUpdates = [];
    failureTracker = {
      recordNativeParseFailure: vi.fn((id?: string) => trackerUpdates.push(`parse:${id ?? ''}`)),
      reset: vi.fn((id?: string) => trackerUpdates.push(`reset:${id ?? ''}`)),
      shouldStrip: vi.fn().mockReturnValue(false),
    } as unknown as ToolFailureTracker;
    post = vi.fn();
    requestApproval = vi.fn().mockResolvedValue('approved');
    dispatch = new ToolDispatch(
      toolRegistry,
      {
        snapshotBefore: vi.fn(),
        readSnapshotContent: vi.fn(),
        beginTurn: vi.fn(),
        commitTurn: vi.fn(),
        undo: vi.fn(),
        keep: vi.fn(),
        depth: vi.fn().mockReturnValue(0),
        canUndo: vi.fn().mockReturnValue(false),
      } as unknown as CheckpointStack,
      { markPending: vi.fn(), clearPending: vi.fn() } as unknown as KeepUndoCodeLensProvider,
      failureTracker,
      post,
      requestApproval,
      { apply: vi.fn() } as unknown as DiffDecorations,
    );
    messages = [];
  });

  afterEach(() => {
    clearConversationUntrustedState();
    resetLazyToolGroups();
  });

  it('runs two delayed reads concurrently and appends results in call order', async () => {
    let active = 0;
    let maxActive = 0;
    const completed: string[] = [];
    toolRegistry.register(
      readTool('grep_search', async (args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const query = args['query'] as string;
        await pause(query === 'first' ? 45 : 5);
        completed.push(query);
        active -= 1;
        return query;
      }),
    );

    const calls = [
      makeToolCall('grep_search', { query: 'first' }, 'read-1'),
      makeToolCall('grep_search', { query: 'second' }, 'read-2'),
    ];
    await dispatch.dispatch(calls, allowed, messages, 'parallel-order');

    expect(maxActive).toBe(2);
    expect(completed).toEqual(['second', 'first']);
    expect(messages.map((message) => message.tool_call_id)).toEqual(['read-1', 'read-2']);
    expect(messages.map((message) => message.content)).toEqual(['first', 'second']);
    expect(post.mock.calls.map(([event]) => event.toolCallId)).toEqual(['read-1', 'read-2']);
  });

  it('keeps a write between two reads in its original position', async () => {
    const steps: string[] = [];
    toolRegistry.register(
      readTool('grep_search', async (args) => {
        const label = args['query'] as string;
        steps.push(`${label}:start`);
        await pause(5);
        steps.push(`${label}:end`);
        return label;
      }),
    );
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Test write',
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      },
      permission: 'write',
      mutation: { paths: () => [] },
      handler: async () => {
        steps.push('write:start');
        steps.push('write:end');
        return 'written';
      },
    });

    await dispatch.dispatch(
      [
        makeToolCall('grep_search', { query: 'before' }, 'before'),
        makeToolCall('write_file', {}, 'write'),
        makeToolCall('grep_search', { query: 'after' }, 'after'),
      ],
      allowed,
      messages,
      'read-write-read',
    );

    expect(steps).toEqual([
      'before:start',
      'before:end',
      'write:start',
      'write:end',
      'after:start',
      'after:end',
    ]);
    expect(messages.map((message) => message.tool_call_id)).toEqual(['before', 'write', 'after']);
  });

  it('waits for the whole parallel read batch before suspending on ask_user', async () => {
    const steps: string[] = [];
    const read = async (label: string): Promise<string> => {
      steps.push(`${label}:start`);
      await pause(10);
      steps.push(`${label}:end`);
      return label;
    };
    toolRegistry.register(readTool('grep_search', async () => read('read-a')));
    toolRegistry.register(readTool('list_directory', async () => read('read-b')));
    const calls = [
      makeToolCall('grep_search', { query: 'a' }, 'read-a'),
      makeToolCall('list_directory', { query: 'b' }, 'read-b'),
      makeToolCall('ask_user', {}, 'question'),
    ];
    const context: ToolDispatchRoundContext = {
      allowed,
      convId: 'question-after-reads',
      signal: undefined,
      checkpoint: undefined,
      budget: undefined,
      recordFileDiff: undefined,
      unavailableTools: undefined,
      setPlan: undefined,
      tellArrived: undefined,
      modelContext: undefined,
    };
    await dispatchWithParallelReads(
      calls,
      context,
      toolRegistry,
      messages,
      failureTracker,
      post,
      async (call) => {
        expect(call.function.name).toBe('ask_user');
        steps.push('question:start');
        await (async (wait: () => Promise<string>) => wait())(async () => {
          steps.push('question:wait');
          return 'answered';
        });
      },
      async (call, _approval, effects) => {
        await read(call.function.name === 'grep_search' ? 'read-a' : 'read-b');
        return effects;
      },
    );

    expect(steps).toEqual([
      'read-a:start',
      'read-b:start',
      'read-a:end',
      'read-b:end',
      'question:start',
      'question:wait',
    ]);
    expect(messages).toEqual([]);
  });

  it('lets a local read run on while a gated call waits for its card', async () => {
    const steps: string[] = [];
    toolRegistry.register(
      readTool(
        'read_file',
        async () => {
          steps.push('secret:start');
          await pause(20);
          steps.push('secret:end');
          return 'secret contents';
        },
        () => ({ dangerous: true, detail: 'secret path' }),
      ),
    );
    toolRegistry.register(
      readTool('list_directory', async () => {
        steps.push('listing:start');
        steps.push('listing:end');
        return 'entries';
      }),
    );
    let releaseApproval: () => void = () => undefined;
    requestApproval.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          steps.push('approval');
          releaseApproval = () => {
            steps.push('approval:answered');
            resolve('approved');
          };
        }),
    );

    const round = dispatch.dispatch(
      [
        makeToolCall('read_file', { path: '.env' }, 'secret'),
        makeToolCall('list_directory', { path: '.' }, 'listing'),
      ],
      allowed,
      messages,
      'approval-order',
    );
    await pause(5);

    // The card is still unanswered, and the read nobody had to ask about is done.
    expect(steps).toContain('listing:end');
    expect(steps).not.toContain('secret:end');

    releaseApproval();
    await round;

    expect(steps).toEqual([
      'approval',
      'listing:start',
      'listing:end',
      'approval:answered',
      'secret:start',
      'secret:end',
    ]);
    expect(requestApproval).toHaveBeenCalledOnce();
    // Running out of order does not let the model READ them out of order.
    expect(messages.map((message) => message.tool_call_id)).toEqual(['secret', 'listing']);
  });

  it('never parks a gated call that changes the workspace', async () => {
    const steps: string[] = [];
    toolRegistry.register({
      ...readTool(
        'write_file',
        async () => {
          steps.push('write:start');
          await pause(20);
          steps.push('write:end');
          return 'Written: x.ts';
        },
        () => ({ dangerous: true, detail: 'outside the workspace' }),
      ),
      permission: 'write',
      mutation: { paths: () => ['x.ts'] },
    });
    toolRegistry.register(
      readTool('read_file', async () => {
        steps.push('read:start');
        steps.push('read:end');
        return 'contents';
      }),
    );
    let releaseApproval: () => void = () => undefined;
    requestApproval.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          steps.push('approval');
          releaseApproval = () => resolve('approved');
        }),
    );

    const round = dispatch.dispatch(
      [
        makeToolCall('write_file', { path: 'x.ts' }, 'w'),
        makeToolCall('read_file', { path: 'x.ts' }, 'r'),
      ],
      allowed,
      messages,
      'mutation-order',
    );
    await pause(5);
    // The read must not run against the file as it was before the write that is
    // still sitting on someone's approval card.
    expect(steps).not.toContain('read:start');
    releaseApproval();
    await round;
    expect(steps).toEqual(['approval', 'write:start', 'write:end', 'read:start', 'read:end']);
    expect(messages.map((message) => message.tool_call_id)).toEqual(['w', 'r']);
  });

  it('says who approved a gated call, and how long the wait cost', async () => {
    toolRegistry.register(
      readTool(
        'web_fetch',
        async () => 'fetched',
        () => ({ reachesOut: 'net', detail: 'https://example.com' }),
      ),
    );
    requestApproval.mockImplementation(
      async (
        _name: string,
        _detail: string,
        _dangerous: boolean,
        _conv: string | undefined,
        _signal: AbortSignal | undefined,
        options?: { grant?: { waitedMs?: number } },
      ) => {
        if (options?.grant) options.grant.waitedMs = 251_000;
        return 'approved';
      },
    );

    await dispatch.dispatch(
      [makeToolCall('web_fetch', { url: 'https://example.com' }, 'f')],
      allowed,
      messages,
      'grant-note',
    );

    const content = messages[0]?.content;
    expect(typeof content === 'string' ? content : '').toContain(
      '[you approved this call after 4m11s]',
    );
  });

  it('cancels the whole batch and appends cancelled results in call order', async () => {
    const controller = new AbortController();
    let started = 0;
    const handler = vi.fn(
      async (_args: Record<string, unknown>, context?: ToolHandlerContext) =>
        new Promise<string>((resolve) => {
          started += 1;
          context?.abortSignal?.addEventListener(
            'abort',
            () => resolve('Error: tool execution cancelled'),
            { once: true },
          );
          if (started === 10) controller.abort();
        }),
    );
    toolRegistry.register(readTool('grep_search', handler));

    const calls = Array.from({ length: 12 }, (_, index) =>
      makeToolCall('grep_search', { query: `q${index}` }, `cancel-${index}`),
    );
    await dispatch.dispatch(calls, allowed, messages, 'abort-batch', controller.signal);

    expect(started).toBe(10);
    expect(messages.map((message) => message.tool_call_id)).toEqual(
      calls.map((call) => call.id),
    );
    expect(messages.map((message) => message.content)).toEqual(
      calls.map(() => 'Error: tool execution cancelled'),
    );
    expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
    expect(failureTracker.reset).not.toHaveBeenCalled();
    expect(post.mock.calls.map(([event]) => event.toolCallId)).toEqual(calls.map((call) => call.id));
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('applies failure tracker updates in call order after the batch settles', async () => {
    const completed: string[] = [];
    toolRegistry.register(
      readTool('grep_search', async (args) => {
        const query = args['query'] as string;
        await pause(query === 'success' ? 40 : 5);
        completed.push(query);
        if (query === 'failure') throw new Error('read failed');
        return 'read succeeded';
      }),
    );

    await dispatch.dispatch(
      [
        makeToolCall('grep_search', { query: 'success' }, 'success'),
        makeToolCall('grep_search', { query: 'failure' }, 'failure'),
      ],
      allowed,
      messages,
      'failure-order',
    );

    expect(completed).toEqual(['failure', 'success']);
    expect(trackerUpdates).toEqual(['reset:failure-order']);
    expect(messages.map((message) => message.tool_call_id)).toEqual(['success', 'failure']);
    expect(messages[1]?.content).toContain('read failed');
  });
});

describe('buffered tracker updates commit in the order they happened', () => {
  it('applies a protocol failure before the reset of a later call', () => {
    const buffered = createBufferedToolDispatchEffects([{ role: 'user', content: 'go' }]);
    buffered.failureTracker.recordNativeParseFailure('conv-a');
    buffered.failureTracker.reset('conv-a');
    const applied: string[] = [];

    commitBufferedToolDispatchEffects(
      buffered,
      [],
      {
        reset: (id) => applied.push(`reset:${id}`),
        recordNativeParseFailure: (id) => applied.push(`parse:${id}`),
      },
      () => undefined,
    );

    // The other order leaves the streak standing after a call ran, which is the
    // opposite of what a successful call is for.
    expect(applied).toEqual(['parse:conv-a', 'reset:conv-a']);
  });
});
