import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
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
      record: vi.fn((id?: string) => trackerUpdates.push(`record:${id ?? ''}`)),
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
      readTool('search_code', async (args) => {
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
      makeToolCall('search_code', { query: 'first' }, 'read-1'),
      makeToolCall('search_code', { query: 'second' }, 'read-2'),
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
      readTool('search_code', async (args) => {
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
        makeToolCall('search_code', { query: 'before' }, 'before'),
        makeToolCall('write_file', {}, 'write'),
        makeToolCall('search_code', { query: 'after' }, 'after'),
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

  it('runs a read that needs approval serially in its original position', async () => {
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
    requestApproval.mockImplementation(async () => {
      steps.push('approval');
      return 'approved';
    });

    await dispatch.dispatch(
      [
        makeToolCall('read_file', { path: '.env' }, 'secret'),
        makeToolCall('list_directory', { path: '.' }, 'listing'),
      ],
      allowed,
      messages,
      'approval-order',
    );

    expect(steps).toEqual([
      'approval',
      'secret:start',
      'secret:end',
      'listing:start',
      'listing:end',
    ]);
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(messages.map((message) => message.tool_call_id)).toEqual(['secret', 'listing']);
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
          if (started === 4) controller.abort();
        }),
    );
    toolRegistry.register(readTool('search_code', handler));

    const calls = Array.from({ length: 6 }, (_, index) =>
      makeToolCall('search_code', { query: `q${index}` }, `cancel-${index}`),
    );
    await dispatch.dispatch(calls, allowed, messages, 'abort-batch', controller.signal);

    expect(started).toBe(4);
    expect(messages.map((message) => message.tool_call_id)).toEqual(
      calls.map((call) => call.id),
    );
    expect(messages.map((message) => message.content)).toEqual(
      calls.map(() => 'Error: tool execution cancelled'),
    );
    expect(failureTracker.record).not.toHaveBeenCalled();
    expect(failureTracker.reset).not.toHaveBeenCalled();
    expect(post.mock.calls.map(([event]) => event.toolCallId)).toEqual(calls.map((call) => call.id));
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('applies failure tracker updates in call order after the batch settles', async () => {
    const completed: string[] = [];
    toolRegistry.register(
      readTool('search_code', async (args) => {
        const query = args['query'] as string;
        await pause(query === 'success' ? 40 : 5);
        completed.push(query);
        if (query === 'failure') throw new Error('read failed');
        return 'read succeeded';
      }),
    );

    await dispatch.dispatch(
      [
        makeToolCall('search_code', { query: 'success' }, 'success'),
        makeToolCall('search_code', { query: 'failure' }, 'failure'),
      ],
      allowed,
      messages,
      'failure-order',
    );

    expect(completed).toEqual(['failure', 'success']);
    expect(trackerUpdates).toEqual(['reset:failure-order', 'record:failure-order']);
    expect(messages.map((message) => message.tool_call_id)).toEqual(['success', 'failure']);
    expect(messages[1]?.content).toContain('read failed');
  });
});
