import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One liveness check per (executable, cwd, sessionId) at a time.
 *
 * `ask_agent` called this on every question, and each call spawned a throwaway
 * `codex app-server` to read a thread by id. Two asks in one round spawned twice and
 * the second timed out (lab run U2b, 2026-11-09): the second caller must await
 * the check already running, and a settled check must not be reused.
 */

const readThreadMock = vi.fn();
const constructorMock = vi.fn();

vi.mock('../../src/agentMesh/codexDiscovery', () => ({
  CodexDiscovery: class {
    constructor(options: unknown) {
      constructorMock(options);
    }
    readThread = (threadId: string) => readThreadMock(threadId);
  },
}));

vi.mock('../../src/agents/resolveCliExecutable', () => ({
  resolveCliExecutable: vi.fn(async () => '/usr/bin/codex'),
}));

import { codexThreadIsLive } from '../../src/agentLinks/codexThreadLiveness';

const live = () => Promise.resolve(true);

beforeEach(() => {
  readThreadMock.mockReset();
  constructorMock.mockReset();
});

describe('two asks for the same linked Codex thread in one round', () => {
  it('spawn the app-server once and both get the same answer', async () => {
    readThreadMock.mockReturnValue(live());
    const options = { cwd: '/repo', timeoutMs: 15_000 };
    const [first, second] = await Promise.all([
      codexThreadIsLive('sess-1', options),
      codexThreadIsLive('sess-1', options),
    ]);
    expect(readThreadMock).toHaveBeenCalledTimes(1);
    expect(constructorMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it('spawn twice when the threads differ', async () => {
    readThreadMock.mockImplementation((id: string) => Promise.resolve(id === 'sess-1'));
    const options = { cwd: '/repo' };
    const [first, second] = await Promise.all([
      codexThreadIsLive('sess-1', options),
      codexThreadIsLive('sess-2', options),
    ]);
    expect(readThreadMock).toHaveBeenCalledTimes(2);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('share a rejected check, and the next ask spawns again', async () => {
    readThreadMock
      .mockReturnValueOnce(Promise.reject(new Error('app-server did not answer')))
      .mockReturnValue(live());
    const options = { cwd: '/repo' };
    const settled = await Promise.allSettled([
      codexThreadIsLive('sess-1', options),
      codexThreadIsLive('sess-1', options),
    ]);
    expect(readThreadMock).toHaveBeenCalledTimes(1);
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(await codexThreadIsLive('sess-1', options)).toBe(true);
    expect(readThreadMock).toHaveBeenCalledTimes(2);
  });

  it('ask again after a check settled rather than trusting a stale answer', async () => {
    readThreadMock.mockReturnValueOnce(live()).mockReturnValue(Promise.resolve(false));
    const options = { cwd: '/repo' };
    expect(await codexThreadIsLive('sess-1', options)).toBe(true);
    expect(await codexThreadIsLive('sess-1', options)).toBe(false);
    expect(readThreadMock).toHaveBeenCalledTimes(2);
  });
});
