import * as path from 'path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { FakeCliChildBehaviour } from '../support/fakeCli';
import { CodexDiscovery, matchThread } from '../../src/agentMesh/codexDiscovery';

/** Faked `spawnCliProcess` for the outcome the fixture cannot produce: a
 *  program that is not there. `behaviour` unset means the real spawn, so the
 *  thread-listing suites above are untouched. */
const fake = vi.hoisted(() => ({
  behaviour: undefined as FakeCliChildBehaviour | undefined,
}));

vi.mock('../../src/agents/cliProcess', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/cliProcess')>();
  const { fakeCliChild } = await import('../support/fakeCli');
  return {
    ...real,
    spawnCliProcess: (options: Parameters<typeof real.spawnCliProcess>[0]) => {
      if (!fake.behaviour) return real.spawnCliProcess(options);
      return fakeCliChild(options.executable, fake.behaviour).child;
    },
    // The real one runs `taskkill` against a faked pid.
    terminateProcessTree: async (child: Parameters<typeof real.terminateProcessTree>[0]) => {
      if (!fake.behaviour) return real.terminateProcessTree(child);
      child.kill();
    },
  };
});

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
    if ('ambiguous' in res)
      expect(res.ambiguous.map((t) => t.id)).toEqual(['fixture-thread-1', 'fixture-thread-2']);
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
    const state = d as unknown as { child?: ChildProcess };
    const result = d.discover();
    try {
      await vi.waitFor(() => expect(state.child).toBeDefined());
      const child = state.child!;
      await result;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await d.dispose();
    }
  });

  it('reads one thread by id', async () => {
    const d = discovery();
    await expect(d.readThread('fixture-thread-1')).resolves.toBe(true);
  });

  it('returns false when the requested thread is missing', async () => {
    const d = discovery();
    await expect(d.readThread('missing-thread')).resolves.toBe(false);
  });

  it('reports a reply without a thread as unknown, not missing', async () => {
    const d = discovery();
    await expect(d.readThread('threadless-reply')).rejects.toThrow(
      'thread/read returned no thread for threadless-reply',
    );
  });

  it('disposes the app-server process after reading a thread', async () => {
    const d = discovery();
    const state = d as unknown as { child?: ChildProcess };
    const result = d.readThread('fixture-thread-1');
    try {
      await vi.waitFor(() => expect(state.child).toBeDefined());
      const child = state.child!;
      await result;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await d.dispose();
    }
  });
});

describe('CodexDiscovery start failures (pinned)', () => {
  // Discovery reports the spawn error today only because it overwrites
  // `protocolError` unconditionally before rejecting everything, so the
  // `write EPIPE` that follows cannot win. That is the pattern the two warm
  // sessions lacked; these tests pin the message here so a refactor toward
  // "first message wins" cannot quietly regress it.
  it('reports the spawn error, not the write error that follows it', async () => {
    fake.behaviour = { spawnError: { code: 'ENOENT' } };
    const d = new CodexDiscovery({
      executable: 'forge_probe_missing_program',
      cwd: process.cwd(),
    });
    const failure = await d.discover().catch((error) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('Codex app-server transport failed');
    expect(failure.message).toContain('ENOENT');
    expect(failure.message).toContain('forge_probe_missing_program');
    expect(failure.message).not.toContain('write failed');
    await d.dispose();
  });

  it('reports the spawn error when reading a thread', async () => {
    fake.behaviour = { spawnError: { code: 'ENOENT' } };
    const d = new CodexDiscovery({
      executable: 'forge_probe_missing_program',
      cwd: process.cwd(),
    });
    const failure = await d.readThread('fixture-thread-1').catch((error) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('Codex app-server transport failed');
    expect(failure.message).toContain('ENOENT');
    expect(failure.message).toContain('forge_probe_missing_program');
    expect(failure.message).not.toContain('write failed');
    await d.dispose();
  });
});
