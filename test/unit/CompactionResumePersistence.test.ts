import { describe, expect, it } from 'vitest';
import { persistedToRuntime, runtimeToPersisted } from '../../src/sidebar/sessionPersistence';
import { compactionPersistedSchema } from '../../src/sidebar/compactionPersistedSchema';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

describe('persisted compaction resume note', () => {
  it.each([false, true])('repairs stale usage only with no post-cut response (later=%s)', (later) => {
    const conversation: ConversationRuntime = {
      id: 'stale', title: 'Stale', createdAt: 1, updatedAt: 1,
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'old answer' },
        ...(later ? [{ role: 'assistant' as const, content: 'new answer' }] : []),
      ],
      compaction: { summary: 'kept summary', fromIndex: 2 },
      last_input_tokens: 257_057, last_output_tokens: 649,
      input_tokens: 500_000, output_tokens: 2_000,
    };
    const saved = runtimeToPersisted({ conversations: [conversation], history: [] }).conversations[0]!;
    const restored = persistedToRuntime(saved);
    expect(restored.last_input_tokens).toBe(later ? 257_057 : undefined);
    expect(restored.last_output_tokens).toBe(later ? 649 : undefined);
    expect(restored.input_tokens).toBe(500_000);
    expect(restored.output_tokens).toBe(2_000);
    expect(restored.compaction).toEqual(conversation.compaction);
    expect(restored.messages).toEqual(conversation.messages);
  });

  it('round-trips the note and still parses older records without it', () => {
    const resumeNote = { generation: 2, usedTokens: 1_200, maxTokens: 8_192 };
    const conversation: ConversationRuntime = {
      id: 'resume',
      title: 'Resume',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      compaction: { summary: 'summary', fromIndex: 0, resumeNote },
    };
    const session: SidebarRuntime = {
      activeConversationId: conversation.id,
      conversations: [conversation],
      history: [],
    };

    const persisted = runtimeToPersisted(session).conversations[0]!;
    expect(compactionPersistedSchema.parse(persisted.compaction).resumeNote).toEqual(resumeNote);
    expect(persistedToRuntime(persisted).compaction?.resumeNote).toEqual(resumeNote);
    expect(compactionPersistedSchema.parse({ summary: 'legacy', fromIndex: 0 }).resumeNote).toBe(
      undefined,
    );
  });
});
