import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';

// SESSIONS_DIR is computed at module load from os.homedir(), so the stub has to
// be in place before SessionLogger is imported.
const { fakeHome } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { fakeHome: { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-ste-')) } };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});

import { SessionLogger } from '../../src/sidebar/SessionLogger';

describe('SessionLogger turn errors', () => {
  const home = fakeHome.dir;

  beforeEach(() => {
    fs.rmSync(path.join(home, '.forge'), { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  const readRows = (id: string): Record<string, unknown>[] =>
    fs
      .readFileSync(path.join(home, '.forge', 'sessions', `${id}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  // The 2026-09-09 failure: a 543-row log ended on a successful tool row, so
  // the file read as a healthy turn and the only record of the error was the
  // rendered chat.
  it('records a failed turn beneath the rows it produced', () => {
    const logger = new SessionLogger('c-err', 'title', 'm1');
    const messages: ChatMessage[] = [{ role: 'user', content: 'do it' }];
    logger.flush(messages, 'm1');
    logger.logTurnError('fetch failed: read ECONNRESET', 'm1');

    const rows = readRows('c-err');
    const error = rows.filter((r) => r['type'] === 'turn_error');
    expect(error).toHaveLength(1);
    expect(error[0]?.['message']).toBe('fetch failed: read ECONNRESET');
    expect(error[0]?.['model']).toBe('m1');
    // Beneath, not before: the ordering is what ties the error to its turn.
    expect(rows.indexOf(error[0]!)).toBe(rows.length - 1);
  });

  it('writes the session header even when the turn failed before any message', () => {
    const logger = new SessionLogger('c-early', 'title', 'm1');
    logger.logTurnError('Backend failed to start: spawn ENOENT', 'm1');

    const rows = readRows('c-early');
    expect(rows[0]?.['type']).toBe('session_start');
    expect(rows.at(-1)?.['type']).toBe('turn_error');
  });
});
