import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { invalidJsonAdvice } from '../../src/sidebar/toolCallPreflight';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

vi.mock('vscode', () => {
  // vi.mock is hoisted — compute the temp directory inside the factory.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const o = require('os') as typeof import('os');
  const workspace = p.join(o.tmpdir(), 'forge-preflight-test-workspace');
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      openTextDocument: vi.fn().mockResolvedValue({}),
      asRelativePath: vi.fn((value: string) => value.replace(workspace + p.sep, '')),
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
  };
});

function parserMessage(raw: string): string {
  try {
    JSON.parse(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected invalid JSON');
}

describe('invalid tool-call JSON preflight', () => {
  let registry: ToolRegistry;
  let dispatch: ToolDispatch;
  let failureTracker: ToolFailureTracker;
  const allowed = new Set(['read', 'write'] as const);

  beforeEach(() => {
    registry = new ToolRegistry();
    failureTracker = {
      recordNativeParseFailure: vi.fn(),
      reset: vi.fn(),
      shouldStrip: vi.fn().mockReturnValue(false),
    } as unknown as ToolFailureTracker;
    dispatch = new ToolDispatch(
      registry,
      {} as CheckpointStack,
      { markPending: vi.fn(), clearPending: vi.fn() } as unknown as KeepUndoCodeLensProvider,
      failureTracker,
      vi.fn(),
      vi.fn().mockResolvedValue('approved'),
      { apply: vi.fn() } as unknown as DiffDecorations,
    );
  });

  async function refuse(raw: string, name = 'read_file'): Promise<ChatMessage[]> {
    const call: ToolCall = {
      id: `call-${name}`,
      type: 'function',
      function: { name, arguments: raw },
    };
    const messages: ChatMessage[] = [{ role: 'assistant', content: null, tool_calls: [call] }];
    await dispatch.dispatch([call], allowed, messages);
    return messages;
  }

  it('names leaked grep_search markup and its unclosed output value', async () => {
    const handler = vi.fn().mockResolvedValue('matches');
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'grep_search', description: 'Search', parameters: { type: 'object' } },
      },
      permission: 'read',
      handler,
    });
    const raw = String.raw`{"query":"harborLanternE3","output":"content\n</parameter\n</function>\n</tool_call>`;
    const message = parserMessage(raw);
    const advice =
      'Tool-call markup (</parameter) ended up inside the string value of "output", which was never closed. ' +
      'Close the value with " and the object with }, and keep tool-call markup out of the arguments, then resend.';
    const messages = await refuse(raw, 'grep_search');

    expect(invalidJsonAdvice(raw, message)).toBe(advice);
    expect(handler).not.toHaveBeenCalled();
    expect(messages[1]?.content).toBe(
      `Error: grep_search: the arguments are not valid JSON (${message}). ${advice}`,
    );
    expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
  });

  it('names leaked markup without a preceding field opening', async () => {
    const raw = '"unkeyed </parameter';
    const advice =
      'Tool-call markup (</parameter) ended up inside a string value that was never closed. ' +
      'Close the value with " and the object with }, and keep tool-call markup out of the arguments, then resend.';

    expect(parserMessage(raw)).toMatch(/^Unterminated string/u);
    const messages = await refuse(raw);

    expect(messages[1]?.content).toBe(
      `Error: read_file: the arguments are not valid JSON (${parserMessage(raw)}). ${advice}`,
    );
    expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
  });

  it('explains raw newlines and tabs inside JSON strings', async () => {
    const raw = '{"text":"first\nsecond"}';
    const messages = await refuse(raw);

    expect(messages[1]?.content).toBe(
      `Error: read_file: the arguments are not valid JSON (${parserMessage(raw)}). ` +
        'Write each newline inside a string as \\n and each tab as \\t, then resend.',
    );
    expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
  });

  it('uses generic JSON advice when markup accompanies a different parser error', async () => {
    const raw = '{"a":"</function>" "b":1}';
    const messages = await refuse(raw);

    expect(messages[1]?.content).toBe(
      `Error: read_file: the arguments are not valid JSON (${parserMessage(raw)}). ` +
        'Resend the arguments as one complete JSON object.',
    );
    expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
  });

  it('allows valid JSON string values containing tool-call markup', async () => {
    const handler = vi.fn().mockResolvedValue('written');
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'write_file', description: 'Write', parameters: { type: 'object' } },
      },
      permission: 'write',
      mutation: { paths: () => [], showDiff: false },
      handler,
    });
    const raw = JSON.stringify({ path: 'sample.xml', content: '<parameter>text</parameter>' });
    const messages = await refuse(raw, 'write_file');

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'sample.xml', content: '<parameter>text</parameter>' }),
      expect.anything(),
    );
    expect(messages[1]?.content).toBe('written');
    expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
  });

  it('runs a no-argument call instead of refusing an empty arguments string', async () => {
    const handler = vi.fn().mockResolvedValue('listed');
    registry.register({
      definition: {
        type: 'function',
        function: {
          name: 'list_executions',
          description: 'List background runs',
          parameters: { type: 'object' },
        },
      },
      permission: 'read',
      handler,
    });

    // A name-only delta has nothing to append, and some servers send `""` or
    // omit the field. Every one of those shapes means "no arguments".
    for (const args of ['', '   ', undefined]) {
      const call: ToolCall = {
        id: 'call-list',
        type: 'function',
        function: { name: 'list_executions', arguments: args as string },
      };
      const messages: ChatMessage[] = [
        { role: 'assistant', content: null, tool_calls: [call] },
      ];
      await dispatch.dispatch([call], allowed, messages);
      expect(messages[1]?.content).toBe('listed');
    }
    expect(handler).toHaveBeenCalledWith({}, expect.anything());
    expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
  });

  it('uses generic complete-object advice when no specific cause matches', () => {
    expect(invalidJsonAdvice('{broken', "Unexpected token 'b'")).toBe(
      'Resend the arguments as one complete JSON object.',
    );
  });
});
