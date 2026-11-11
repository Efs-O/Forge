import { describe, expect, it } from 'vitest';
import { renderAskQueued, renderAskReplyMessage } from '../../src/agentLinks/askAgentResult';
import type { AskAgentResult } from '../../src/agentLinks/askAgentResult';

function completed(agent: 'claude' | 'codex', live: boolean): AskAgentResult {
  return {
    agent,
    status: 'completed',
    finalText: 'finished',
    sessionTitle: 'Forge session',
    subject: 'Review',
    live,
  };
}

describe('renderAskReplyMessage', () => {
  it('renders the queued ask response exactly', () => {
    expect(renderAskQueued('codex', 'new-id', 'tail-id')).toBe(
      'Asked Codex (exchange new-id); it starts when exchange tail-id finishes. Its reply will arrive as a message in this chat; carry on with the rest of the task.',
    );
  });

  it('identifies a background Claude reply', () => {
    expect(renderAskReplyMessage('ex-1', completed('claude', false))).toBe(
      '**Claude replied** (ask_agent exchange ex-1: Review; a new background Claude session answered, not a session the owner has open)\n\nfinished',
    );
  });

  it('keeps the live Claude reply heading and checkpoint note', () => {
    expect(renderAskReplyMessage('ex-1', completed('claude', true))).toBe(
      '**Claude replied** (ask_agent exchange ex-1: Review)\n\nfinished\n\nEdits this live session makes after its reply are outside this ask’s checkpoint.',
    );
  });

  it('identifies a background Codex reply', () => {
    expect(renderAskReplyMessage('ex-2', completed('codex', false))).toBe(
      '**Codex replied** (ask_agent exchange ex-2: Review; a new background Codex session answered, not a session the owner has open)\n\nfinished',
    );
  });

  it('keeps the live Codex reply heading and checkpoint note', () => {
    expect(renderAskReplyMessage('ex-2', completed('codex', true))).toBe(
      '**Codex replied** (ask_agent exchange ex-2: Review)\n\nfinished\n\nEdits this live session makes after its reply are outside this ask’s checkpoint.',
    );
  });
});
