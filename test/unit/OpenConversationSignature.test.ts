import { describe, expect, it } from 'vitest';
import { conversationPersistedSchema, type ConversationRuntime } from '../../src/sidebar/sessionTypes';
import {
  openConversationSignature,
  openConversationSignatureFields,
  openConversationUpdatedAtOnlyFields,
} from '../../src/sidebar/openConversationsPersistence';

function conversation(): ConversationRuntime {
  return {
    id: 'chat-1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'assistant', content: 'answer' }],
  };
}

describe('open conversation signature', () => {
  it('classifies every persisted conversation field', () => {
    const schemaFields = Object.keys(conversationPersistedSchema.shape).sort();
    const signatureFields = openConversationSignatureFields();
    const updatedAtOnlyFields = openConversationUpdatedAtOnlyFields();
    const classified = [...signatureFields, ...updatedAtOnlyFields];

    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.sort()).toEqual(schemaFields);
  });

  it('detects in-place model, compaction, usage and last-message changes', () => {
    const value = conversation();
    const original = openConversationSignature(value);

    value.active_model = 'local-model';
    expect(openConversationSignature(value)).not.toBe(original);
    const withModel = openConversationSignature(value);

    value.compaction = { summary: 'summary', fromIndex: 1, generation: 1 };
    expect(openConversationSignature(value)).not.toBe(withModel);
    const withCompaction = openConversationSignature(value);

    value.last_input_tokens = 120;
    expect(openConversationSignature(value)).not.toBe(withCompaction);
    const withUsage = openConversationSignature(value);

    value.messages[0] = { role: 'assistant', content: 'a longer answer' };
    expect(openConversationSignature(value)).not.toBe(withUsage);
    const withContent = openConversationSignature(value);

    value.messages[0] = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'tool', arguments: '{}' } },
      ],
    };
    expect(openConversationSignature(value)).not.toBe(withContent);
  });
});
