import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CliAgentSession } from '../../src/agents/CliAgentSession';
import {
  CliSessionCapacityError,
  CliSessionRegistry,
  type WarmCliSession,
} from '../../src/agents/CliSessionRegistry';
import type { CliAgentRunResult } from '../../src/agents/types';

const fixture = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs');
const options = {
  executable: process.execPath,
  argsPrefix: [fixture],
  cwd: process.cwd(),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function warmSession(dispose: () => Promise<void> = async () => {}): WarmCliSession {
  let state: 'idle' | 'disposed' = 'idle';
  return {
    get state() {
      return state;
    },
    confirmedSessionId: 'fixture-session-id',
    send: async (): Promise<CliAgentRunResult> => ({ status: 'completed', finalText: 'done' }),
    dispose: async () => {
      state = 'disposed';
      await dispose();
    },
  };
}

describe('CliSessionRegistry', () => {
  it('isolates conversation/model pairs and evicts the LRU idle session', async () => {
    const created: CliAgentSession[] = [];
    const registry = new CliSessionRegistry(2, 60_000, (value) => {
      const session = new CliAgentSession(value);
      created.push(session);
      return session;
    });
    await registry.run({ conversationId: 'a', modelName: 'm' }, options, 'WARM_TURN a');
    await registry.run({ conversationId: 'b', modelName: 'm' }, options, 'WARM_TURN b');
    await registry.run({ conversationId: 'c', modelName: 'm' }, options, 'WARM_TURN c');
    expect(created).toHaveLength(3);
    expect(created[0]!.state).toBe('disposed');
    expect(created[1]!.state).toBe('idle');
    await registry.dispose();
  });

  it('never evicts a busy session when capacity is full', async () => {
    const registry = new CliSessionRegistry(1, 60_000);
    const controller = new AbortController();
    const busy = registry.run(
      { conversationId: 'a', modelName: 'm' },
      options,
      'TRIGGER_SLOW',
      { signal: controller.signal },
    );
    await expect(
      registry.run({ conversationId: 'b', modelName: 'm' }, options, 'WARM_TURN b'),
    ).rejects.toBeInstanceOf(CliSessionCapacityError);
    controller.abort();
    await busy;
    await registry.dispose();
  });

  it('disposes idle sessions on the timer', async () => {
    vi.useFakeTimers();
    const started = deferred();
    const finished = deferred();
    const release = deferred();
    const session = warmSession(async () => {
      started.resolve();
      await release.promise;
      finished.resolve();
    });
    const registry = new CliSessionRegistry(2, 20, () => session);
    const key = { conversationId: 'a', modelName: 'm' };
    try {
      await registry.run(key, options, 'WARM_TURN a');
      expect(registry.getConfirmedSessionId(key)).toBe('fixture-session-id');
      await vi.advanceTimersByTimeAsync(19);
      expect(session.state).toBe('idle');
      await vi.advanceTimersByTimeAsync(1);
      await started.promise;
      expect(session.state).toBe('disposed');
      expect(registry.getConfirmedSessionId(key)).toBeUndefined();
      release.resolve();
      await finished.promise;
    } finally {
      release.resolve();
      await registry.dispose();
      vi.useRealTimers();
    }
  });

  it('awaits asynchronous cleanup when disposing a conversation', async () => {
    const started = deferred();
    const finished = deferred();
    const release = deferred();
    const session = warmSession(async () => {
      started.resolve();
      await release.promise;
      finished.resolve();
    });
    const registry = new CliSessionRegistry(2, 60_000, () => session);
    await registry.run({ conversationId: 'b', modelName: 'm' }, options, 'WARM_TURN b');
    let settled = false;
    const cleanup = registry.disposeConversation('b').then(() => {
      settled = true;
    });
    try {
      await started.promise;
      expect(settled).toBe(false);
      release.resolve();
      await cleanup;
      await finished.promise;
      expect(settled).toBe(true);
      expect(session.state).toBe('disposed');
    } finally {
      release.resolve();
      await registry.dispose();
    }
  });
});
