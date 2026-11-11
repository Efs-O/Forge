import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** One app-server read is shared by asks for the same thread. */
const readThreadMock = vi.fn(async (_threadId: string): Promise<boolean> => false);
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

beforeEach(() => {
  readThreadMock.mockReset().mockResolvedValue(false);
  constructorMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Codex liveness thread reads', () => {
  it('shares one read across concurrent asks for the same thread', async () => {
    let resolveRead!: (live: boolean) => void;
    readThreadMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveRead = resolve)),
    );
    const options = { cwd: '/repo/concurrent', timeoutMs: 15_000 };
    const first = codexThreadIsLive('sess-1', options);
    const second = codexThreadIsLive('sess-1', options);
    await vi.waitFor(() => expect(readThreadMock).toHaveBeenCalledTimes(1));

    resolveRead(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(constructorMock).toHaveBeenCalledTimes(1);
  });

  it('reuses a positive result for 30 seconds, then reads the thread again', async () => {
    vi.useFakeTimers();
    readThreadMock.mockResolvedValue(true);
    const options = { cwd: '/repo/positive-cache' };

    await expect(codexThreadIsLive('sess-1', options)).resolves.toBe(true);
    await expect(codexThreadIsLive('sess-1', options)).resolves.toBe(true);
    expect(readThreadMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(codexThreadIsLive('sess-1', options)).resolves.toBe(true);
    expect(readThreadMock).toHaveBeenCalledTimes(2);
  });

  it('rechecks a false result on the next ask', async () => {
    readThreadMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const options = { cwd: '/repo/negative-cache' };

    await expect(codexThreadIsLive('sess-1', options)).resolves.toBe(false);
    await expect(codexThreadIsLive('sess-1', options)).resolves.toBe(true);
    expect(readThreadMock).toHaveBeenCalledTimes(2);
  });

  it('does not share a read across different session ids in one workspace', async () => {
    readThreadMock.mockResolvedValue(false);
    const [first, second] = await Promise.all([
      codexThreadIsLive('sess-1', { cwd: '/repo/one-workspace' }),
      codexThreadIsLive('sess-2', { cwd: '/repo/one-workspace' }),
    ]);

    expect(readThreadMock).toHaveBeenCalledTimes(2);
    expect(readThreadMock).toHaveBeenNthCalledWith(1, 'sess-1');
    expect(readThreadMock).toHaveBeenNthCalledWith(2, 'sess-2');
    expect(first).toBe(false);
    expect(second).toBe(false);
  });

  it('does not cache errors and retries on the next ask', async () => {
    readThreadMock
      .mockRejectedValueOnce(new Error('app-server did not answer'))
      .mockResolvedValue(true);
    const options = { cwd: '/repo/retry' };

    await expect(codexThreadIsLive('sess-1', options)).rejects.toThrow('app-server did not answer');
    await expect(codexThreadIsLive('sess-1', options)).resolves.toBe(true);
    expect(readThreadMock).toHaveBeenCalledTimes(2);
  });
});
