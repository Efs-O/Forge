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
});
