import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { FakeCliChildBehaviour } from '../support/fakeCli';
import { CliAgentError } from '../../src/agents/CliAgentError';
import { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import type { CliAgentEvent } from '../../src/agents/types';

/** Faked `spawnCliProcess` for the one outcome the `process.execPath` fixtures
 *  cannot produce: a program that is not there. `behaviour` unset means the
 *  real spawn, so the parsing suites below are untouched. */
const fake = vi.hoisted(() => ({
  behaviour: undefined as FakeCliChildBehaviour | undefined,
  /** A synchronous refusal from the spawn site itself: `buildCliProcessInvocation`
   *  can throw before any child exists when an npm shim's launcher is missing. */
  startError: undefined as Error | undefined,
  spawns: [] as Array<{ writes: string[] }>,
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
    // The real one runs `taskkill` against a faked pid.
    terminateCliProcessTree: async (child: Parameters<typeof real.terminateCliProcessTree>[0]) => {
      if (!fake.behaviour) return real.terminateCliProcessTree(child);
      child.kill();
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
const codexFixture = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs');

describe('CliAgentDriver', () => {
  it('parses claude stream-json: text deltas, tool-use status, and the final result', async () => {
    const events: CliAgentEvent[] = [];
    const lifecycle: string[] = [];
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'do the thing',
      cwd: process.cwd(),
      onSpawned: () => lifecycle.push('spawned'),
      onSessionId: () => lifecycle.push('session'),
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Done: updated src/foo.ts');
    expect(events).toContainEqual({ kind: 'text', text: 'Looking at the repo. ' });
    expect(events).toContainEqual({ kind: 'status', text: '[claude: Edit src/foo.ts]' });
    expect(lifecycle[0]).toBe('spawned');
    expect(lifecycle).toEqual(['spawned']);
  });

  it('parses codex JSONL: text deltas, exec/patch status, and task_complete', async () => {
    const events: CliAgentEvent[] = [];
    const result = await new CliAgentDriver().run({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [codexFixture],
      task: 'do the thing',
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Done: updated src/foo.ts');
    expect(events).toContainEqual({ kind: 'text', text: 'Looking at the repo. ' });
    expect(events).toContainEqual({ kind: 'status', text: '[codex: exec ls src]' });
    expect(events).toContainEqual({ kind: 'status', text: '[codex: edit src/foo.ts]' });
  });

  it('surfaces a non-zero exit as a failed result with exit code + stderr tail', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_FAIL',
      cwd: process.cwd(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exited with code 1');
    expect(result.error).toContain('boom, something broke');
  });

  it('surfaces an is_error result message as failed without needing a non-zero exit', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_ERROR_RESULT',
      cwd: process.cwd(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('refused: unsafe request');
  });

  it('surfaces a codex error event as failed', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [codexFixture],
      task: 'TRIGGER_ERROR_RESULT',
      cwd: process.cwd(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('sandbox denied the requested command');
  });

  it('kills the child and returns cancelled on abort', async () => {
    const controller = new AbortController();
    const pending = new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_SLOW',
      cwd: process.cwd(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.status).toBe('cancelled');
  }, 10_000);

  it('kills the child and returns timed_out when it exceeds timeoutMs', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_SLOW',
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(result.status).toBe('timed_out');
    expect(result.error).toContain('exceeded 200ms timeout');
  }, 10_000);
});

describe('CliAgentDriver start failures (pinned)', () => {
  // This driver already named the start failure before the warm sessions did,
  // and the fix for those must not drag it into their pattern: the outcome
  // order and the message are asserted here so a later refactor cannot regress
  // them into reporting the `write EPIPE` that follows the ENOENT.
  it('reports a missing executable as a start failure, with one channel line', async () => {
    fake.behaviour = { spawnError: { code: 'ENOENT' } };
    fake.spawns.length = 0;
    logged.warn.length = 0;
    logged.info.length = 0;
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: 'forge_probe_missing_program',
      task: 'do the thing',
      cwd: process.cwd(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe(
      'claude CLI failed to start: spawn forge_probe_missing_program ENOENT',
    );
    expect(result.error).not.toContain('write failed');
    // Exactly one line for the failure: the driver's own, with no second line
    // beside it. `spawnCliProcess`'s start line is info-level and comes from
    // the real spawn, which this case does not take.
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toContain('claude failed:');
    expect(logged.warn[0]).toContain('forge_probe_missing_program');
    expect(logged.warn[0]).not.toContain('env=');
  });

  it("surfaces the spawn site's own refusal as the rejection its callers report", async () => {
    // `buildCliProcessInvocation` can throw before any child exists: an npm
    // node-script shim with no `node.exe` beside it and none on the PATH. Every
    // caller of this driver catches the rejection and shows the message — a CLI
    // chat turn (CliTurn's run-stage catch), a delegation (LocalDelegationService
    // re-throws it as a DelegationError), ask_agent (askAgentRuntime returns it
    // as a failed result) — so it has to arrive intact, and must not become
    // `write EPIPE` or a hung turn.
    fake.startError = new CliAgentError(
      'Node.js not found, needed to run codex. Install Node ' +
        "(winget install OpenJS.NodeJS.LTS), or set `cli` to the CLI's own executable.",
    );
    fake.spawns.length = 0;
    logged.warn.length = 0;
    logged.info.length = 0;
    const failure = await new CliAgentDriver()
      .run({ cliName: 'codex', executable: 'C:\\npm\\codex.cmd', task: 'x', cwd: process.cwd() })
      .catch((error) => error as Error);
    expect(failure).toBeInstanceOf(CliAgentError);
    expect(failure.message).toContain('Node.js not found');
    expect(failure.message).toContain('winget install OpenJS.NodeJS.LTS');
    expect(failure.message).not.toContain('EPIPE');
    // Nothing was spawned, so nothing was terminated and no outcome line was
    // written: the refusal is the whole report.
    expect(fake.spawns).toHaveLength(0);
    expect(logged.warn).toHaveLength(0);
    fake.startError = undefined;
  });
});
