import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnServices } from '../../src/sidebar/turnServices';
import { ContactPromptGate } from '../../src/sidebar/contactPrompt';
import { runPromptToMarkdown } from '../../src/sidebar/PromptRun';

vi.mock('../../src/sidebar/PromptRun', () => ({ runPromptToMarkdown: vi.fn() }));

interface Hold {
  backend: { isReady: () => boolean };
  release: () => void;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const config = {
  active_model: 'model',
  models: [{ name: 'model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
};

const acquire = vi.fn<() => Promise<Hold>>();

function makeGate(): ContactPromptGate {
  const services = {
    getConfig: () => config,
    pool: {
      isLoaded: () => true,
      isModelReady: () => true,
      parallelCapacity: () => 1,
      acquireForDelegation: acquire,
    },
    toolRegistry: {},
  } as unknown as TurnServices;
  return new ContactPromptGate({
    services,
    streamingIds: () => new Set<string>(),
    conversationLookup: () => null,
    ownerPromptRunCount: () => 0,
    abortContactRuns: vi.fn(),
  });
}

function makeHold(): Hold {
  return { backend: { isReady: () => true }, release: vi.fn() };
}

describe('ContactPromptGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runPromptToMarkdown).mockResolvedValue('prompt result');
  });

  it('reserves the ready slot while the asynchronous acquire is pending', async () => {
    const waiting = deferred<Hold>();
    acquire.mockReturnValue(waiting.promise);
    const gate = makeGate();

    const first = gate.run('first prompt', 'system');
    expect(acquire).toHaveBeenCalledTimes(1);
    await expect(gate.run('second prompt', 'system')).rejects.toThrow(
      'Forge contact model is unavailable.',
    );
    expect(acquire).toHaveBeenCalledTimes(1);

    waiting.resolve(makeHold());
    await expect(first).resolves.toBe('prompt result');
  });

  it('releases its reservation when acquire rejects', async () => {
    acquire.mockRejectedValueOnce(new Error('pool acquire failed')).mockResolvedValue(makeHold());
    const gate = makeGate();

    await expect(gate.run('first prompt', 'system')).rejects.toThrow('pool acquire failed');
    await expect(gate.run('second prompt', 'system')).resolves.toBe('prompt result');
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('releases the acquired hold and reservation when the prompt fails', async () => {
    const hold = makeHold();
    acquire.mockResolvedValue(hold);
    vi.mocked(runPromptToMarkdown)
      .mockRejectedValueOnce(new Error('prompt failed'))
      .mockResolvedValueOnce('retry result');
    const gate = makeGate();

    await expect(gate.run('first prompt', 'system')).rejects.toThrow('prompt failed');
    expect(hold.release).toHaveBeenCalledOnce();
    await expect(gate.run('second prompt', 'system')).resolves.toBe('retry result');
  });
});
