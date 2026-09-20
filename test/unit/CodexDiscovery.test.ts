import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CodexDiscovery, matchThread } from '../../src/agentMesh/codexDiscovery';

const fixture = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs');

function discovery(): CodexDiscovery {
  return new CodexDiscovery({
    executable: process.execPath,
    argsPrefix: [fixture],
    cwd: process.cwd(),
  });
}

describe('CodexDiscovery (P4: scriptable thread/list against the app-server)', () => {
  it('lists the live threads from the app-server and parses the versioned contract', async () => {
    const d = discovery();
    const result = await d.discover();
    expect(result.threads.map((t) => t.id)).toEqual(['fixture-thread-1', 'fixture-thread-2']);
    // The Thread fields the contract promises are present and typed.
    expect(result.threads[0]).toMatchObject({
      id: 'fixture-thread-1',
      cwd: '/ws/one',
      name: 'first thread',
      preview: 'hello one',
      updatedAt: 1000,
    });
    // Optional fields are omitted, not undefined-filled, when absent.
    expect(result.threads[1].name).toBeUndefined();
  });

  it('resolves one match by cwd (criterion #1: one match)', async () => {
    const d = discovery();
    const { threads } = await d.discover();
    const res = matchThread(threads, { cwd: '/ws/one' });
    expect('thread' in res).toBe(true);
    if ('thread' in res) expect(res.thread.id).toBe('fixture-thread-1');
  });

  it('reports no match when the cwd matches nothing (criterion #1: no match)', async () => {
    const d = discovery();
    const { threads } = await d.discover();
    const res = matchThread(threads, { cwd: '/ws/none' });
    expect(res).toEqual({ none: true });
  });

  it('refuses with the candidate list on multiple matches (criterion #1: multiple)', async () => {
    const d = discovery();
    const { threads } = await d.discover();
    // No cwd filter: both threads are candidates → ambiguous, never guessed.
    const res = matchThread(threads, {});
    expect('ambiguous' in res).toBe(true);
    if ('ambiguous' in res) expect(res.ambiguous.map((t) => t.id)).toEqual([
      'fixture-thread-1',
      'fixture-thread-2',
    ]);
  });

  it('matches by name (substring, case-insensitive)', async () => {
    const d = discovery();
    const { threads } = await d.discover();
    const res = matchThread(threads, { name: 'FIRST' });
    expect('thread' in res).toBe(true);
    if ('thread' in res) expect(res.thread.id).toBe('fixture-thread-1');
  });

  it('never owns a session: the app-server process is disposed after discovery', async () => {
    const d = discovery();
    await d.discover();
    // dispose() is idempotent and the process is gone.
    await d.dispose();
  });
});
