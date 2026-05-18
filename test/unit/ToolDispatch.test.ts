import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch, resolveToolPath } from '../../src/sidebar/ToolDispatch';
import type { ToolCall } from '../../src/llm/types';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

// vi.mock is hoisted — compute WS inside the factory using require
vi.mock('vscode', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  const ws = p.resolve('/workspace');
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: ws } }],
      openTextDocument: vi.fn().mockResolvedValue({}),
      asRelativePath: vi.fn((s: string) => s.replace(ws + p.sep, '')),
    },
    window: {
      showTextDocument: vi.fn().mockResolvedValue(undefined),
    },
    Uri: {
      file: vi.fn((s: string) => ({ fsPath: s })),
    },
  };
});

const WS = path.resolve('/workspace');

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe('resolveToolPath', () => {
  it('returns absolute paths unchanged', () => {
    const abs = path.resolve('/absolute/path/file.ts');
    expect(resolveToolPath(abs)).toBe(abs);
  });

  it('resolves relative paths against workspace root', () => {
    expect(resolveToolPath('src/file.ts')).toBe(path.join(WS, 'src/file.ts'));
  });

  it('normalizes paths', () => {
    expect(resolveToolPath('./src/../file.ts')).toBe(path.join(WS, 'file.ts'));
  });
});

describe('ToolDispatch', () => {
  let toolRegistry: ToolRegistry;
  let checkpoints: CheckpointStack;
  let codeLens: KeepUndoCodeLensProvider;
  let failureTracker: ToolFailureTracker;
  let post: ReturnType<typeof vi.fn>;
  let requestApproval: ReturnType<typeof vi.fn>;
  let dispatch: ToolDispatch;
  const allowed = new Set(['read', 'write', 'delete', 'terminal', 'git'] as const);

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    checkpoints = {
      snapshotBefore: vi.fn(),
      beginTurn: vi.fn(),
      commitTurn: vi.fn(),
      undo: vi.fn(),
      keep: vi.fn(),
      depth: vi.fn().mockReturnValue(0),
      canUndo: vi.fn().mockReturnValue(false),
    } as unknown as CheckpointStack;

    codeLens = {
      markPending: vi.fn(),
      clearPending: vi.fn(),
    } as unknown as KeepUndoCodeLensProvider;

    failureTracker = {
      record: vi.fn(),
      reset: vi.fn(),
      shouldStrip: vi.fn().mockReturnValue(false),
    } as unknown as ToolFailureTracker;

    post = vi.fn();
    requestApproval = vi.fn().mockResolvedValue(true);

    dispatch = new ToolDispatch(
      toolRegistry,
      checkpoints,
      codeLens,
      failureTracker,
      post,
      requestApproval,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches a read tool without approval', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'read',
      handler: vi.fn().mockResolvedValue('file contents'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('read_file', { path: 'test.txt' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('file contents');
    expect(messages[0].tool_call_id).toBe('call-read_file');
  });

  it('requests approval for write tools', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'write',
      handler: vi.fn().mockResolvedValue('written'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('write_file', { path: 'test.txt', content: 'hello' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith('write_file', expect.stringContaining('hello'), false);
    expect(checkpoints.snapshotBefore).toHaveBeenCalled();
    expect(codeLens.markPending).toHaveBeenCalled();
  });

  it('requests approval for delete tools', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'Delete a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'delete',
      handler: vi.fn().mockResolvedValue('deleted'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('delete_file', { path: 'test.txt' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith('delete_file', expect.any(String), false);
  });

  it('requests approval for terminal tools', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'run_terminal',
          description: 'Run in terminal',
          parameters: { type: 'object' },
        },
      },
      permission: 'terminal',
      handler: vi.fn().mockResolvedValue('done'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('run_terminal', { command: 'echo hello' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith('run_terminal', expect.any(String), false);
  });

  it('requests approval for git tools', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'git_commit',
          description: 'Git commit',
          parameters: { type: 'object' },
        },
      },
      permission: 'git',
      handler: vi.fn().mockResolvedValue('committed'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('git_commit', { message: 'test' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith('git_commit', expect.any(String), false);
  });

  it('flags delete_file with recursive=true as dangerous', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'Delete a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'delete',
      handler: vi.fn().mockResolvedValue('deleted'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('delete_file', { path: 'src/', recursive: true })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith('delete_file', expect.any(String), true);
  });

  it('skips execution when user declines approval', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'write',
      handler: vi.fn().mockResolvedValue('written'),
    });

    requestApproval.mockResolvedValue(false);

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('write_file', { path: 'test.txt', content: 'hello' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(toolRegistry.get('write_file')?.handler).not.toHaveBeenCalled();
    expect(messages[0].content).toMatch(/declined/);
  });

  it('handles malformed JSON arguments', async () => {
    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls: ToolCall[] = [{
      id: 'call-bad',
      type: 'function',
      function: { name: 'read_file', arguments: 'not json' },
    }];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(failureTracker.record).toHaveBeenCalled();
    expect(messages[0].content).toMatch(/malformed/);
  });

  it('handles unknown tools gracefully', async () => {
    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('unknown_tool', {})];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(messages[0].content).toMatch(/unknown tool/);
  });

  it('handles tool handler exceptions', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'broken_tool',
          description: 'Always fails',
          parameters: { type: 'object' },
        },
      },
      permission: 'read',
      handler: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('broken_tool', {})];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(failureTracker.record).toHaveBeenCalled();
    expect(messages[0].content).toMatch(/boom/);
  });

  it('dispatches multiple tool calls sequentially', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'read',
      handler: vi.fn().mockResolvedValue('contents'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [
      makeToolCall('read_file', { path: 'a.txt' }),
      makeToolCall('read_file', { path: 'b.txt' }),
    ];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('contents');
    expect(messages[1].content).toBe('contents');
  });

  it('snapshots both path and filepath args', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'write',
      handler: vi.fn().mockResolvedValue('written'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('write_file', { path: 'a.txt', filepath: 'b.txt', content: 'x' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(checkpoints.snapshotBefore).toHaveBeenCalledTimes(2);
  });

  it('posts result summary to webview', async () => {
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' },
        },
      },
      permission: 'read',
      handler: vi.fn().mockResolvedValue('file contents here'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
    const toolCalls = [makeToolCall('read_file', { path: 'test.txt' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'token',
      text: expect.stringContaining('read_file'),
    }));
  });
});
