import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { FakeCliChildBehaviour } from '../support/fakeCli';
import { CliAgentError } from '../../src/agents/CliAgentError';
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

/** Faked `spawnCliProcess` for the outcomes the `process.execPath` fixture
 *  cannot produce: a program that is not there, and one that starts and then
 *  exits non-zero with something on stderr. `behaviour` unset means the real
 *  spawn, so the warm-turn suites below are untouched. */
const fake = vi.hoisted(() => ({
  behaviour: undefined as FakeCliChildBehaviour | undefined,
  /** A synchronous refusal from the spawn site itself: `buildCliProcessInvocation`
   *  throws before any child exists when an npm shim's launcher is missing. */
  startError: undefined as Error | undefined,
  spawns: [] as Array<{ writes: string[] }>,
  terminations: 0,
}));

/** The Forge channel, captured instead of created: `src/util/logger` builds a
 *  VS Code output channel the moment it is imported. */
const logged = vi.hoisted(() => ({
  warn: [] as string[],
  info: [] as string[],
  error: [] as string[],
}));

vi.mock('../../src/agents/cliProcess', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/cliProcess')>();
  const { fakeCliChild } = await import('../support/fakeCli');
  return {
    ...real,
    spawnCliProcess: (options: Parameters<typeof real.spawnCliProcess>[0]) => {
      if (fake.startError) throw fake.startError;
      if (!fake.behaviour) return real.spawnCliProcess(options);
      const { child, writes } = fakeCliChild(options.executable, fake.behaviour);
      fake.spawns.push({ writes });
      return child;
    },
    terminateCliProcessTree: async (
      ...args: Parameters<typeof real.terminateCliProcessTree>
    ): Promise<void> => {
      const [child] = args;
      // A faked child has no process to taskkill; the count is what these
      // tests assert, so record the kill and return.
      if (fake.behaviour) {
        fake.terminations++;
        child.kill();
        return;
      }
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

vi.mock('../../src/util/logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/util/logger')>();
  return {
    ...real,
    getLogger: () => ({
      info: (message: string) => logged.info.push(message),
      warn: (message: string) => logged.warn.push(message),
      error: (message: string) => logged.error.push(message),
    }),
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

describe('CliAgentSession start and process failures', () => {
  function sessionWith(behaviour: FakeCliChildBehaviour, executable: string): CliAgentSession {
    fake.behaviour = behaviour;
    fake.startError = undefined;
    fake.spawns.length = 0;
    fake.terminations = 0;
    logged.warn.length = 0;
    logged.info.length = 0;
    return new CliAgentSession({ executable, argsPrefix: [claudeFixture], cwd: process.cwd() });
  }

  it('reports a missing executable as a start failure, never as write EPIPE', async () => {
    // The laptop's report said `Claude CLI write failed: write EPIPE` for a
    // program that was never found: the write to a stdin with no reader was
    // reported, and the ENOENT that caused it was computed and thrown away.
    const session = sessionWith({ spawnError: { code: 'ENOENT' } }, 'forge_probe_missing_program');
    const result = await session.send('probe');
    expect(result.status).toBe('failed');
    expect(result.error).toContain("Couldn't start Claude");
    expect(result.error).toContain('ENOENT');
    expect(result.error).toContain('forge_probe_missing_program');
    expect(result.error).not.toContain('write failed');
    // The gated write never happened, so no EPIPE was ever produced.
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0].writes).toHaveLength(0);
    // Terminated once: the spawn gate reports the failure and the exit watcher
    // ends the process, so neither path may terminate on its own.
    expect(fake.terminations).toBe(1);
    // Exactly one channel line for the failure, carrying the code, the
    // executable and no environment value.
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toContain('code=null');
    expect(logged.warn[0]).toContain('signal=none');
    expect(logged.warn[0]).toContain('exe=forge_probe_missing_program');
    expect(logged.warn[0]).not.toContain('env=');
    await session.dispose();
    expect(fake.terminations).toBe(1);
    expect(logged.warn).toHaveLength(1);
  });

  it('writes one line with the exit code and the stderr tail when the CLI exits non-zero', async () => {
    const session = sessionWith(
      { exit: { code: 1 }, stderrText: 'claude refused: no key configured' },
      'forge_probe_closing_program',
    );
    const result = await session.send('probe');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exited with code 1');
    expect(fake.spawns[0].writes).toHaveLength(1); // it did start, so it was written to
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toContain('code=1');
    expect(logged.warn[0]).toContain('stderr=claude refused: no key configured');
    await session.dispose();
    expect(logged.warn).toHaveLength(1);
  });

  it('adds no process-failure line when Forge ended the child itself', async () => {
    // A child killed on cancel is not a CLI failure: its turn already reports
    // the cancel, and a second channel line for the same event is exactly the
    // double logging this fix removes.
    const session = sessionWith({}, 'forge_probe_hanging_program');
    const controller = new AbortController();
    const pending = session.send('probe', { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(logged.warn).toHaveLength(0);
    await session.dispose();
  });

  it('holds one turn reservation across the spawn gate', async () => {
    const session = sessionWith({ spawnError: { code: 'ENOENT' } }, 'forge_probe_missing_program');
    const settled = await Promise.allSettled([session.send('one'), session.send('two')]);
    expect(settled[0].status).toBe('fulfilled');
    expect((settled[0] as PromiseFulfilledResult<CliAgentRunResult>).value.status).toBe('failed');
    expect((settled[1] as PromiseRejectedResult).reason.message).toContain(
      'already has an active turn',
    );
    // The reservation is what keeps two first sends from spawning two Claude
    // processes; the gate's await must not open that window again.
    expect(fake.spawns).toHaveLength(1);
    expect(fake.terminations).toBe(1);
    await session.dispose();
  });

  it("reports the spawn site's own refusal as a failed send, not as EPIPE", async () => {
    // `buildCliProcessInvocation` throws before any child exists when an npm
    // node-script shim has no `node.exe` beside it and none on the PATH. The
    // warm chat path reports that rejection verbatim (CliSessionRegistry ->
    // CliChatRunner -> CliTurn's run-stage catch), so it must arrive intact and
    // must not turn into `write EPIPE` on a stdin that was never written.
    const session = sessionWith({}, 'C:\\npm\\codex.cmd');
    fake.startError = new CliAgentError(
      'Node.js not found, needed to run claude. Install Node ' +
        "(winget install OpenJS.NodeJS.LTS), or set `cli` to the CLI's own executable.",
    );
    const failure = await session.send('probe').catch((error) => error as Error);
    expect(failure).toBeInstanceOf(CliAgentError);
    expect(failure.message).toContain('Node.js not found');
    expect(failure.message).not.toContain('EPIPE');
    expect(failure.message).not.toContain('write failed');
    // Nothing was spawned: nothing to terminate, and no channel line for a
    // process that never existed.
    expect(fake.spawns).toHaveLength(0);
    expect(fake.terminations).toBe(0);
    expect(logged.warn).toHaveLength(0);
    // The refused spawn left no child and no reserved turn, so the next send
    // starts again and reports its own failure.
    fake.startError = undefined;
    fake.behaviour = { spawnError: { code: 'ENOENT' } };
    const retry = await session.send('again');
    expect(retry.status).toBe('failed');
    expect(retry.error).toContain("Couldn't start Claude");
    await session.dispose();
  });
});
