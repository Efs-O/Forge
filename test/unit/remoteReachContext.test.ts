import { describe, expect, it } from 'vitest';
import { injectTurnContext } from '../../src/sidebar/turnContext';

const user = [{ role: 'user' as const, content: 'run the benchmark overnight' }];

/**
 * The overnight-report failure. An agent driven from Telegram wrote its
 * two-hourly reports as chat text, which only reaches the phone when the turn
 * ends -- so a run that lasted all night delivered nothing until morning.
 * Nothing in the prompt said so, and it is not inferable from the tool list.
 */
describe('remote reach in turn context', () => {
  it('says mid-turn text does not reach a bound chat, and names notify_user', () => {
    const content = String(injectTurnContext(user, { remoteChats: 2 })[0]?.content);
    expect(content).toContain('2 chat(s) bound to this conversation');
    expect(content).toContain('Only your FINAL reply');
    expect(content).toContain('notify_user');
    // The other half of the failure: a blocking question asked while the user
    // sleeps stalls the run until they wake up.
    expect(content).toContain('ask_user');
  });

  it('says nothing at all when no chat is bound', () => {
    // A desktop turn must not pay for this: the remote block is the reason it
    // lives in Layer C instead of the system prompt.
    const content = String(injectTurnContext(user, {})[0]?.content);
    expect(content).not.toContain('bound to this conversation');
    expect(injectTurnContext(user, { remoteChats: 0 })).toEqual(user);
  });

  it('keeps the block stable across the rounds of one turn', () => {
    // Layer C is folded into the last user message every round. A block that
    // re-rendered differently mid-turn would invalidate that turn's own KV
    // cache -- the whole reason this file exists.
    const first = injectTurnContext(user, { remoteChats: 1 });
    const second = injectTurnContext(user, { remoteChats: 1 });
    expect(first).toEqual(second);
  });
});
