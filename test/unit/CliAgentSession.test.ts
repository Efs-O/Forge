import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CliAgentSession } from '../../src/agents/CliAgentSession';
import type { CliAgentEvent, CliAgentRunResult } from '../../src/agents/types';

/** When `on`: a kill of a live child lingers so its exit event lands first,
 *  and a kill of an already-dead child (a stale stop) waits for `gate`. */
const stops = vi.hoisted(() => ({
  on: false,
  stale: 0,
  gate: Promise.resolve(),
  controlled: false,
  staleStarted: undefined as (() => void) | undefined,
  staleFinished: undefined as (() => void) | undefined,
}));

vi.mock('../../src/agents/cliProcess', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/cliProcess')>();
  return {
    ...real,
    terminateCliProcessTree: async (
      ...args: Parameters<typeof real.terminateCliProcessTree>
    ): Promise<void> => {
      const [child] = args;
      const dead = child.exitCode !== null || child.signalCode !== null;
      if (stops.controlled) {
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', resolve);
          child.once('error', resolve);
          if (!child.kill()) resolve();
        });
      } else {
        await real.terminateCliProcessTree(...args);
      }
      if (!stops.on) return;
      if (!dead) return;
      stops.stale++;
      stops.staleStarted?.();
      await stops.gate;
      stops.staleFinished?.();
    },
  };
});

const claudeFixture = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs');

function sendUntilInit(session: CliAgentSession): {
  initialized: Promise<void>;
  pending: Promise<CliAgentRunResult>;
} {
  let release!: () => void;
  const initialized = new Promise<void>((resolve) => (release = resolve));
  const onEvent = (event: CliAgentEvent): void => {
    if (event.kind === 'text' && event.text.includes('fixture init ready')) release();
  };
  return {
    initialized,
    pending: session.send('TRIGGER_INIT_THEN_SLOW', { onEvent }),
  };
}

function createSession(confirmedSessionId?: string, timeoutMs?: number): CliAgentSession {
  return new CliAgentSession({
    executable: process.execPath,
    argsPrefix: [claudeFixture],
    cwd: process.cwd(),
    ...(confirmedSessionId ? { confirmedSessionId } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

describe('CliAgentSession', () => {
  it('tags the spawned CLI so the Claude extension lists the session in its history', async () => {
    const session = createSession();
    try {
      const result = await session.send('TRIGGER_ECHO_ENTRYPOINT');
      expect(result.finalText).toBe('entrypoint=claude-vscode');
    } finally {
      await session.dispose();
    }
  });

  it('handles two warm turns in the same process', async () => {
    const session = createSession();
    try {
      const first = await session.send('WARM_TURN one');
      const second = await session.send('WARM_TURN two');
      expect(first.finalText).toBe('Done warm turn 1');
      expect(second.finalText).toBe('Done warm turn 2');
      expect(session.confirmedSessionId).toBe('fixture-session-id');
      expect(session.state).toBe('idle');
    } finally {
      await session.dispose();
    }
  });

  it('retains the last confirmed session after cancellation and cold-resumes', async () => {
    const session = createSession('confirmed-id');
    const controller = new AbortController();
    const pending = session.send('TRIGGER_SLOW', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect((await pending).status).toBe('cancelled');
    expect(session.confirmedSessionId).toBe('confirmed-id');
    const resumed = await session.send('WARM_TURN resumed');
    expect(resumed.status).toBe('completed');
    expect(resumed.sessionId).toBe('confirmed-id');
    await session.dispose();
  }, 10_000);

  it('keeps the observed session id when a turn times out, so the retry resumes warm', async () => {
    // A timed-out turn used to drop the id, forcing the next attempt to spawn a
    // cold process and re-pay the whole prompt prefix as a cache miss.
    // The fixture must first spawn and emit its init event. A sub-second turn
    // timeout races that setup when the full Vitest suite is under load.
    vi.useFakeTimers();
    stops.controlled = true;
    const session = createSession(undefined, 250);
    try {
      const first = sendUntilInit(session);
      await first.initialized;
      await vi.advanceTimersByTimeAsync(250);
      const timedOut = await first.pending;
      expect(timedOut.status).toBe('timed_out');
      expect(timedOut.sessionId).toBe('fixture-session-id');
      expect(session.confirmedSessionId).toBe('fixture-session-id');
      const retried = await session.send('WARM_TURN retry');
      expect(retried.status).toBe('completed');
      expect(retried.sessionId).toBe('fixture-session-id');
    } finally {
      await session.dispose();
      stops.controlled = false;
      vi.useRealTimers();
    }
  }, 10_000);

  it('a stale stop from the timed-out child leaves the next turn alone', async () => {
    // The timeout's stop and the dying child's exit each start a stop. The
    // second one is held until the next turn is running; it used to close
    // that turn's reader and resolve it as failed.
    vi.useFakeTimers();
    stops.controlled = true;
    let release = (): void => {};
    let staleStarted!: () => void;
    let staleFinished!: () => void;
    const staleStopStarted = new Promise<void>((resolve) => (staleStarted = resolve));
    const staleStopFinished = new Promise<void>((resolve) => (staleFinished = resolve));
    stops.on = true;
    stops.stale = 0;
    stops.gate = new Promise<void>((r) => (release = r));
    stops.staleStarted = () => staleStarted();
    stops.staleFinished = () => staleFinished();
    const session = createSession(undefined, 250);
    try {
      const first = sendUntilInit(session);
      await first.initialized;
      await vi.advanceTimersByTimeAsync(250);
      expect((await first.pending).status).toBe('timed_out');
      await staleStopStarted;
      expect(stops.stale).toBeGreaterThanOrEqual(1);
      const controller = new AbortController();
      let settled = false;
      const next = session.send('TRIGGER_SLOW', { signal: controller.signal });
      void next.then(() => (settled = true));
      expect(session.state).toBe('running');
      release();
      await staleStopFinished;
      await Promise.resolve();
      expect(settled).toBe(false);
      controller.abort();
      expect((await next).status).toBe('cancelled');
    } finally {
      release();
      await session.dispose();
      stops.on = false;
      stops.controlled = false;
      stops.staleStarted = undefined;
      stops.staleFinished = undefined;
      vi.useRealTimers();
    }
  }, 10_000);

  it('rejects a concurrent send deterministically', async () => {
    const session = createSession();
    const controller = new AbortController();
    const pending = session.send('TRIGGER_SLOW', { signal: controller.signal });
    await expect(session.send('second')).rejects.toThrow('already has an active turn');
    controller.abort();
    await pending;
    await session.dispose();
  }, 10_000);
});
