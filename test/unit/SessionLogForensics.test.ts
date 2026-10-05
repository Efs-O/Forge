import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../src/llm/types';

const { fakeHome, streamModelChatCompletion } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return {
    fakeHome: { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-forensics-')) },
    streamModelChatCompletion: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import { ArchivedSessions } from '../../src/sidebar/ArchivedSessions';
import { SessionLogger } from '../../src/sidebar/SessionLogger';
import { appendUserPrompt } from '../../src/sidebar/transcriptMutations';
import { deliverBackgroundExitNotice } from '../../src/sidebar/backgroundExitNotice';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

const id = 'forensics-session';
const sessions = path.join(fakeHome.dir, '.forge', 'sessions');

function rows(): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(sessions, `${id}.jsonl`), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('session log forensics', () => {
  beforeEach(() => {
    fs.rmSync(path.join(fakeHome.dir, '.forge'), { recursive: true, force: true });
    streamModelChatCompletion.mockReset();
  });

  afterEach(() => {
    fs.rmSync(path.join(fakeHome.dir, 'archive-test'), { recursive: true, force: true });
  });

  it('logs sorted offered tool names only when the request tool set changes', async () => {
    const logger = new SessionLogger(id, 'Forensics', 'model');
    let groupLoaded = false;
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _request: unknown, _model: unknown, handlers: {
        onDone: (reason: string | null) => void;
        onToolCalls: (calls: ToolCall[]) => void;
      }) => {
        round += 1;
        if (round === 1) {
          handlers.onToolCalls([
            {
              id: 'load',
              type: 'function',
              function: { name: 'load_tool_group', arguments: '{"group":"memory"}' },
            },
          ]);
          handlers.onDone('tool_calls');
        } else handlers.onDone('stop');
      },
    );

    const run = () =>
      runToolCallingLoop({
        resolveBaseUrl: async () => 'http://localhost',
        model: { name: 'model' },
        messages: [{ role: 'user', content: 'go' }],
        getToolDefinitions: () => [
          { type: 'function', function: { name: 'read_file' } },
          ...(groupLoaded ? [{ type: 'function', function: { name: 'recall' } }] : []),
          { type: 'function', function: { name: 'load_tool_group' } },
        ],
        dispatchToolCalls: async () => {
          groupLoaded = true;
        },
        onToolsOffered: (names: readonly string[]) => logger.logToolsOffered(names, 'model'),
        signal: new AbortController().signal,
        maxRounds: 4,
        nativeTools: true,
      } as never);

    await run();
    round = 0;
    await run();

    const offered = rows().filter((row) => row['type'] === 'tools_offered');
    expect(offered).toHaveLength(2);
    expect(offered.map((row) => row['names'])).toEqual([
      ['load_tool_group', 'read_file'],
      ['load_tool_group', 'read_file', 'recall'],
    ]);
    expect(offered.every((row) => /^[0-9a-f]{12}$/u.test(String(row['hash'])))).toBe(true);
    expect(offered[0]?.['hash']).not.toBe(offered[1]?.['hash']);

    new SessionLogger(id, 'Forensics', 'model').logToolsOffered(
      ['recall', 'read_file', 'load_tool_group'],
      'model',
    );
    expect(rows().filter((row) => row['type'] === 'tools_offered')).toHaveLength(3);
  });

  it('writes internal user rows and restores the flag from the session log', () => {
    const conversation: ConversationRuntime = {
      id,
      title: 'Forensics',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    };
    deliverBackgroundExitNotice(
      {
        id: 'job-1',
        conversationId: id,
        command: 'node',
        args: [],
        durationMs: 1000,
        status: 'completed',
        exitCode: 0,
      } as never,
      () => true,
      (text, conversationId, _echoPrompt, internal) => {
        expect(conversationId).toBe(id);
        appendUserPrompt(conversation, text, undefined, { internal });
      },
      () => undefined,
    );
    new SessionLogger(id, 'Forensics', 'model', { workspacePath: 'C:/repo' }).flush(
      conversation.messages,
      'model',
    );
    const archive = new ArchivedSessions(
      path.join(fakeHome.dir, 'archive-test'),
      'C:/repo',
      sessions,
    );

    expect(archive.read(id)?.messages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('[Forge notice'),
      internal: true,
    });
    expect(rows().find((row) => row['role'] === 'user')?.['internal']).toBe(true);
  });

  it('reads legacy logs without these fields and ignores unknown event rows', () => {
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `${id}.jsonl`),
      [
        { type: 'session_start', session_id: id, title: 'Legacy', workspace_path: 'C:/repo' },
        { type: 'tools_offered', names: ['read_file'], hash: '0123456789ab' },
        { role: 'user', content: 'old request' },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
    const archive = new ArchivedSessions(
      path.join(fakeHome.dir, 'archive-test'),
      'C:/repo',
      sessions,
    );

    expect(archive.read(id)?.messages).toEqual([{ role: 'user', content: 'old request' }]);
  });
});
