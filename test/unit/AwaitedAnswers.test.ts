import { describe, expect, it } from 'vitest';
import { AwaitedAnswers } from '../../src/agentBus/awaitedAnswers';

describe('AwaitedAnswers', () => {
  it('reports a blocking question only while it waits, whatever the alias case', async () => {
    const answers = new AwaitedAnswers();
    let release!: () => void;
    const waiting = answers.during('Codex', 'fg1', () => new Promise<void>((r) => (release = r)));
    expect(answers.pendingFor('codex')).toBe('fg1');
    expect(answers.pendingFor('claude')).toBeUndefined();
    release();
    await waiting;
    expect(answers.pendingFor('codex')).toBeUndefined();
  });

  it('clears the wait when the answer fails', async () => {
    const answers = new AwaitedAnswers();
    await expect(
      answers.during('claude', 'fg2', () => Promise.reject(new Error('aborted'))),
    ).rejects.toThrow('aborted');
    expect(answers.pendingFor('claude')).toBeUndefined();
  });
});
