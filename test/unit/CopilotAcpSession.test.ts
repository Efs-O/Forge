import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CopilotAcpSession, copilotAcpArgs } from '../../src/agents/CopilotAcpSession';

const fixture = path.resolve(__dirname, '../fixtures/fakeCopilotAcpCli.mjs');

function session(
  confirmedSessionId?: string,
  extraArgs: string[] = [],
  overrides: Partial<ConstructorParameters<typeof CopilotAcpSession>[0]> = {},
): CopilotAcpSession {
  return new CopilotAcpSession({
    executable: process.execPath,
    argsPrefix: [fixture, ...extraArgs],
    cwd: process.cwd(),
    ...(confirmedSessionId ? { confirmedSessionId } : {}),
    ...overrides,
  });
}

describe('CopilotAcpSession', () => {
  it('spawns with the ACP argv in the workspace cwd', async () => {
    const current = session();
    const result = await current.send('first');
    expect(result.status).toBe('completed');
    expect(result.sessionId).toBe('fixture-copilot-session');
    await current.dispose();
  });

  it('creates a fresh session and streams only agent_message_chunk text as the answer', async () => {
    const current = session();
    const events: { kind: string; text: string }[] = [];
    const result = await current.send('first', {
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Done copilot turn 1 finished.');
    // The thought chunk and the tool call are status only, never in finalText.
    expect(events).toContainEqual({ kind: 'status', text: '[copilot: agent_thought_chunk]' });
    expect(events).toContainEqual({ kind: 'status', text: '[copilot: tool_call]' });
    expect(events).toContainEqual({ kind: 'text', text: 'Done copilot turn 1 ' });
    expect(events).toContainEqual({ kind: 'text', text: 'finished.' });
    expect(result.finalText).not.toContain('thinking');
    await current.dispose();
  });

  it('resumes the exact confirmed session id in a fresh session object', async () => {
    const current = session('persisted-copilot-session');
    const result = await current.send('resumed');
    expect(result.status).toBe('completed');
    expect(result.sessionId).toBe('persisted-copilot-session');
    await current.dispose();
  });

  it('fails when the agent does not support session/load', async () => {
    const current = session(undefined, ['NO_LOAD_SESSION']);
    await expect(current.send('first')).rejects.toThrow('does not support session/load');
    await current.dispose();
  });

  it('fails when session/new returns no session id', async () => {
    const current = session(undefined, ['NO_SESSION_ID']);
    await expect(current.send('first')).rejects.toThrow('returned no session id');
    expect(current.pid).toBeUndefined();
    await current.dispose();
  });

  it('does not fold the session/load history replay into the resumed turn', async () => {
    const current = session('persisted-copilot-session', ['LOAD_REPLAY']);
    const result = await current.send('resumed');
    expect(result.status).toBe('completed');
    expect(result.finalText).not.toContain('OLD-HISTORY');
    expect(result.finalText).toContain('finished.');
    await current.dispose();
  });

  it('fails when session/load fails (context lost, no silent fresh session)', async () => {
    const current = session('dead-session', ['LOAD_FAILS']);
    await expect(current.send('resumed')).rejects.toThrow('session not found');
    await current.dispose();
  });

  it('fails when session/load returns a mismatched session id', async () => {
    const current = session('persisted-copilot-session', ['LOAD_MISMATCH']);
    await expect(current.send('resumed')).rejects.toThrow('mismatched session id');
    await current.dispose();
  });

  it('fails on malformed protocol output', async () => {
    const current = session();
    const result = await current.send('TRIGGER_PROTOCOL');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('malformed JSON');
    await current.dispose();
  });

  it('fails on a server error response', async () => {
    const current = session();
    const result = await current.send('TRIGGER_ERROR_RESULT');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('quota exceeded');
    await current.dispose();
  });

  it('fails on a non-end_turn stop reason', async () => {
    const current = session();
    const result = await current.send('TRIGGER_OTHER_STOP');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('max_tokens');
    await current.dispose();
  });

  it('fails when the child crashes', async () => {
    const current = session(undefined, ['TRIGGER_CRASH']);
    const result = await current.send('first');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exited with code 3');
    await current.dispose();
  });

  it('fails promptly when the owned child exits unexpectedly with code zero', async () => {
    const current = session(undefined, ['TRIGGER_CLEAN_EXIT']);
    const result = await current.send('first');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exited with code 0');
    await current.dispose();
  });

  it('answers a permission request with a cancelled outcome', async () => {
    const current = session();
    const statuses: string[] = [];
    const result = await current.send('TRIGGER_PERMISSION', {
      onEvent: (event) => {
        if (event.kind === 'status') statuses.push(event.text);
      },
    });
    expect(result.status).toBe('cancelled');
    expect(statuses).toContain('[copilot: permission request cancelled]');
    await current.dispose();
  });

  it('cancels an in-flight turn via session/cancel and settles on the terminal response', async () => {
    const current = session();
    const controller = new AbortController();
    const pending = current.send('TRIGGER_SLOW', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.status).toBe('cancelled');
    // The app-server stays warm: the next turn runs on the same session.
    const after = await current.send('after interrupt');
    expect(after.status).toBe('completed');
    expect(after.sessionId).toBe('fixture-copilot-session');
    await current.dispose();
  });

  it('aborts before start without a turn', async () => {
    const current = session();
    const controller = new AbortController();
    controller.abort();
    const pending = current.send('first', { signal: controller.signal });
    const result = await pending;
    expect(result.status).toBe('cancelled');
    await current.dispose();
  });

  it('times out and kills the owned child when no terminal response arrives', async () => {
    const current = session(undefined, ['CANCEL_NO_SETTLE'], {
      timeoutMs: 150,
      cancelGraceMs: 100,
    });
    const result = await current.send('TRIGGER_SLOW');
    expect(result.status).toBe('timed_out');
    expect(result.error).toContain('exceeded 150ms timeout');
    await current.dispose();
  });

  it('disposes an active turn and terminates only the owned child', async () => {
    const current = session();
    const pending = current.send('TRIGGER_SLOW');
    await new Promise((r) => setTimeout(r, 50));
    await current.dispose();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(current.state).toBe('disposed');
    await expect(current.send('after dispose')).rejects.toThrow('disposed');
  });

  it('rejects a concurrent send while a turn is active', async () => {
    const current = session();
    const pending = current.send('TRIGGER_SLOW');
    await new Promise((r) => setTimeout(r, 50));
    await expect(current.send('second')).rejects.toThrow('already has an active turn');
    const controller = new AbortController();
    void current.interrupt();
    controller.abort();
    await pending;
    await current.dispose();
  });

  it('reserves the active slot across the cold start (no double session/new)', async () => {
    const current = session();
    const first = current.send('first');
    // The second send must throw even while the first is still cold-starting.
    await expect(current.send('second')).rejects.toThrow('already has an active turn');
    const result = await first;
    expect(result.status).toBe('completed');
    await current.dispose();
  });
});

describe('copilotAcpArgs', () => {
  it('adds --model only when a model is set', () => {
    const fixed = ['--acp', '--stdio', '--no-remote', '--allow-all'];
    expect(copilotAcpArgs({})).toEqual(fixed);
    expect(copilotAcpArgs({ model: 'auto' })).toEqual([...fixed, '--model', 'auto']);
  });
});
