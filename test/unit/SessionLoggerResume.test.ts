import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';

// SESSIONS_DIR is computed at module load from os.homedir(), so the stub has to
// be in place before SessionLogger is imported.
const { fakeHome } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { fakeHome: { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-slr-')) } };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});

import { SessionLogger } from '../../src/sidebar/SessionLogger';

describe('SessionLogger resumes where the last run stopped', () => {
  const home = fakeHome.dir;
  const id = 'conv-resume';

  beforeEach(() => {
    fs.rmSync(path.join(home, '.forge'), { recursive: true, force: true });
  });

  const rows = (): Record<string, unknown>[] =>
    fs
      .readFileSync(path.join(home, '.forge', 'sessions', `${id}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  const messageRows = () => rows().filter((r) => r['role'] !== undefined);

  const conversation = (turns: number): ChatMessage[] =>
    Array.from({ length: turns }, (_, i) => [
      { role: 'user', content: `ask ${i}` } as ChatMessage,
      { role: 'assistant', content: `answer ${i}` } as ChatMessage,
    ]).flat();

  it('does not re-write history when a reload builds a second logger', () => {
    const messages = conversation(3);
    new SessionLogger(id, 'T', 'm').flush(messages, 'm');
    expect(messageRows()).toHaveLength(6);

    // The reload: same conversation id, so the same file, but a fresh object.
    const next = conversation(4);
    new SessionLogger(id, 'T', 'm').flush(next, 'm');

    const logged = messageRows();
    expect(logged).toHaveLength(8);
    expect(logged.map((r) => r['content'])).toEqual(next.map((m) => m.content));
  });

  it('survives repeated reloads without compounding', () => {
    for (let run = 1; run <= 5; run++) {
      new SessionLogger(id, 'T', 'm').flush(conversation(run), 'm');
    }
    expect(messageRows()).toHaveLength(10);
  });

  it('writes one cursor row per flush that logged something', () => {
    const logger = new SessionLogger(id, 'T', 'm');
    logger.flush(conversation(1), 'm');
    logger.flush(conversation(1), 'm'); // nothing new
    logger.flush(conversation(2), 'm');

    const cursors = rows().filter((r) => r['type'] === 'cursor');
    expect(cursors.map((c) => c['written_count'])).toEqual([2, 4]);
  });

  it('re-writes from the start when the file was removed between runs', () => {
    new SessionLogger(id, 'T', 'm').flush(conversation(2), 'm');
    fs.rmSync(path.join(home, '.forge', 'sessions', `${id}.jsonl`));

    new SessionLogger(id, 'T', 'm').flush(conversation(2), 'm');
    expect(messageRows()).toHaveLength(4);
  });

  it('still records a session_start per run, so forge_version is per build', () => {
    new SessionLogger(id, 'T', 'm', { forgeVersion: '0.13.19' }).flush(conversation(1), 'm');
    new SessionLogger(id, 'T', 'm', { forgeVersion: '0.13.20' }).flush(conversation(2), 'm');

    const starts = rows().filter((r) => r['type'] === 'session_start');
    expect(starts.map((s) => s['forge_version'])).toEqual(['0.13.19', '0.13.20']);
  });
});
