import { describe, expect, it } from 'vitest';
import { MidTurnTellDrain } from '../../src/agent/MidTurnTellDrain';

describe('MidTurnTellDrain', () => {
  it('settles source claims in order only after the transcript is persisted', async () => {
    const events: string[] = [];
    const drain = new MidTurnTellDrain();

    drain.registerSource('first', async () => ({
      messages: [{ role: 'user', content: 'first tell' }],
      settle: async () => {
        events.push('settle first');
      },
    }));
    drain.registerSource('failed', async () => {
      throw new Error('source unavailable');
    });
    drain.registerSource('last', async () => ({
      messages: [{ role: 'user', content: 'last tell' }],
      settle: async () => {
        events.push('settle last');
      },
    }));

    const result = await drain.drain('conversation');

    expect(result.messages).toEqual([
      { role: 'user', content: 'first tell' },
      { role: 'user', content: 'last tell' },
    ]);
    expect(events).toEqual([]);

    events.push('persist transcript');
    await expect(result.settle!()).rejects.toThrow('source unavailable');
    expect(events).toEqual(['persist transcript', 'settle first', 'settle last']);
  });

  it('continues settling later sources and reports the first settlement failure', async () => {
    const events: string[] = [];
    const firstFailure = new Error('first settlement failed');
    const drain = new MidTurnTellDrain();

    drain.registerSource('first', async () => ({
      messages: [],
      settle: async () => {
        events.push('settle first');
        throw firstFailure;
      },
    }));
    drain.registerSource('last', async () => ({
      messages: [],
      settle: async () => {
        events.push('settle last');
        throw new Error('later settlement failed');
      },
    }));

    const result = await drain.drain('conversation');

    await expect(result.settle!()).rejects.toBe(firstFailure);
    expect(events).toEqual(['settle first', 'settle last']);
  });

  it('returns plain messages when no source needs to settle', async () => {
    const drain = new MidTurnTellDrain();
    drain.registerSource('sidebar', async () => ({
      messages: [{ role: 'user', content: 'tell' }],
    }));

    await expect(drain.drain('conversation')).resolves.toEqual({
      messages: [{ role: 'user', content: 'tell' }],
    });
  });
});
