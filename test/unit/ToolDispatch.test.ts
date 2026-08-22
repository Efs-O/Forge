import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch, resolveToolPath } from '../../src/sidebar/ToolDispatch';
import type { ToolCall } from '../../src/llm/types';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { ToolBudget } from '../../src/tools/ToolBudget';

// vi.mock is hoisted — compute WS inside the factory using require
vi.mock('vscode', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  // Keep the mocked workspace writable on Linux/macOS CI as well as Windows.
  // `/workspace` is not a writable directory on hosted runners.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os');
  const ws = p.join(o.tmpdir(), 'forge-tool-dispatch-workspace');
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: ws } }],
      openTextDocument: vi.fn().mockResolvedValue({}),
      asRelativePath: vi.fn((s: string) => s.replace(ws + p.sep, '')),
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) })),
    },
    window: {
      showTextDocument: vi.fn().mockResolvedValue(undefined),
    },
    Uri: {
      file: vi.fn((s: string) => ({ fsPath: s })),
    },
  };
});

const WS = path.join(os.tmpdir(), 'forge-tool-dispatch-workspace');

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
  let diffDecorations: DiffDecorations;
  let post: ReturnType<typeof vi.fn>;
  let requestApproval: ReturnType<typeof vi.fn>;
  let dispatch: ToolDispatch;
  const allowed = new Set([
    'read',
    'write',
    'delete',
    'terminal',
    'headless',
    'git-read',
    'git-write',
  ] as const);

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    checkpoints = {
      snapshotBefore: vi.fn(),
      readSnapshotContent: vi.fn(),
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

    diffDecorations = { apply: vi.fn() } as unknown as DiffDecorations;

    post = vi.fn();
    requestApproval = vi.fn().mockResolvedValue(true);

    dispatch = new ToolDispatch(
      toolRegistry,
      checkpoints,
      codeLens,
      failureTracker,
      post,
      requestApproval,
      diffDecorations,
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

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
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
      mutation: { paths: (args) => [args['path'] as string], showDiff: true },
      handler: vi.fn().mockResolvedValue('written'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [makeToolCall('write_file', { path: 'test.txt', content: 'hello' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith(
      'write_file',
      expect.stringContaining('hello'),
      false,
      undefined,
    );
    expect(checkpoints.snapshotBefore).toHaveBeenCalled();
    expect(codeLens.markPending).toHaveBeenCalled();
  });

  it('does not open changed files when auto-open is disabled', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn().mockReturnValue(false),
    } as never);
    toolRegistry.register({
      definition: {
        type: 'function',
        function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object' } },
      },
      permission: 'write',
      mutation: { paths: (args) => [args['path'] as string], showDiff: true },
      handler: vi.fn().mockResolvedValue('written'),
    });

    await dispatch.dispatch([makeToolCall('write_file', { path: 'test.txt' })], allowed, [] as never);

    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('publishes diff paths relative to the workspace without its folder-name prefix', async () => {
    const target = path.join(WS, `tool-dispatch-${Date.now()}.ts`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'after');
    (checkpoints.readSnapshotContent as ReturnType<typeof vi.fn>).mockReturnValue('before');
    toolRegistry.register({
      definition: {
        type: 'function',
        function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object' } },
      },
      permission: 'write',
      mutation: { paths: () => [target], showDiff: true },
      handler: vi.fn().mockResolvedValue('written'),
    });

    try {
      await dispatch.dispatch([makeToolCall('write_file', { path: target })], allowed, [] as never);
      expect(vscode.workspace.asRelativePath).toHaveBeenCalledWith(target);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('snapshots a structured multi-edit exactly once before its handler', async () => {
    const structuredEdit = makeApplyLineEditsTool();
    structuredEdit.handler = vi.fn().mockResolvedValue('{"operationsApplied":2}');
    toolRegistry.register(structuredEdit);
    const messages: Array<{ role: string; content: string }> = [];

    await dispatch.dispatch(
      [
        makeToolCall('apply_line_edits', {
          path: 'src/a.ts',
          operations: [
            {
              start_line: 1,
              end_line: 1,
              expected_lines: ['old'],
              replacement_lines: ['new'],
            },
          ],
        }),
      ],
      allowed,
      messages as never,
    );

    expect(checkpoints.snapshotBefore).toHaveBeenCalledOnce();
    expect(checkpoints.snapshotBefore).toHaveBeenCalledWith(path.join(WS, 'src/a.ts'));
    expect(structuredEdit.handler).toHaveBeenCalledOnce();
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
      mutation: { paths: (args) => [args['path'] as string], showDiff: true },
      handler: vi.fn().mockResolvedValue('deleted'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [makeToolCall('delete_file', { path: 'test.txt' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith(
      'delete_file',
      expect.any(String),
      false,
      undefined,
    );
    expect(requestApproval.mock.calls[0]?.[1]).toContain('About to permanently delete:');
    expect(requestApproval.mock.calls[0]?.[1]).toContain('Target: test.txt');
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

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [makeToolCall('run_terminal', { command: 'echo hello' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith(
      'run_terminal',
      expect.any(String),
      false,
      undefined,
    );
  });

  it('does not request approval for a structurally bounded autonomous tool', async () => {
    const handler = vi.fn().mockResolvedValue('workspace listed');
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'query_powershell',
          description: 'Read-only PowerShell query',
          parameters: { type: 'object' },
        },
      },
      permission: 'headless',
      autoApprove: true,
      handler,
    });

    const messages: Array<{ role: string; content: string }> = [];
    await dispatch.dispatch(
      [makeToolCall('query_powershell', { operation: 'workspace_overview' })],
      allowed,
      messages as never,
    );

    expect(requestApproval).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect(messages[0]?.content).toBe('workspace listed');
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
      permission: 'git-write',
      handler: vi.fn().mockResolvedValue('committed'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [makeToolCall('git_commit', { message: 'test' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith(
      'git_commit',
      expect.any(String),
      false,
      undefined,
    );
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
      mutation: { paths: (args) => [args['path'] as string], showDiff: true },
      handler: vi.fn().mockResolvedValue('deleted'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [makeToolCall('delete_file', { path: 'src/', recursive: true })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(requestApproval).toHaveBeenCalledWith(
      'delete_file',
      expect.any(String),
      true,
      undefined,
    );
    expect(requestApproval.mock.calls[0]?.[1]).toContain(
      'Scope requested: recursive — all contents would be deleted if the target is accessible.',
    );
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
      mutation: { paths: (args) => [args['path'] as string], showDiff: true },
      handler: vi.fn().mockResolvedValue('written'),
    });

    requestApproval.mockResolvedValue(false);

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [makeToolCall('write_file', { path: 'test.txt', content: 'hello' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(toolRegistry.get('write_file')?.handler).not.toHaveBeenCalled();
    expect(messages[0].content).toMatch(/declined/);
  });

  it('handles malformed JSON arguments', async () => {
    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls: ToolCall[] = [
      {
        id: 'call-bad',
        type: 'function',
        function: { name: 'read_file', arguments: 'not json' },
      },
    ];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(failureTracker.record).toHaveBeenCalled();
    expect(messages[0].content).toMatch(/malformed/);
  });

  it('handles unknown tools gracefully', async () => {
    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
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

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
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

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [
      makeToolCall('read_file', { path: 'a.txt' }),
      makeToolCall('read_file', { path: 'b.txt' }),
    ];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('contents');
    expect(messages[1].content).toBe('contents');
  });

  it('does not start a mutation after the caller cancels the turn', async () => {
    const handler = vi.fn().mockResolvedValue('written');
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
      mutation: { paths: (args) => [args['path'] as string], showDiff: true },
      handler,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];

    await dispatch.dispatch(
      [makeToolCall('write_file', { path: 'cancelled.txt' })],
      allowed,
      messages as never,
      undefined,
      ctrl.signal,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(checkpoints.snapshotBefore).not.toHaveBeenCalled();
    expect(messages[0]?.content).toBe('Error: tool execution cancelled');
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
      mutation: {
        paths: (args) => [args['path'] as string, args['filepath'] as string],
        showDiff: true,
      },
      handler: vi.fn().mockResolvedValue('written'),
    });

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [
      makeToolCall('write_file', { path: 'a.txt', filepath: 'b.txt', content: 'x' }),
    ];

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

    const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> =
      [];
    const toolCalls = [makeToolCall('read_file', { path: 'test.txt' })];

    await dispatch.dispatch(toolCalls, allowed, messages as never);

    // A structured message, not markdown injected into the assistant token
    // stream: the transcript needs to be able to collapse and expand it.
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'toolResult',
        toolName: 'read_file',
        label: 'test.txt',
        text: 'file contents here',
        totalChars: 'file contents here'.length,
      }),
    );
  });

  it('keeps a long result readable instead of flattening it to a preview', async () => {
    const report = ['# Report', '', 'First paragraph.', '', 'x'.repeat(4000)].join('\n');
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'delegate_to_agent',
          description: 'Delegate',
          parameters: { type: 'object' },
        },
      },
      permission: 'read',
      handler: vi.fn().mockResolvedValue(report),
    });

    const messages: Array<{ role: string; content: string }> = [];
    await dispatch.dispatch(
      [makeToolCall('delegate_to_agent', {})],
      allowed,
      messages as never,
    );

    const posted = post.mock.calls
      .map((call) => call[0] as { type: string; text?: string; label?: string })
      .find((msg) => msg.type === 'toolResult')!;
    expect(posted.text).toBe(report);
    expect(posted.text).toContain('\n');
    expect(posted.label).toBe('# Report');
    // The model still receives the untruncated result.
    expect(messages.at(-1)?.content).toBe(report);
  });

  describe('tool budget (allowlist + per-turn call limits)', () => {
    beforeEach(() => {
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
        handler: vi.fn().mockResolvedValue('ran'),
      });
      toolRegistry.register({
        definition: {
          type: 'function',
          function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
        },
        permission: 'read',
        handler: vi.fn().mockResolvedValue('contents'),
      });
    });

    it('returns a structured error and never calls the handler for a non-allowlisted tool', async () => {
      const budget = new ToolBudget({ tools: ['read_file'] });
      const handler = toolRegistry.get('run_terminal')?.handler;
      const messages: Array<{ role: string; content: string }> = [];

      await dispatch.dispatch(
        [makeToolCall('run_terminal', { command: 'echo hi' })],
        allowed,
        messages as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        budget,
      );

      expect(handler).not.toHaveBeenCalled();
      expect(messages[0]?.content).toBe('Tool run_terminal is not available for this model.');
    });

    it('still enforces the permission gate even when the allowlist would allow the tool', async () => {
      const budget = new ToolBudget({ tools: ['run_terminal'] });
      const noTerminalPermission = new Set(['read', 'write'] as const);
      const messages: Array<{ role: string; content: string }> = [];

      await dispatch.dispatch(
        [makeToolCall('run_terminal', { command: 'echo hi' })],
        noTerminalPermission,
        messages as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        budget,
      );

      expect(messages[0]?.content).toMatch(/permission "terminal"/);
    });

    it('returns the wrap-up message once a per-tool budget is exhausted, without crashing the turn', async () => {
      const budget = new ToolBudget({ tool_call_limits: { run_terminal: 1 } });
      const handler = toolRegistry.get('run_terminal')?.handler;
      const messages: Array<{ role: string; content: string }> = [];

      await dispatch.dispatch(
        [makeToolCall('run_terminal', { command: 'echo one' })],
        allowed,
        messages as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        budget,
      );
      await dispatch.dispatch(
        [makeToolCall('run_terminal', { command: 'echo two' })],
        allowed,
        messages as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        budget,
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(messages[0]?.content).toBe('ran');
      expect(messages[1]?.content).toBe(
        'Budget exhausted: run_terminal was limited to 1 calls this turn (1 used). ' +
          'Do not call it again; wrap up with what you have.',
      );
    });

    it('does not budget-limit calls when no budget is passed (backwards compatible)', async () => {
      const handler = toolRegistry.get('read_file')?.handler;
      const messages: Array<{ role: string; content: string }> = [];

      await dispatch.dispatch(
        [makeToolCall('read_file', { path: 'a.txt' })],
        allowed,
        messages as never,
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(messages[0]?.content).toBe('contents');
    });
  });
});
