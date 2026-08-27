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
  return { fakeHome: { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-suse-')) } };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});

import { SessionLogger } from '../../src/sidebar/SessionLogger';

describe('SessionLogger usage capture', () => {
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

  const usageRows = (id: string) => readRows(id).filter((r) => r['type'] === 'usage');

  const turn: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'done' },
  ];

  it('writes the session-to-date totals as their own line', () => {
    const logger = new SessionLogger('u1', 't', 'm');
    logger.flush(turn, 'm', { inputTokens: 1200, outputTokens: 340, requestCount: 1 });

    const rows = usageRows('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'usage',
      input_tokens: 1200,
      output_tokens: 340,
      model_request_count: 1,
      model: 'm',
    });
  });

  it('carries no role field, so readers that key on role skip it', () => {
    // HalluScribe's Forge preprocessor drops any line without `role`. Keeping
    // usage off that key is what makes these files readable by older builds.
    const logger = new SessionLogger('u2', 't', 'm');
    logger.flush(turn, 'm', { inputTokens: 10, outputTokens: 20, requestCount: 1 });
    expect(usageRows('u2')[0]).not.toHaveProperty('role');
  });

  it('appends a new line only when a total actually moved', () => {
    const logger = new SessionLogger('u3', 't', 'm');
    logger.flush(turn, 'm', { inputTokens: 100, outputTokens: 50, requestCount: 1 });
    logger.flush(turn, 'm', { inputTokens: 100, outputTokens: 50, requestCount: 1 });
    expect(usageRows('u3')).toHaveLength(1);

    logger.flush(turn, 'm', { inputTokens: 220, outputTokens: 90, requestCount: 2 });
    const rows = usageRows('u3');
    expect(rows).toHaveLength(2);
    // Cumulative, so the last line alone is the whole session's total.
    expect(rows[1]?.['output_tokens']).toBe(90);
  });

  it('writes nothing when the server reported no usage', () => {
    const logger = new SessionLogger('u4', 't', 'm');
    logger.flush(turn, 'm');
    expect(usageRows('u4')).toHaveLength(0);

    logger.flush(turn, 'm', { inputTokens: 0, outputTokens: 0, requestCount: 0 });
    expect(usageRows('u4')).toHaveLength(0);
  });

  it('carries the agent active time on the usage line', () => {
    const logger = new SessionLogger('u6', 't', 'm');
    logger.flush(turn, 'm', {
      inputTokens: 10,
      outputTokens: 20,
      requestCount: 1,
      activeTimeMs: 45_000,
    });
    expect(usageRows('u6')[0]?.['active_time_ms']).toBe(45_000);
  });

  it('does not append a line for active time alone', () => {
    // Active time moves continuously; gating on it would append on every flush
    // whether or not the model did any work.
    const logger = new SessionLogger('u7', 't', 'm');
    const usage = { inputTokens: 10, outputTokens: 20, requestCount: 1 };
    logger.flush(turn, 'm', { ...usage, activeTimeMs: 1000 });
    logger.flush(turn, 'm', { ...usage, activeTimeMs: 9999 });
    expect(usageRows('u7')).toHaveLength(1);
  });

  it('records the workspace and version in the session header', () => {
    // ~/.forge/sessions is flat, so without this a reader cannot tell which
    // project a Forge session belongs to.
    const logger = new SessionLogger('u8', 't', 'm', {
      workspaceName: 'Halluscribe',
      workspacePath: 'N:\vs code apps\Halluscribe',
      forgeVersion: '0.13.17',
    });
    logger.flush(turn, 'm');
    const header = readRows('u8').find((r) => r['type'] === 'session_start');
    expect(header).toMatchObject({
      workspace_name: 'Halluscribe',
      workspace_path: 'N:\vs code apps\Halluscribe',
      forge_version: '0.13.17',
    });
  });

  it('omits workspace keys entirely when there is no folder open', () => {
    const logger = new SessionLogger('u9', 't', 'm');
    logger.flush(turn, 'm');
    const header = readRows('u9').find((r) => r['type'] === 'session_start')!;
    expect(header).not.toHaveProperty('workspace_name');
    expect(header).not.toHaveProperty('forge_version');
  });

  it('records tokens burned by a turn that produced no message', () => {
    // Cancelled mid-generation still costs; the transcript has nothing to show
    // for it but the counters moved.
    const logger = new SessionLogger('u5', 't', 'm');
    logger.flush(turn, 'm', { inputTokens: 100, outputTokens: 50, requestCount: 1 });
    logger.flush(turn, 'm', { inputTokens: 400, outputTokens: 50, requestCount: 2 });
    expect(usageRows('u5')).toHaveLength(2);
  });
});
