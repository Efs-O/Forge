import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import type { RequestCapture } from '../../src/sessions/requestStats';

const { fakeHome, streamModelChatCompletion, outputLines } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return {
    fakeHome: { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-request-loop-')) },
    streamModelChatCompletion: vi.fn(),
    outputLines: [] as string[],
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});
vi.mock('vscode', () => ({
  extensions: { getExtension: () => undefined },
  workspace: { workspaceFolders: undefined },
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => outputLines.push(line),
      show: () => {},
      dispose: () => {},
    }),
  },
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';
import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import { SessionLogCoordinator } from '../../src/sidebar/SessionLogCoordinator';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

interface FakeHandlers {
  onToken: (token: string) => void;
  onReasoning: (token: string) => void;
  onDone: (finishReason: string | null) => void;
  onError: (error: Error) => void;
  onToolCalls: (calls: ToolCall[]) => void;
  onRequestStats?: (capture: RequestCapture) => void;
}

function capture(outcome: RequestCapture['stats']['outcome']): RequestCapture {
  return {
    body: '{"model":"test-model","messages":[]}',
    url: '/v1/chat/completions',
    model: 'test-model',
    sentAtMs: Date.now(),
    stats: { outcome, client: { total_ms: 4, chunks: 2 } },
  };
}

function setup(id: string, config: ForgeConfig = {} as ForgeConfig) {
  const conversation: ConversationRuntime = {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    active_model: 'test-model',
    messages: [{ role: 'user', content: 'question' }],
  };
  const sidebar: SidebarRuntime = {
    activeConversationId: id,
    conversations: [conversation],
    history: [],
  };
  const logs = new SessionLogCoordinator(() => sidebar, () => config);
  const options = {
    resolveBaseUrl: async () => 'http://localhost:0',
    model: { name: 'test-model' },
    messages: conversation.messages as ChatMessage[],
    getToolDefinitions: () => [{ type: 'function', function: { name: 'read_file' } }],
    dispatchToolCalls: async () => {},
    signal: new AbortController().signal,
    maxRounds: 5,
    nativeTools: true,
    onToolsOffered: (names: readonly string[], fingerprint: Parameters<typeof logs.logToolsOffered>[2]) =>
      logs.logToolsOffered(id, names, fingerprint),
    onRequestStats: (data: RequestCapture) => logs.logRequestStats(id, data),
  };
  return { conversation, logs, options };
}

function rows(id: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(fakeHome.dir, '.forge', 'sessions', `${id}.jsonl`), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterAll(() => fs.rmSync(fakeHome.dir, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(path.join(fakeHome.dir, '.forge'), { recursive: true, force: true });
  outputLines.length = 0;
  streamModelChatCompletion.mockReset();
});

describe('request recording through the tool-calling loop', () => {
  it('pairs one stats row with each request prefix for ok, error, aborted and truncated requests', async () => {
    const scenarios: Array<{ name: string; outcomes: RequestCapture['stats']['outcome'][] }> = [
      { name: 'ok', outcomes: ['ok'] },
      { name: 'error', outcomes: ['error'] },
      { name: 'aborted', outcomes: ['aborted'] },
      { name: 'truncated', outcomes: ['truncated', 'ok'] },
    ];

    for (const scenario of scenarios) {
      const { options } = setup(`loop-${scenario.name}`);
      let round = 0;
      streamModelChatCompletion.mockImplementation(
        async (_url: string, _request: unknown, _model: unknown, handlers: FakeHandlers) => {
          const outcome = scenario.outcomes[round++]!;
          handlers.onRequestStats?.(capture(outcome));
          if (outcome === 'truncated') {
            handlers.onError(
              new ToolCallTruncatedError({ finishReason: 'length', partialArguments: '{' }),
            );
          } else if (outcome === 'error' || outcome === 'aborted') {
            handlers.onError(
              Object.assign(new Error(outcome), { name: outcome === 'aborted' ? 'AbortError' : 'Error' }),
            );
          } else {
            handlers.onToken('answer');
            handlers.onDone('stop');
          }
        },
      );

      if (scenario.name === 'error' || scenario.name === 'aborted') {
        await expect(runToolCallingLoop(options as never)).rejects.toThrow();
      } else {
        await expect(runToolCallingLoop(options as never)).resolves.toBeDefined();
      }

      const logRows = rows(`loop-${scenario.name}`);
      const requestRows = logRows.filter((row) =>
        ['request_prefix', 'request_stats'].includes(String(row['type'])),
      );
      expect(requestRows.map((row) => row['type'])).toEqual(
        scenario.outcomes.flatMap(() => ['request_prefix', 'request_stats']),
      );
      expect(
        requestRows.filter((row) => row['type'] === 'request_stats').map((row) => row['outcome']),
      ).toEqual(scenario.outcomes);
    }
  });

  it('keeps message and tool argument sentinels out of the session stats row', () => {
    const id = 'private-stats';
    const sentinel = 'PRIVATE_REQUEST_SENTINEL_b12e';
    const { logs } = setup(id);
    const record = capture('ok');
    record.body = JSON.stringify({
      messages: [{ role: 'user', content: sentinel }],
      tools: [{ function: { name: 'write_file', arguments: sentinel } }],
    });
    logs.logRequestStats(id, record);

    const serialized = JSON.stringify(rows(id).find((row) => row['type'] === 'request_stats'));
    expect(serialized).not.toContain(sentinel);
  });

  it.each([
    ['absent', {} as ForgeConfig],
    [
      'disabled',
      { record_requests: { enabled: false, max_mb: 10, keep_hours: 1 } } as ForgeConfig,
    ],
  ])('does not create a dump folder when recording is %s', async (state, config) => {
    const { logs } = setup(`disabled-${state}`, config);
    logs.logRequestStats(`disabled-${state}`, capture('ok'));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(fs.existsSync(path.join(fakeHome.dir, '.forge', 'requests')), state).toBe(false);
  });

  it('writes an exact request body when recording is enabled', async () => {
    const id = 'enabled-dump';
    const config = {
      record_requests: { enabled: true, max_mb: 10, keep_hours: 24 },
    } as ForgeConfig;
    const { logs } = setup(id, config);
    const record = capture('ok');
    record.body = JSON.stringify({ messages: [{ role: 'user', content: 'exact body' }] });
    logs.logRequestStats(id, record);

    // The dump is written asynchronously; a fixed sleep lost the race under
    // full-suite load and left the write running into the next test.
    const directory = path.join(fakeHome.dir, '.forge', 'requests', id);
    const filename = await vi.waitFor(() => {
      const found = fs.existsSync(directory)
        ? fs.readdirSync(directory).find((name) => name.endsWith('.json'))
        : undefined;
      expect(found).toBeDefined();
      return found;
    });
    const dump = JSON.parse(fs.readFileSync(path.join(directory, filename!), 'utf8')) as {
      request: unknown;
    };
    expect(dump.request).toEqual(JSON.parse(record.body));
  });

  it('lets the loop finish before an async dump failure and warns once for the conversation', async () => {
    const id = 'write-failure';
    const requestRoot = path.join(fakeHome.dir, '.forge', 'requests');
    fs.mkdirSync(requestRoot, { recursive: true });
    fs.writeFileSync(path.join(requestRoot, id), 'blocks directory creation');
    const config = {
      record_requests: { enabled: true, max_mb: 10, keep_hours: 1 },
    } as ForgeConfig;
    const { options } = setup(id, config);
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _request: unknown, _model: unknown, handlers: FakeHandlers) => {
        handlers.onRequestStats?.(capture('ok'));
        handlers.onToken('completed despite dump failure');
        const onDone = handlers.onDone;
        handlers.onDone = (reason) => {
          outputLines.push('turn-done');
          onDone(reason);
        };
        handlers.onDone('stop');
      },
    );

    const result = await runToolCallingLoop(options as never);
    expect(result.finalText).toBe('completed despite dump failure');
    const warning = `disabled request dumps for conversation ${id}`;
    await vi.waitFor(() => expect(outputLines.some((line) => line.includes(warning))).toBe(true));
    const turnDoneAt = outputLines.indexOf('turn-done');
    const warningAt = outputLines.findIndex((line) => line.includes(warning));
    expect(turnDoneAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeGreaterThan(turnDoneAt);
    expect(outputLines.filter((line) => line.includes(warning))).toHaveLength(1);
  });
});
