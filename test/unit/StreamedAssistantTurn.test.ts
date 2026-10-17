import { describe, expect, it } from 'vitest';
import { StreamedAssistantTurn } from '../../src/agent/StreamedAssistantTurn';
import type { ChatMessage } from '../../src/llm/types';

describe('StreamedAssistantTurn', () => {
  it('stamps reasoning and answer rows with the assistant turn creation time', () => {
    const messages: ChatMessage[] = [];
    const turn = new StreamedAssistantTurn(messages, 1_802_000_000_000);
    turn.appendReasoning('Thinking');
    turn.completeAnswer('Answer', 'Thinking');

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: 'Answer',
        reasoning: 'Thinking',
        createdAt: 1_802_000_000_000,
      },
    ]);
  });
});
