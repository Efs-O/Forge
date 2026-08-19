import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';

// SESSIONS_DIR is computed at module load from os.homedir(), so the stub has to
// be in place before SessionLogger is imported.
// Created inside vi.hoisted so the directory exists before SessionLogger's
// module body computes SESSIONS_DIR from os.homedir().
const { fakeHome } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { fakeHome: { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-slog-')) } };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});

import { SessionLogger } from '../../src/sidebar/SessionLogger';

describe('SessionLogger reasoning capture', () => {
  const home = fakeHome.dir;

  beforeEach(() => {
    fs.rmSync(path.join(home, '.forge'), { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  const readRows = (id: string): Record<string, unknown>[] =>
    fs
      .readFileSync(path.join(home, '.forge', 'sessions', `${id}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('keeps the reasoning on a tool-call turn', () => {
    // This is where the model decides what to do, and where it goes wrong. The
    // logger used to drop it, so a long session persisted thinking for exactly
    // one turn — the final one.
    const logger = new SessionLogger('s1', 't', 'm');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        reasoning: 'I should read the file before editing it.',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        ],
      },
    ];
    logger.flush(messages, 'm');
    const toolRow = readRows('s1').find((r) => r['tool_calls']);
    expect(toolRow?.['reasoning']).toBe('I should read the file before editing it.');
  });

  it('keeps a turn that produced only reasoning', () => {
    const logger = new SessionLogger('s2', 't', 'm');
    logger.flush(
      [{ role: 'assistant', content: null, reasoning: 'cut off mid-thought' }] as ChatMessage[],
      'm',
    );
    const rows = readRows('s2').filter((r) => r['role'] === 'assistant');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['reasoning']).toBe('cut off mid-thought');
  });

  it('still skips a turn with neither content nor reasoning', () => {
    const logger = new SessionLogger('s3', 't', 'm');
    logger.flush([{ role: 'assistant', content: null }] as ChatMessage[], 'm');
    expect(readRows('s3').filter((r) => r['role'] === 'assistant')).toHaveLength(0);
  });
});
