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
  it('maps warm deltas, statuses, completion, and thread identity', async () => {
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

  it('resumes the exact persisted thread id', async () => {
    const current = session('persisted-thread');
    const result = await current.send('resumed');
    expect(result.sessionId).toBe('persisted-thread');
    await current.dispose();
  });

  // The resume path used to drop agent_bus.codex_model/codex_effort, so a
  // resumed thread silently kept the model it was created with. The fixture
  // refuses the resume unless the overrides are on the wire.
  it('re-applies codex_model and codex_effort when resuming a thread', async () => {
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

  it('applies the full-access, never-approval policy to the Forge-owned app-server process', async () => {
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
    const result = await current.send('verify global sandbox policy');
    expect(result.status).toBe('completed');
    await current.dispose();
  });

  it('answers an approval request rather than leaving the turn stalled', async () => {
    const current = session();
    const statuses: string[] = [];
    const result = await current.send('TRIGGER_COMMAND_APPROVAL', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    expect(result.finalText).toBe('Approval accept');
    expect(statuses).toContain('[codex policy: allowed command]');
    await current.dispose();
  });

  // Codex runs unrestricted, so nothing is screened out — but every request
  // still gets an answer, because an unanswered one hangs the turn forever.
  it('allows a command an earlier build would have screened out', async () => {
    const current = session();
    const statuses: string[] = [];
    const result = await current.send('TRIGGER_COMMAND_APPROVAL TRIGGER_DANGEROUS_APPROVAL', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    expect(result.finalText).toBe('Approval accept');
    expect(statuses).toContain('[codex policy: allowed command]');
    await current.dispose();
  });

  it('allows network-expansion requests through the command channel', async () => {
    const current = session();
    const statuses: string[] = [];
    const result = await current.send('TRIGGER_NETWORK_APPROVAL', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    expect(result.finalText).toBe('Approval accept');
    expect(statuses).toContain('[codex policy: allowed command]');
    await current.dispose();
  });

  it('keeps a final assistant message delivered only on item completion', async () => {
    const current = session();
    const result = await current.send('TRIGGER_COMPLETED_MESSAGE');
    expect(result.finalText).toBe('Done codex turn 1 The command completed successfully.');
    await current.dispose();
  });

  it('does not duplicate a completed message when its delta uses another item id', async () => {
    const current = session();
    const result = await current.send('TRIGGER_MISMATCHED_DELTA_ITEM');
    expect(result.finalText).toBe('Done codex turn 1');
    await current.dispose();
  });

  it('recovers a post-command final message from completed turn history', async () => {
    const current = session();
    const result = await current.send('TRIGGER_HISTORY_ONLY_MESSAGE');
    expect(result.finalText).toBe('Done codex turn 1 The command completed successfully from history.');
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
