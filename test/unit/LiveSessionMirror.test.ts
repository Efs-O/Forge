import { describe, expect, it } from 'vitest';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';
import { mirrorLiveSessionAnswers } from '../../src/sidebar/liveSessionMirror';

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe('mirrorLiveSessionAnswers', () => {
  it('mirrors ask, receipt and answer as separate messages', () => {
    const events: AgentProgressEvent[] = [];
    const answer = 'x'.repeat(2_000);
    mirrorLiveSessionAnswers(
      'c1',
      [
        call('a', 'ask_agent', {
          agent: 'codex',
          subject: 'who verb',
          message: 'Inspect this\nthen answer.',
        }),
      ],
      [
        {
          role: 'tool',
          tool_call_id: 'a',
          content: `**Asked Codex (Forge · chat):** who verb\n\n**Codex says:**\n\n${answer}`,
        },
      ],
      (event) => events.push(event),
    );
    expect(events).toEqual([
      {
        conversationId: 'c1',
        kind: 'narration',
        text: '→ Codex (Forge · chat): Inspect this\nthen answer.',
      },
      { conversationId: 'c1', kind: 'narration', text: '✓ Codex received it' },
      { conversationId: 'c1', kind: 'narration', text: `Codex (Forge · chat) says: ${answer}` },
    ]);
  });

  it('reports a failed ask without fabricating a session identity', () => {
    const events: AgentProgressEvent[] = [];
    mirrorLiveSessionAnswers(
      'c1',
      [call('a', 'ask_agent', { agent: 'claude', message: 'Review this' })],
      [{ role: 'tool', tool_call_id: 'a', content: 'Error: Could not deliver to Claude' }],
      (event) => events.push(event),
    );
    expect(events.map((event) => (event.kind === 'narration' ? event.text : ''))).toEqual([
      '→ Claude (Claude session): Review this',
      '✗ Could not deliver to Claude',
    ]);
  });

  it('ignores malformed and unrelated tool calls', () => {
    const events: AgentProgressEvent[] = [];
    mirrorLiveSessionAnswers(
      'c1',
      [
        { id: 'a', type: 'function', function: { name: 'ask_agent', arguments: '{' } },
        call('b', 'read_file', { path: 'x' }),
      ],
      [
        { role: 'tool', tool_call_id: 'a', content: 'refused' },
        { role: 'tool', tool_call_id: 'b', content: 'file body' },
      ],
      (event) => events.push(event),
    );
    expect(events).toEqual([]);
  });

  it('mirrors multiple asks independently and keeps each full reply', () => {
    const events: AgentProgressEvent[] = [];
    mirrorLiveSessionAnswers(
      'c1',
      [
        call('a', 'ask_agent', { agent: 'claude', message: 'Review A' }),
        call('b', 'ask_agent', { agent: 'copilot', message: 'Review B' }),
      ],
      [
        {
          role: 'tool',
          tool_call_id: 'a',
          content: '**Asked Claude (Claude · Review):** Review A\n\n**Claude says:**\n\nFull A',
        },
        {
          role: 'tool',
          tool_call_id: 'b',
          content: '**Asked Copilot (Copilot · Review):** Review B\n\n**Copilot says:**\n\nFull B',
        },
      ],
      (event) => events.push(event),
    );
    expect(events.filter((event) => event.kind === 'narration').map((event) => event.text)).toEqual(
      [
        '→ Claude (Claude · Review): Review A',
        '✓ Claude received it',
        'Claude (Claude · Review) says: Full A',
        '→ Copilot (Copilot · Review): Review B',
        '✓ Copilot received it',
        'Copilot (Copilot · Review) says: Full B',
      ],
    );
  });

  it('mirrors a failed delivery with its reason and skips unrelated tool results', () => {
    const events: AgentProgressEvent[] = [];
    mirrorLiveSessionAnswers(
      'c1',
      [
        call('a', 'ask_agent', { agent: 'codex', message: 'Inspect' }),
        call('b', 'read_file', { path: 'secret' }),
      ],
      [
        { role: 'tool', tool_call_id: 'a', content: 'Error: session not found' },
        { role: 'tool', tool_call_id: 'b', content: 'unrelated body' },
      ],
      (event) => events.push(event),
    );
    expect(events.map((event) => (event.kind === 'narration' ? event.text : ''))).toEqual([
      '→ Codex (Codex session): Inspect',
      '✗ session not found',
    ]);
  });

  it('uses only the tool result and does not mirror assistant reasoning', () => {
    const events: AgentProgressEvent[] = [];
    const answer = 'The result is grounded in the session reply.';
    mirrorLiveSessionAnswers(
      'c1',
      [call('a', 'ask_agent', { agent: 'claude', message: 'Review' })],
      [
        { role: 'assistant', content: 'reasoning must not appear' },
        {
          role: 'tool',
          tool_call_id: 'a',
          content: `**Asked Claude (Claude):** Review\n\n**Claude says:**\n\n${answer}`,
        },
      ],
      (event) => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({ text: `Claude (Claude) says: ${answer}` });
    expect(JSON.stringify(events)).not.toContain('reasoning must not appear');
  });
});
