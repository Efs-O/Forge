import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerSession } from '../../src/agents/CodexAppServerSession';

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
      argsPrefix: [
        fixture,
        'REQUIRE_FORGE_FULL_ACCESS',
        'REQUIRE_FORGE_NEVER_APPROVAL',
      ],
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
    const dangerous = await current.send(
      'TRIGGER_COMMAND_APPROVAL TRIGGER_DANGEROUS_APPROVAL',
      {
        onEvent: (event) => {
          if (event.kind === 'status') statuses.push(event.text);
        },
      },
    );
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

  // Phase 1 (CODEX_STAND_IN_PLAN test 12): the eager-start seam is idempotent
  // (a second call reuses the same start — no second spawn) and refuses after
  // dispose (stop() clears startPromise, so without the guard a post-dispose
  // eager start would spawn a fresh app-server).
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
