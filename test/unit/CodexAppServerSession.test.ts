import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { FakeCliChildBehaviour } from '../support/fakeCli';
import { CodexAppServerSession } from '../../src/agents/CodexAppServerSession';

/** Faked `spawnCliProcess` for the outcomes a `process.execPath` fixture cannot
 *  produce: a program that is not there, and one that starts and then exits
 *  non-zero with something on stderr. `behaviour` unset means the real spawn,
 *  so the warm-turn suites below are untouched. */
const fake = vi.hoisted(() => ({
  behaviour: undefined as FakeCliChildBehaviour | undefined,
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
      if (!fake.behaviour) return real.spawnCliProcess(options);
      const { child, writes } = fakeCliChild(options.executable, fake.behaviour);
      fake.spawns.push({ writes });
      return child;
    },
    // The real one runs `taskkill` against a faked pid; counting the calls is
    // the point of these tests, so this records one and returns.
    terminateCliProcessTree: async (child: Parameters<typeof real.terminateCliProcessTree>[0]) => {
      if (!fake.behaviour) return real.terminateCliProcessTree(child);
      fake.terminations++;
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

const fixture = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs');

function session(confirmedSessionId?: string): CodexAppServerSession {
  return new CodexAppServerSession({
    cliName: 'codex',
    executable: process.execPath,
    argsPrefix: [fixture],
    access: 'full',
    cwd: process.cwd(),
    ...(confirmedSessionId ? { confirmedSessionId } : {}),
  });
}

describe('CodexAppServerSession', () => {
  it('maps warm turns, completed messages, mismatched deltas, history, and thread identity', async () => {
    const current = session();
    const statuses: string[] = [];
    const first = await current.send('first', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    const second = await current.send('second');
    expect(first.finalText).toBe('Done codex turn 1');
    expect(second.finalText).toBe('Done codex turn 2');
    expect(second.sessionId).toBe('fixture-thread-id');
    expect(statuses).toContain('[codex: commandExecution]');
    const completed = await current.send('TRIGGER_COMPLETED_MESSAGE');
    expect(completed.finalText).toBe('Done codex turn 3 The command completed successfully.');
    const mismatched = await current.send('TRIGGER_MISMATCHED_DELTA_ITEM');
    expect(mismatched.finalText).toBe('Done codex turn 4');
    const history = await current.send('TRIGGER_HISTORY_ONLY_MESSAGE');
    expect(history.finalText).toBe(
      'Done codex turn 5 The command completed successfully from history.',
    );
    await current.dispose();
  });

  it('interrupts a turn and keeps the app-server warm', async () => {
    const current = session();
    const controller = new AbortController();
    const pending = current.send('TRIGGER_SLOW', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await pending).status).toBe('cancelled');
    const after = await current.send('after interrupt');
    expect(after.error).toBeUndefined();
    expect(after.status).toBe('completed');
    await current.dispose();
  });

  // Audit F5: a Stop pressed while Forge was asking Codex a question did not
  // answer within the caller's bound and left the chat busy. `send()` awaited
  // the cold start with no abort listener at all — `ensureStarted()` took no
  // signal, and the listener was only attached after that await — so an abort
  // during a start that never finished was ignored for as long as the child
  // held it open.
  it('cancels a cold start that never answers, and stops the child it started', async () => {
    const current = new CodexAppServerSession({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [fixture, 'NEVER_ANSWER_INITIALIZE'],
      access: 'full',
      cwd: process.cwd(),
    });
    const controller = new AbortController();
    const pending = current.send('first', { signal: controller.signal });
    const spawnedPid = await vi.waitFor(() => {
      const pid = current.pid;
      if (typeof pid !== 'number') throw new Error('the app-server had not spawned yet');
      return pid;
    });
    setTimeout(() => controller.abort(), 100);
    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1_000)),
    ]);
    expect(outcome).not.toBe('HUNG');
    expect((await pending).status).toBe('cancelled');
    // Only the child this session started is stopped, and it really is
    // stopped: `send()` answers as soon as the abort is accepted (it must not
    // make the caller wait out a termination), and the app-server Forge
    // started has to be gone after it, or a cancelled turn has leaked a daemon.
    expect(current.pid).toBeUndefined();
    await vi.waitFor(
      () => expect(() => process.kill(spawnedPid, 0)).toThrow(),
      { timeout: 8_000 },
    );
    await current.dispose();
  });

  it('disposes on malformed protocol output', async () => {
    const current = session();
    const result = await current.send('TRIGGER_PROTOCOL');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('malformed JSON');
    await current.dispose();
  });

  // The resume path used to drop agent_bus.codex_model/codex_effort, so a
  // resumed thread silently kept the model it was created with. The fixture
  // refuses the resume unless the overrides are on the wire.
  it('resumes the exact persisted thread and re-applies model and effort overrides', async () => {
    const current = new CodexAppServerSession({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [fixture, 'REQUIRE_FORGE_RESUME_MODEL', 'REQUIRE_FORGE_RESUME_EFFORT'],
      access: 'full',
      cwd: process.cwd(),
      confirmedSessionId: 'persisted-thread',
      model: 'gpt-6-luna',
      effort: 'xhigh',
    });
    const result = await current.send('resumed with overrides');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.sessionId).toBe('persisted-thread');
    await current.dispose();
  });

  it('sends no resume overrides when neither model nor effort is configured', async () => {
    const current = new CodexAppServerSession({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [fixture, 'REQUIRE_FORGE_RESUME_BARE'],
      access: 'full',
      cwd: process.cwd(),
      confirmedSessionId: 'persisted-thread',
    });
    const result = await current.send('resumed bare');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    await current.dispose();
  });

  it('applies full-access policy and answers command and network approvals', async () => {
    const current = new CodexAppServerSession({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [fixture, 'REQUIRE_FORGE_FULL_ACCESS', 'REQUIRE_FORGE_NEVER_APPROVAL'],
      cwd: process.cwd(),
    });
    const statuses: string[] = [];
    const command = await current.send('TRIGGER_COMMAND_APPROVAL', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    expect(command.finalText).toBe('Approval accept');
    expect(statuses).toContain('[codex policy: allowed command]');
    const dangerous = await current.send('TRIGGER_COMMAND_APPROVAL TRIGGER_DANGEROUS_APPROVAL', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    expect(dangerous.finalText).toBe('Approval accept');
    expect(statuses.filter((text) => text === '[codex policy: allowed command]')).toHaveLength(2);
    const network = await current.send('TRIGGER_NETWORK_APPROVAL', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    expect(network.finalText).toBe('Approval accept');
    expect(statuses).toContain('[codex policy: allowed command]');
    await current.dispose();
  });

  // The eager-start seam is idempotent (a second call reuses the same start —
  // no second spawn) and refuses after dispose (`stop()` clears `startPromise`,
  // so without the guard a post-dispose eager start would spawn a fresh
  // app-server nobody is waiting on).
  it('eager-starts once and refuses to start again after dispose', async () => {
    const current = session();
    await current.ensureStarted();
    const pid = current.pid;
    expect(pid).toBeTypeOf('number');
    await current.ensureStarted();
    expect(current.pid).toBe(pid);
    await current.dispose();
    await expect(current.ensureStarted()).rejects.toThrow(/disposed/);
    expect(current.pid).toBeUndefined();
  });
});

describe('CodexAppServerSession start and process failures', () => {
  /** A session whose executable is not on the machine at all — the laptop's
   *  `Couldn't start` case, with nothing real spawned. */
  function missingProgramSession(): CodexAppServerSession {
    fake.behaviour = { spawnError: { code: 'ENOENT' } };
    fake.spawns.length = 0;
    fake.terminations = 0;
    logged.warn.length = 0;
    return new CodexAppServerSession({
      cliName: 'codex',
      executable: 'forge_probe_missing_program',
      argsPrefix: [fixture],
      cwd: process.cwd(),
    });
  }

  it('reports a missing executable as a start failure, never as write EPIPE', async () => {
    const session = missingProgramSession();
    const failure = await session.send('probe').catch((error) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("Couldn't start Codex");
    expect(failure.message).toContain('ENOENT');
    expect(failure.message).toContain('forge_probe_missing_program');
    expect(failure.message).not.toContain('write failed');
    // The gated write never happened, so no EPIPE was ever produced.
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0].writes).toHaveLength(0);
    // Terminated once: the spawn gate reports the failure and the exit watcher
    // ends the process, so neither path may terminate on its own.
    expect(fake.terminations).toBe(1);
    // Exactly one channel line for the failure, carrying the code and the
    // executable, and no environment value.
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toContain('code=null');
    expect(logged.warn[0]).toContain('signal=none');
    expect(logged.warn[0]).toContain('exe=forge_probe_missing_program');
    expect(logged.warn[0]).not.toContain('env=');
    await session.dispose();
    expect(fake.terminations).toBe(1);
  });

  it('holds one turn reservation across the spawn gate', async () => {
    const session = missingProgramSession();
    const settled = await Promise.allSettled([session.send('one'), session.send('two')]);
    expect(settled[0].status).toBe('rejected');
    expect((settled[0] as PromiseRejectedResult).reason.message).toContain("Couldn't start Codex");
    expect((settled[1] as PromiseRejectedResult).reason.message).toContain(
      'already has an active turn',
    );
    // The reservation is what keeps two first sends from spawning two
    // app-servers; the gate's await must not open that window again.
    expect(fake.spawns).toHaveLength(1);
    expect(fake.terminations).toBe(1);
    await session.dispose();
  });

  it('writes one line with the exit code and the stderr tail when the app-server exits non-zero', async () => {
    fake.behaviour = { exit: { code: 1 }, stderrText: 'app-server refused: no model' };
    fake.spawns.length = 0;
    fake.terminations = 0;
    logged.warn.length = 0;
    const session = new CodexAppServerSession({
      cliName: 'codex',
      executable: 'forge_probe_closing_program',
      argsPrefix: [fixture],
      cwd: process.cwd(),
    });
    const failure = await session.send('probe').catch((error) => error as Error);
    expect(failure.message).toContain('exited with code 1');
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toContain('code=1');
    expect(logged.warn[0]).toContain('stderr=app-server refused: no model');
    await session.dispose();
  });
});
