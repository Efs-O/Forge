import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { buildWebFetchGroup } from '../../src/sidebar/toolDispatchWebGroup';
import type { ToolDispatchModelContext } from '../../src/sidebar/toolDispatchTypes';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { RegisteredTool, ToolHandlerContext, ToolPermission } from '../../src/tools/ToolRegistry';
import { makeWebFetchTool } from '../../src/tools/fetchTool';
import { makeReadFileTool } from '../../src/tools/readFileTool';
import { clearConversationExfilState } from '../../src/tools/exfilTaint';
import { clearConversationHostApprovals } from '../../src/tools/fetchHostApprovals';

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

const allowed = new Set<ToolPermission>([
  'read',
  'write',
  'delete',
  'terminal',
  'search',
  'fetch',
  'git-read',
  'browser',
]);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  registry: ToolRegistry;
  dispatch: ToolDispatch;
  messages: ChatMessage[];
  post: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  resetSnapshots: string[][];
}

function makeHarness(): Harness {
  const registry = new ToolRegistry();
  const messages: ChatMessage[] = [];
  const resetSnapshots: string[][] = [];
  const failureTracker = {
    recordNativeParseFailure: vi.fn(),
    reset: vi.fn(() => resetSnapshots.push(messages.map((message) => message.tool_call_id ?? ''))),
    shouldStrip: vi.fn().mockReturnValue(false),
  } as unknown as ToolFailureTracker;
  const post = vi.fn();
  const requestApproval = vi.fn(
    async (
      _toolName: string,
      _detail: string,
      _dangerous?: boolean,
      _convId?: string,
      _signal?: AbortSignal,
    ) => 'approved' as const,
  );
  const dispatch = new ToolDispatch(
    registry,
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
  return { registry, dispatch, messages, post, requestApproval, resetSnapshots };
}

function call(name: string, args: Record<string, unknown>, id: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

async function run(
  harness: Harness,
  calls: ToolCall[],
  convId = 'parallel-web-fetch',
  signal?: AbortSignal,
  modelContext?: ToolDispatchModelContext,
): Promise<void> {
  await harness.dispatch.dispatch(
    calls,
    allowed,
    harness.messages,
    convId,
    signal,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    modelContext,
  );
}

function registerFetch(
  harness: Harness,
  fetcher: (url: string) => Promise<Response>,
  hosts: string[] = [],
): void {
  harness.registry.register(
    makeWebFetchTool({
      getConfig: () => ({ fetch: { allowed_hosts: hosts } }) as never,
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetch: (async (url: string) => fetcher(String(url))) as never,
    }),
  );
}

function registerSimpleTool(
  harness: Harness,
  name: string,
  permission: ToolPermission,
  handler: (args: Record<string, unknown>, context?: ToolHandlerContext) => Promise<string>,
  mutation?: RegisteredTool['mutation'],
): void {
  harness.registry.register({
    definition: {
      type: 'function',
      function: {
        name,
        description: name,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, query: { type: 'string' } },
          required: [],
          additionalProperties: true,
        },
      },
    },
    permission,
    ...(mutation ? { mutation } : {}),
    handler,
  });
}

function response(text: string): Response {
  return new Response(`<p>${text}</p>`, { headers: { 'content-type': 'text/html' } });
}

afterEach(() => {
  clearConversationExfilState();
  clearConversationHostApprovals();
});

describe('web fetch group builder', () => {
  it('caps a group at three consecutive distinct normalized hosts', () => {
    const calls = [
      call('web_fetch', { url: 'https://A.example.test/1' }, 'a'),
      call('web_fetch', { url: 'https://b.example.test/2' }, 'b'),
      call('web_fetch', { url: 'https://c.example.test/3' }, 'c'),
      call('web_fetch', { url: 'https://d.example.test/4' }, 'd'),
    ];

    expect(buildWebFetchGroup(calls, 0)).toEqual(calls.slice(0, 3));
    expect(buildWebFetchGroup(calls, 3)).toEqual([calls[3]]);
  });

  it('ends before a repeated host, invalid URL, or non-fetch call', () => {
    const repeated = [
      call('web_fetch', { url: 'https://same.example.test/1' }, 'a'),
      call('web_fetch', { url: 'https://SAME.example.test/2' }, 'b'),
      call('web_fetch', { url: 'https://other.example.test/3' }, 'c'),
    ];
    const invalid = [
      call('web_fetch', { url: 'https://one.example.test/' }, 'one'),
      call('web_fetch', { url: 'not a URL' }, 'bad'),
      call('web_fetch', { url: 'https://two.example.test/' }, 'two'),
    ];
    const boundary = [
      call('web_fetch', { url: 'https://one.example.test/' }, 'one'),
      call('read_file', { path: 'x' }, 'read'),
    ];

    expect(buildWebFetchGroup(repeated, 0)).toEqual([repeated[0]]);
    expect(buildWebFetchGroup(invalid, 0)).toEqual([invalid[0]]);
    expect(buildWebFetchGroup(invalid, 1)).toEqual([invalid[1]]);
    expect(buildWebFetchGroup(boundary, 0)).toEqual([boundary[0]]);
  });
});

describe('ToolDispatch parallel web fetches', () => {
  it('runs approved hosts concurrently and commits results and tracker updates in call order', async () => {
    const harness = makeHarness();
    const finished: string[] = [];
    let active = 0;
    let maxActive = 0;
    registerFetch(
      harness,
      async (url) => {
        const host = new URL(url).hostname;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await pause(host.startsWith('first') ? 40 : 5);
        finished.push(host);
        active -= 1;
        return response(host);
      },
      ['first.example.test', 'second.example.test'],
    );
    const olderStamp = Date.now() - 60_000;
    const conversation = { id: 'parallel-order', messages: [], untrusted_since_ms: olderStamp };
    const modelContext = {
      modelName: 'test',
      isVisionModel: false,
      conversation: conversation as never,
      persistConversation: vi.fn(),
    };

    await run(
      harness,
      [
        call('web_fetch', { url: 'https://first.example.test/' }, 'first'),
        call('web_fetch', { url: 'https://second.example.test/' }, 'second'),
      ],
      'parallel-order',
      undefined,
      modelContext,
    );

    expect(maxActive).toBe(2);
    expect(finished).toEqual(['second.example.test', 'first.example.test']);
    expect(harness.messages.map((message) => message.tool_call_id)).toEqual(['first', 'second']);
    expect(harness.post.mock.calls.map(([event]) => event.toolCallId)).toEqual(['first', 'second']);
    expect(harness.resetSnapshots).toEqual([[], ['first']]);
    expect(conversation.untrusted_since_ms).toBe(olderStamp);
  });

  it('starts a fourth fetch only after the first group of three has finished', async () => {
    const harness = makeHarness();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const hosts = ['a', 'b', 'c', 'd'].map((name) => `${name}.example.test`);
    registerFetch(
      harness,
      async (url) => {
        const name = new URL(url).hostname[0]!;
        events.push(`${name}:start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await pause(name === 'a' ? 35 : 15);
        events.push(`${name}:end`);
        active -= 1;
        return response(name);
      },
      hosts,
    );

    await run(
      harness,
      hosts.map((host, index) => call('web_fetch', { url: `https://${host}/` }, host[0]!)),
    );

    expect(maxActive).toBe(3);
    const dStart = events.indexOf('d:start');
    expect(events.slice(0, dStart)).toContain('a:end');
    expect(events.slice(0, dStart)).toContain('b:end');
    expect(events.slice(0, dStart)).toContain('c:end');
    expect(harness.messages.map((message) => message.tool_call_id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('serializes same-host fetches and does not ask or add the new-host note twice', async () => {
    const harness = makeHarness();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    registerFetch(harness, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('start');
      await pause(15);
      events.push('end');
      active -= 1;
      return response('page');
    });

    await run(harness, [
      call('web_fetch', { url: 'https://same.example.test/first' }, 'first'),
      call('web_fetch', { url: 'https://same.example.test/second' }, 'second'),
    ]);

    expect(maxActive).toBe(1);
    expect(events).toEqual(['start', 'end', 'start', 'end']);
    expect(harness.requestApproval).toHaveBeenCalledTimes(1);
    expect(harness.requestApproval.mock.calls[0]?.[1]).toContain('same.example.test');
    expect(harness.messages[0]?.content).toContain('was new to this chat');
    expect(harness.messages[1]?.content).not.toContain('was new to this chat');
  });

  it('lets a local read overlap a fetch but waits for both before starting the next fetch', async () => {
    const harness = makeHarness();
    const events: string[] = [];
    registerFetch(
      harness,
      async (url) => {
        const name = new URL(url).hostname[0]!;
        events.push(`${name}:start`);
        await pause(name === 'a' ? 25 : 1);
        events.push(`${name}:end`);
        return response(name);
      },
      ['a.example.test', 'b.example.test'],
    );
    registerSimpleTool(harness, 'read_file', async () => {
      events.push('read:start');
      await pause(40);
      events.push('read:end');
      return 'read result';
    });

    await run(harness, [
      call('web_fetch', { url: 'https://a.example.test/' }, 'a'),
      call('read_file', { path: 'x' }, 'read'),
      call('web_fetch', { url: 'https://b.example.test/' }, 'b'),
    ]);

    expect(events.indexOf('read:start')).toBeLessThan(events.indexOf('a:end'));
    expect(events.indexOf('b:start')).toBeGreaterThan(events.indexOf('a:end'));
    expect(events.indexOf('b:start')).toBeGreaterThan(events.indexOf('read:end'));
    expect(harness.messages.map((message) => message.tool_call_id)).toEqual(['a', 'read', 'b']);
  });

  it.each([
    ['web_search', 'search', undefined],
    ['shell', 'terminal', undefined],
    ['browser_navigate', 'browser', undefined],
    ['write_file', 'write', { paths: () => [] }],
  ] as const)('%s ends the fetch group', async (name, permission, mutation) => {
    const harness = makeHarness();
    const events: string[] = [];
    registerFetch(
      harness,
      async (url) => {
        const host = new URL(url).hostname[0]!;
        events.push(`${host}:start`);
        await pause(10);
        events.push(`${host}:end`);
        return response(host);
      },
      ['a.example.test', 'b.example.test'],
    );
    registerSimpleTool(harness, name, permission, async () => {
      events.push('middle:start');
      events.push('middle:end');
      return 'middle';
    }, mutation);

    await run(harness, [
      call('web_fetch', { url: 'https://a.example.test/' }, 'a'),
      call(name, {}, 'middle'),
      call('web_fetch', { url: 'https://b.example.test/' }, 'b'),
    ]);

    expect(events.indexOf('middle:start')).toBeGreaterThan(events.indexOf('a:end'));
    expect(events.indexOf('b:start')).toBeGreaterThan(events.indexOf('middle:end'));
    expect(harness.messages.map((message) => message.tool_call_id)).toEqual(['a', 'middle', 'b']);
  });

  it('keeps the secret-read owner-only taint card on the next web_fetch', async () => {
    const harness = makeHarness();
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), '.parallel-web-fetch-'));
    const secretPath = path.join(tempDir, '.env');
    fs.writeFileSync(secretPath, 'TOKEN=fixture-secret');
    harness.registry.register(makeReadFileTool());
    registerFetch(harness, async () => response('fetched'), ['secret.example.test']);

    try {
      await run(harness, [
        call('read_file', { path: secretPath }, 'secret-read'),
        call('web_fetch', { url: 'https://secret.example.test/' }, 'fetch'),
      ], 'secret-fetch');

      expect(harness.requestApproval.mock.calls[0]?.[0]).toBe('read_file');
      expect(harness.requestApproval.mock.calls[1]?.[0]).toBe('web_fetch');
      expect(harness.requestApproval.mock.calls[1]?.[2]).toBe(true);
      expect(harness.requestApproval.mock.calls[1]?.[3]).toBe('secret-fetch');
      expect(harness.requestApproval.mock.calls[1]?.[5]).toEqual(
        expect.objectContaining({ gateKind: 'taintGate', clankerStop: true }),
      );
      expect(harness.messages.map((message) => message.tool_call_id)).toEqual(['secret-read', 'fetch']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an ordered cancelled result for every fetch when approval cards are aborted', async () => {
    const harness = makeHarness();
    registerFetch(harness, async () => response('must not fetch'));
    harness.requestApproval.mockImplementation(
      (_name, _detail, _dangerous, _convId, signal) =>
        new Promise((resolve) => {
          if (signal?.aborted) {
            resolve('declined');
            return;
          }
          signal?.addEventListener('abort', () => resolve('declined'), { once: true });
        }),
    );
    const controller = new AbortController();
    const calls = [
      call('web_fetch', { url: 'https://one.example.test/' }, 'one'),
      call('web_fetch', { url: 'https://two.example.test/' }, 'two'),
      call('web_fetch', { url: 'https://three.example.test/' }, 'three'),
    ];

    const round = run(harness, calls, 'abort-web-group', controller.signal);
    await vi.waitFor(() => expect(harness.requestApproval).toHaveBeenCalledTimes(3));
    controller.abort();
    await round;

    expect(harness.messages.map((message) => message.tool_call_id)).toEqual(['one', 'two', 'three']);
    expect(harness.messages.every((message) => String(message.content).includes('User declined'))).toBe(
      true,
    );
  });

  it('keeps a later fetch result after the first fetch fails while it is still running', async () => {
    const harness = makeHarness();
    const events: string[] = [];
    registerFetch(
      harness,
      async (url) => {
        const host = new URL(url).hostname;
        if (host.startsWith('first')) {
          await pause(5);
          events.push('first:failed');
          throw new Error('first host failed');
        }
        events.push('second:start');
        await pause(35);
        events.push('second:end');
        return response('second page');
      },
      ['first.example.test', 'second.example.test'],
    );

    await run(harness, [
      call('web_fetch', { url: 'https://first.example.test/' }, 'first'),
      call('web_fetch', { url: 'https://second.example.test/' }, 'second'),
    ], 'fetch-failure-order');

    expect(events.indexOf('first:failed')).toBeLessThan(events.indexOf('second:end'));
    expect(harness.messages.map((message) => message.tool_call_id)).toEqual(['first', 'second']);
    expect(harness.messages[0]?.content).toContain('first host failed');
    expect(harness.messages[1]?.content).toContain('second page');
    expect(harness.resetSnapshots).toEqual([['first']]);
  });
});
