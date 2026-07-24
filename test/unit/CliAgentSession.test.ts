import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CliAgentSession } from '../../src/agents/CliAgentSession';

const claudeFixture = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs');

function createSession(confirmedSessionId?: string): CliAgentSession {
  return new CliAgentSession({
    executable: process.execPath,
    argsPrefix: [claudeFixture],
    access: 'full',
    cwd: process.cwd(),
    ...(confirmedSessionId ? { confirmedSessionId } : {}),
  });
}

describe('CliAgentSession', () => {
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
