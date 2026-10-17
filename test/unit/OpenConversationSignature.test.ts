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
    value.compaction.memoryKeys = ['retained-key'];
    expect(openConversationSignature(value)).not.toBe(withCompaction);
    const withMemoryKeys = openConversationSignature(value);

    value.last_input_tokens = 120;
    expect(openConversationSignature(value)).not.toBe(withMemoryKeys);
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

  it.each([
    ['id', (value: ConversationRuntime) => (value.id = 'chat-2')],
    ['title', (value: ConversationRuntime) => (value.title = 'Renamed')],
    ['createdAt', (value: ConversationRuntime) => (value.createdAt = 3)],
    ['updatedAt', (value: ConversationRuntime) => (value.updatedAt = 3)],
    [
      'messages',
      (value: ConversationRuntime) => (value.messages[0] = { role: 'assistant', content: 'changed' }),
    ],
    [
      'agentLinks',
      (value: ConversationRuntime) => {
        value.agentLinks = {
          copilot: {
            kind: 'copilot',
            sessionId: 'session-1',
            cwd: 'workspace',
            title: 'Agent',
            linkedAt: 1,
            lastUsedAt: 2,
            origin: 'user-set',
          },
        };
      },
    ],
    ['active_model', (value: ConversationRuntime) => (value.active_model = 'local-model')],
    ['cli_sessions', (value: ConversationRuntime) => (value.cli_sessions = { codex: 'session-1' })],
    [
      'compaction',
      (value: ConversationRuntime) =>
        (value.compaction = { summary: 'summary', fromIndex: 1, generation: 1 }),
    ],
    [
      'plan',
      (value: ConversationRuntime) =>
        (value.plan = { items: [{ text: 'step', status: 'pending' }], updatedAt: 3 }),
    ],
    ['display_diffs', (value: ConversationRuntime) => (value.displayDiffs = [])],
    ['active_time_ms', (value: ConversationRuntime) => (value.active_time_ms = 10)],
    ['active_started_at', (value: ConversationRuntime) => (value.active_started_at = 10)],
    ['input_tokens', (value: ConversationRuntime) => (value.input_tokens = 10)],
    ['output_tokens', (value: ConversationRuntime) => (value.output_tokens = 10)],
    ['last_input_tokens', (value: ConversationRuntime) => (value.last_input_tokens = 10)],
    ['last_output_tokens', (value: ConversationRuntime) => (value.last_output_tokens = 10)],
    ['model_request_count', (value: ConversationRuntime) => (value.model_request_count = 1)],
    ['tool_call_count', (value: ConversationRuntime) => (value.tool_call_count = 1)],
  ] as const)('changes the signature when %s changes', (_field, mutate) => {
    const value = conversation();
    const original = openConversationSignature(value);

    mutate(value);

    expect(openConversationSignature(value)).not.toBe(original);
  });
});
