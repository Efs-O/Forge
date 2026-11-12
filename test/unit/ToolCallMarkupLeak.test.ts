import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
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
  const workspace = p.join(o.tmpdir(), 'forge-markup-leak-test-workspace');

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

// Assembled from parts so this file's own text never reads as tool-call markup.
const CLOSE = '<' + '/parameter>';
const OPEN = '<' + 'parameter=';

/**
 * The engine's tool-call parser can fold a second parameter block into the value
 * it is reading, which leaves valid JSON whose value carries the markup. The call
 * still runs, and an edit writes the markup into the file. Preflight refuses it.
 * Measured across the session logs: 11 real cases, all on local engine entries.
 */
describe('a tool call whose value swallowed a parameter block', () => {
  let registry: ToolRegistry;
  let dispatch: ToolDispatch;
  let failureTracker: ToolFailureTracker;
  const allowed = new Set(['read', 'write'] as const);

  beforeEach(() => {
    registry = new ToolRegistry();
    failureTracker = {
      record: vi.fn(),
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

  function register(
    name: string,
    properties: Record<string, unknown>,
    handler: ReturnType<typeof vi.fn>,
  ): void {
    registry.register({
      definition: {
        type: 'function',
        function: { name, description: name, parameters: { type: 'object', properties } },
      },
      permission: 'read',
      handler,
    });
  }

  async function call(name: string, args: unknown): Promise<ChatMessage[]> {
    const toolCall: ToolCall = {
      id: `call-${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    };
    const messages: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [toolCall] },
    ];
    await dispatch.dispatch([toolCall], allowed, messages);
    return messages;
  }

  it('refuses the shape where a second block was folded into a message value', async () => {
    const handler = vi.fn().mockResolvedValue('asked');
    register(
      'ask_agent',
      { agent: { type: 'string' }, subject: { type: 'string' }, message: { type: 'string' } },
      handler,
    );

    const messages = await call('ask_agent', {
      agent: 'claude',
      subject: 'a subject',
      message: `the brief ends here.\n\n${CLOSE}\n${OPEN}message>\nplaceholder`,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(messages[1]?.content).toBe(
      'Error: ask_agent: tool-call markup ended up inside the value of "message" — it reads ' +
        `"…the brief ends here. ${CLOSE} ${OPEN}message> placeholder". The engine's ` +
        'parser folded a second parameter block into this value, so the arguments that reached ' +
        'the tool are not what was meant. Resend the call with one parameter block per argument ' +
        'and no markup inside any value.',
    );
    expect(failureTracker.record).toHaveBeenCalled();
  });

  it('refuses a nested edit value that carries a block naming one of the tool parameters', async () => {
    const handler = vi.fn().mockResolvedValue('edited');
    register(
      'edit_file',
      { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } },
      handler,
    );

    const messages = await call('edit_file', {
      path: 'src/a.ts',
      old_str: 'x',
      new_str: `line one\nline two\n${OPEN}path>\nsrc/a.ts`,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(messages[1]?.content).toContain('the value of "new_str"');
  });

  it('refuses a value that ends on a closing tag while holding an opening one', async () => {
    const handler = vi.fn().mockResolvedValue('ran');
    register('shell', { command: { type: 'string' } }, handler);

    const messages = await call(
      'shell',
      { command: `text before\n${OPEN}other>\nls\n${CLOSE}` },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(messages[1]?.content).toContain('the value of "command"');
  });

  it('refuses a value that begins with an opening tag', async () => {
    const handler = vi.fn().mockResolvedValue('ran');
    register('note', { body: { type: 'string' } }, handler);

    const messages = await call('note', { body: `${OPEN}body>\n60` });

    expect(handler).not.toHaveBeenCalled();
    expect(messages[1]?.content).toContain('the value of "body"');
  });

  it('runs a value that documents the markup tokens as ordinary content', async () => {
    const handler = vi.fn().mockResolvedValue('written');
    register('write_note', { content: { type: 'string' } }, handler);

    const messages = await call('write_note', {
      content:
        `Keep \`${CLOSE}\` and \`${OPEN}name>\` out of argument values when you write them.`,
    });

    expect(handler).toHaveBeenCalled();
    expect(messages[1]?.content).toBe('written');
  });

  it('runs a value holding one closing tag with no opening tag anywhere', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    register('echo', { text: { type: 'string' } }, handler);

    const messages = await call('echo', { text: `the doc line ends with ${CLOSE} on its own` });

    expect(handler).toHaveBeenCalled();
    expect(messages[1]?.content).toBe('ok');
  });
});
