import { describe, expect, it } from 'vitest';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';
import { mirrorLiveSessionAnswers } from '../../src/sidebar/liveSessionMirror';

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe('mirrorLiveSessionAnswers', () => {
  it('sends each ask_live_session answer in full as its own narration', () => {
    const events: AgentProgressEvent[] = [];
    const answer = 'x'.repeat(2_000);
    mirrorLiveSessionAnswers(
      'c1',
      [
        call('a', 'ask_live_session', { target: 'codex', subject: 'who verb', question: 'q' }),
        call('b', 'read_file', { path: 'x' }),
      ],
      [
        { role: 'tool', tool_call_id: 'a', content: answer },
        { role: 'tool', tool_call_id: 'b', content: 'file body' },
      ],
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { conversationId: 'c1', kind: 'narration', text: `🔁 Forge ↔ codex · who verb\n\n${answer}` },
    ]);
  });

  it('mirrors a failure too, and tolerates unparseable arguments', () => {
    const events: AgentProgressEvent[] = [];
    mirrorLiveSessionAnswers(
      'c1',
      [{ id: 'a', type: 'function', function: { name: 'ask_live_session', arguments: '{' } }],
      [{ role: 'tool', tool_call_id: 'a', content: 'Could not deliver to codex' }],
      (e) => events.push(e),
    );
    expect(events[0]).toMatchObject({
      text: '🔁 Forge ↔ live session\n\nCould not deliver to codex',
    });
  });
});
