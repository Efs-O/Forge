import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

const { fakeHome } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { fakeHome: { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-slc-')) } };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});
vi.mock('vscode', () => ({
  extensions: { getExtension: () => undefined },
  workspace: { workspaceFolders: undefined },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

import { SessionLogCoordinator } from '../../src/sidebar/SessionLogCoordinator';

afterAll(() => fs.rmSync(fakeHome.dir, { recursive: true, force: true }));

describe('SessionLogCoordinator settled transcript flushes', () => {
  beforeEach(() => fs.rmSync(path.join(fakeHome.dir, '.forge'), { recursive: true, force: true }));

  function messagesFromLog(id: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(path.join(fakeHome.dir, '.forge', 'sessions', `${id}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => typeof row['role'] === 'string');
  }

  function runtime(messages: ChatMessage[]): {
    coordinator: SessionLogCoordinator;
    conversation: ConversationRuntime;
  } {
    const conversation: ConversationRuntime = {
      id: 'settled-flush',
      title: 'Settled flush',
      createdAt: 1,
      updatedAt: 1,
      messages,
    };
    const sidebar: SidebarRuntime = {
      activeConversationId: conversation.id,
      conversations: [conversation],
      history: [],
    };
    return { coordinator: new SessionLogCoordinator(() => sidebar), conversation };
  }

  it('holds back a trailing assistant message that may still be streaming', () => {
    const { coordinator, conversation } = runtime([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'partial answer' },
    ]);

    coordinator.flushSessionLog(conversation.id, true);

    expect(messagesFromLog(conversation.id).map((row) => row['role'])).toEqual(['user']);
  });

  it('keeps a trailing assistant tool call in the settled flush', () => {
    const { coordinator, conversation } = runtime([
      { role: 'user', content: 'read this' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
    ]);

    coordinator.flushSessionLog(conversation.id, true);

    expect(messagesFromLog(conversation.id).map((row) => row['role'])).toEqual([
      'user',
      'assistant',
    ]);
  });
});
