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
import type {
  RegisteredTool,
  ToolHandlerContext,
  ToolPermission,
} from '../../src/tools/ToolRegistry';
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
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
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
          properties: { query: { type: 'string' }, path: { type: 'string' }, delay: { type: 'integer' } },
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

describe('ToolDispatch parallel read failure handling', () => {
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

  it('still commits every other result when the round-ending drain rethrows a failed parked call', async () => {
    // The parked call is the head of the held queue, and the read behind it commits
    // only once the head settles. When that head has FAILED, the drain that ends the
    // round is the one that throws — and it has to throw through the catch that drains
    // the rest, or the read's tool-result row never reaches the model and its call is
    // left permanently unanswered.
    toolRegistry.register(
      readTool('read_file', async () => 'never returns', () => ({ dangerous: true, detail: 'secret path' })),
    );
    toolRegistry.register(readTool('list_directory', async () => 'entries'));
    const context: ToolDispatchRoundContext = {
      allowed,
      convId: 'final-drain',
      signal: undefined,
      checkpoint: undefined,
      budget: undefined,
      recordFileDiff: undefined,
      unavailableTools: undefined,
      setPlan: undefined,
      tellArrived: undefined,
      modelContext: undefined,
    };

    await expect(
      dispatchWithParallelReads(
        [
          makeToolCall('read_file', { path: '.env' }, 'parked'),
          makeToolCall('list_directory', { path: '.' }, 'listing'),
        ],
        context,
        toolRegistry,
        messages,
        failureTracker,
        post,
        async () => {
          throw new Error('dispatchSerial must not run here');
        },
        async (call, _approval, effects) => {
          if (call.id === 'parked') {
            // Leave both calls in the queue until the round-ending drain.
            await pause(20);
            throw new Error('the parked call failed');
          }
          effects.messages.push({ role: 'tool', tool_call_id: call.id, content: 'entries' });
        },
      ),
    ).rejects.toThrow('the parked call failed');

    expect(messages.map((message) => message.tool_call_id)).toEqual(['listing']);
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
    expect(applied).toEqual(['parse:conv-a', 'reset:conv-a']);
  });
});
