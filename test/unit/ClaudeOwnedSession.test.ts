import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ClaudeOwnedSession } from '../../src/agents/ClaudeOwnedSession';

const fixture = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs');

function session(confirmedSessionId?: string): ClaudeOwnedSession {
  return new ClaudeOwnedSession({
    executable: process.execPath,
    argsPrefix: [fixture],
    cwd: process.cwd(),
    ...(confirmedSessionId ? { confirmedSessionId } : {}),
  });
}

describe('ClaudeOwnedSession (P4: persistent stdio Claude session)', () => {
  it('keeps the session warm across two turns and reports the session id', async () => {
    const current = session();
    const first = await current.send('first');
    const second = await current.send('second');
    expect(first.finalText).toBe('Done claude turn 1 finished.');
    expect(second.finalText).toBe('Done claude turn 2 finished.');
    // The session id comes from the init message and is echoed per result.
    expect(first.sessionId).toBe('fixture-session-id');
    expect(second.sessionId).toBe('fixture-session-id');
    expect(current.confirmedSessionId).toBe('fixture-session-id');
    await current.dispose();
  });

  it('resumes the exact persisted session id (M3: warm survives a restart)', async () => {
    const current = session('persisted-claude-id');
    const result = await current.send('resumed');
    expect(result.sessionId).toBe('persisted-claude-id');
    expect(current.confirmedSessionId).toBe('persisted-claude-id');
    await current.dispose();
  });

  it('fails the turn on malformed protocol output and stays disposed-safe', async () => {
    const current = session();
    const result = await current.send('TRIGGER_PROTOCOL');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('malformed JSON');
    await current.dispose();
  });

  it('throws when a turn is already active (M5: one turn at a time)', async () => {
    const current = session();
    const pending = current.send('TRIGGER_SLOW'); // holds the turn open
    await new Promise((r) => setTimeout(r, 50));
    // send() is async: a second turn is a rejected promise, not a sync throw.
    await expect(current.send('second')).rejects.toThrow(/active turn/);
    const result = await current.dispose().then(() => pending);
    // The in-flight turn resolves as failed once the session is disposed.
    expect(result.status).toBe('failed');
  });

  it('exposes the child pid while running (ownership records)', async () => {
    const current = session();
    await current.send('hello');
    expect(typeof current.pid).toBe('number');
    await current.dispose();
  });
});
